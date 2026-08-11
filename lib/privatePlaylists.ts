import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { MUSIC_API_URL } from "@/lib/radioApi";

export type PrivatePlaylistVisibility = "private" | "public";

export interface PrivatePlaylist {
  id: string;
  ownerId: string;
  ownerEmail?: string | null;
  nombre: string;
  iconUrl?: string | null;
  visibility: PrivatePlaylistVisibility;
  songIds: string[];
  songEntries: PrivatePlaylistSongEntry[];
  createdAt?: string | null;
  lastOpenedAt?: string | null;
}

export interface PrivatePlaylistSongEntry {
  songId: string;
  addedAt: string | null;
}

const COLLECTION = "privatePlaylists";
const LIST_CACHE_TTL_MS = 60_000;
const DOC_CACHE_TTL_MS = 30_000;
const PRIVATE_ICON_MAX_BYTES = 2 * 1024 * 1024;
const LEGACY_DATA_URL_PREFIX = "data:image/";

const listCache = new Map<string, { expiresAt: number; playlists: PrivatePlaylist[] }>();
const listPending = new Map<string, Promise<PrivatePlaylist[]>>();
const docCache = new Map<string, { expiresAt: number; playlist: PrivatePlaylist }>();
const legacyMigrationPending = new Map<string, Promise<PrivatePlaylist>>();

const assertDb = () => {
  if (!db) throw new Error("Firebase no esta configurado.");
  return db;
};

const timestampToIso = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;

  const timestamp = value as { seconds?: unknown; toDate?: () => Date };
  if (typeof timestamp.toDate === "function") return timestamp.toDate().toISOString();
  if (typeof timestamp.seconds === "number") return new Date(timestamp.seconds * 1000).toISOString();
  return null;
};

const normalizeSongEntries = (data: Record<string, unknown>): PrivatePlaylistSongEntry[] => {
  if (Array.isArray(data.songEntries)) {
    return data.songEntries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const value = entry as Record<string, unknown>;
        const songId = typeof value.songId === "string" ? value.songId : "";
        if (!songId) return null;
        return {
          songId,
          addedAt: typeof value.addedAt === "string" ? value.addedAt : null,
        };
      })
      .filter((entry): entry is PrivatePlaylistSongEntry => Boolean(entry));
  }

  return Array.isArray(data.songIds)
    ? data.songIds.map((songId) => ({ songId: String(songId), addedAt: null }))
    : [];
};

const mapPrivatePlaylist = (id: string, data: Record<string, unknown>): PrivatePlaylist => {
  const songEntries = normalizeSongEntries(data);

  return {
    id,
    ownerId: String(data.ownerId || ""),
    ownerEmail: typeof data.ownerEmail === "string" ? data.ownerEmail : null,
    nombre: String(data.nombre || "Playlist sin nombre"),
    iconUrl: typeof data.iconUrl === "string" ? data.iconUrl : null,
    visibility: data.visibility === "public" ? "public" : "private",
    songIds: songEntries.map((entry) => entry.songId),
    songEntries,
    createdAt: timestampToIso(data.createdAt),
    lastOpenedAt: timestampToIso(data.lastOpenedAt),
  };
};

const invalidatePlaylistCaches = () => {
  listCache.clear();
  listPending.clear();
  docCache.clear();
};

const rememberPlaylist = (playlist: PrivatePlaylist) => {
  docCache.set(playlist.id, { expiresAt: Date.now() + DOC_CACHE_TTL_MS, playlist });
  return playlist;
};

const isLegacyEmbeddedIcon = (value?: string | null) => Boolean(value?.startsWith(LEGACY_DATA_URL_PREFIX));
const isManagedPrivateIcon = (value?: string | null) => Boolean(value?.startsWith("/private-playlist-icons/"));

function dataUrlToBlob(dataUrl: string) {
  const [header, payload] = dataUrl.split(",", 2);
  if (!header || !payload) throw new Error("Icono de playlist no valido.");
  const mime = header.match(/^data:([^;]+);base64$/i)?.[1];
  if (!mime?.startsWith("image/")) throw new Error("El icono de playlist debe ser una imagen.");

  const binary = window.atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

async function privateIconRequest(playlistId: string, init: RequestInit) {
  const user = auth?.currentUser;
  if (!user) throw new Error("Inicia sesion para gestionar el icono de la playlist.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${await user.getIdToken()}`);
  const response = await fetch(`${MUSIC_API_URL}/private-playlists/${encodeURIComponent(playlistId)}/icon`, {
    ...init,
    headers,
  });
  const data = await response.json().catch(() => ({})) as { iconUrl?: string | null; error?: string };
  if (!response.ok) throw new Error(data.error || "No se pudo guardar el icono de la playlist.");
  return data.iconUrl ?? null;
}

async function uploadPrivatePlaylistIcon(playlistId: string, dataUrl: string) {
  if (typeof window === "undefined") throw new Error("La subida del icono solo esta disponible en el cliente.");
  const blob = dataUrlToBlob(dataUrl);
  if (blob.size > PRIVATE_ICON_MAX_BYTES) {
    throw new Error("El icono de playlist no puede superar 2 MB.");
  }

  const form = new FormData();
  form.append("icon", blob, "playlist-icon");
  return privateIconRequest(playlistId, { method: "POST", body: form });
}

async function removePrivatePlaylistIcon(playlistId: string) {
  return privateIconRequest(playlistId, { method: "DELETE" });
}

async function migrateLegacyPrivatePlaylistIcon(playlist: PrivatePlaylist): Promise<PrivatePlaylist> {
  if (!isLegacyEmbeddedIcon(playlist.iconUrl) || typeof window === "undefined") return playlist;
  if (!auth?.currentUser || auth.currentUser.uid !== playlist.ownerId) return playlist;

  const pending = legacyMigrationPending.get(playlist.id);
  if (pending) return pending;

  const migration = uploadPrivatePlaylistIcon(playlist.id, playlist.iconUrl!)
    .then((iconUrl) => ({ ...playlist, iconUrl }))
    .catch(() => playlist)
    .finally(() => legacyMigrationPending.delete(playlist.id));
  legacyMigrationPending.set(playlist.id, migration);
  return migration;
}

export async function listOwnPrivatePlaylists(ownerId: string) {
  const cached = listCache.get(ownerId);
  if (cached && cached.expiresAt > Date.now()) return cached.playlists;

  const existing = listPending.get(ownerId);
  if (existing) return existing;

  const request = (async () => {
    const ref = collection(assertDb(), COLLECTION);
    const q = query(ref, where("ownerId", "==", ownerId));
    const snap = await getDocs(q);
    const raw = snap.docs.map((item) => mapPrivatePlaylist(item.id, item.data()));
    const playlists = await Promise.all(raw.map(migrateLegacyPrivatePlaylistIcon));
    playlists.forEach(rememberPlaylist);
    listCache.set(ownerId, { expiresAt: Date.now() + LIST_CACHE_TTL_MS, playlists });
    return playlists;
  })().finally(() => listPending.delete(ownerId));

  listPending.set(ownerId, request);
  return request;
}

export async function createPrivatePlaylist(input: {
  ownerId: string;
  ownerEmail?: string | null;
  nombre: string;
  iconUrl?: string | null;
  visibility?: PrivatePlaylistVisibility;
}) {
  const embeddedIcon = isLegacyEmbeddedIcon(input.iconUrl) ? input.iconUrl! : null;
  const ref = await addDoc(collection(assertDb(), COLLECTION), {
    ownerId: input.ownerId,
    ownerEmail: input.ownerEmail || null,
    nombre: input.nombre,
    // Never put Base64 image data inside Firestore. The backend stores the
    // actual image and Firestore only keeps its short media URL.
    iconUrl: embeddedIcon ? null : input.iconUrl || null,
    visibility: input.visibility || "private",
    songIds: [],
    songEntries: [],
    createdAt: serverTimestamp(),
    lastOpenedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  if (embeddedIcon) {
    try {
      await uploadPrivatePlaylistIcon(ref.id, embeddedIcon);
    } catch (error) {
      // Do not leave a half-created playlist behind if the Linux media upload
      // fails (for example while the backend is being updated).
      await deleteDoc(ref).catch(() => undefined);
      invalidatePlaylistCaches();
      throw error;
    }
  }
  invalidatePlaylistCaches();
  return ref.id;
}

export async function updatePrivatePlaylist(id: string, input: {
  nombre?: string;
  iconUrl?: string | null;
  visibility?: PrivatePlaylistVisibility;
}) {
  const update: Record<string, unknown> = {
    ...(input.nombre !== undefined ? { nombre: input.nombre } : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    updatedAt: serverTimestamp(),
  };

  if (input.iconUrl !== undefined) {
    if (isLegacyEmbeddedIcon(input.iconUrl)) {
      update.iconUrl = await uploadPrivatePlaylistIcon(id, input.iconUrl!);
    } else if (input.iconUrl === null) {
      await removePrivatePlaylistIcon(id).catch(() => null);
      update.iconUrl = null;
    } else {
      update.iconUrl = input.iconUrl;
    }
  }

  await updateDoc(doc(assertDb(), COLLECTION, id), update);
  invalidatePlaylistCaches();
}

export async function deletePrivatePlaylist(id: string) {
  const cached = docCache.get(id)?.playlist;
  if (cached && isManagedPrivateIcon(cached.iconUrl)) {
    await removePrivatePlaylistIcon(id).catch(() => null);
  } else {
    // The backend verifies ownership, so it is safe to make this best-effort
    // even when this browser did not have the playlist cached.
    await removePrivatePlaylistIcon(id).catch(() => null);
  }
  await deleteDoc(doc(assertDb(), COLLECTION, id));
  invalidatePlaylistCaches();
}

export async function touchPrivatePlaylist(id: string) {
  await updateDoc(doc(assertDb(), COLLECTION, id), {
    lastOpenedAt: serverTimestamp(),
  });
  invalidatePlaylistCaches();
}

export async function getPrivatePlaylist(id: string) {
  const cached = docCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.playlist;

  const snap = await getDoc(doc(assertDb(), COLLECTION, id));
  if (!snap.exists()) return null;
  const playlist = await migrateLegacyPrivatePlaylistIcon(mapPrivatePlaylist(snap.id, snap.data()));
  return rememberPlaylist(playlist);
}

export async function addSongToPrivatePlaylist(id: string, songId: string) {
  const playlist = await getPrivatePlaylist(id);
  if (!playlist) throw new Error("Playlist no encontrada.");
  if (playlist.songIds.includes(songId)) return;

  const songEntries = [...playlist.songEntries, { songId, addedAt: new Date().toISOString() }];
  await updateDoc(doc(assertDb(), COLLECTION, id), {
    songIds: songEntries.map((entry) => entry.songId),
    songEntries,
    updatedAt: serverTimestamp(),
  });
  invalidatePlaylistCaches();
}

export async function removeSongFromPrivatePlaylist(id: string, songId: string) {
  const playlist = await getPrivatePlaylist(id);
  if (!playlist) throw new Error("Playlist no encontrada.");

  const songEntries = playlist.songEntries.filter((entry) => entry.songId !== songId);
  await updateDoc(doc(assertDb(), COLLECTION, id), {
    songIds: songEntries.map((entry) => entry.songId),
    songEntries,
    updatedAt: serverTimestamp(),
  });
  invalidatePlaylistCaches();
}

export async function reorderPrivatePlaylistSongs(id: string, songIds: string[]) {
  const playlist = await getPrivatePlaylist(id);
  if (!playlist) throw new Error("Playlist no encontrada.");

  const availableCounts = new Map<string, number>();
  playlist.songEntries.forEach((entry) => {
    availableCounts.set(entry.songId, (availableCounts.get(entry.songId) || 0) + 1);
  });

  const requestedCounts = new Map<string, number>();
  songIds.forEach((songId) => {
    requestedCounts.set(songId, (requestedCounts.get(songId) || 0) + 1);
  });

  const validRequestedSongs = songIds.every((songId) =>
    (requestedCounts.get(songId) || 0) <= (availableCounts.get(songId) || 0)
  );

  if (!validRequestedSongs) throw new Error("La reordenacion debe contener canciones de la playlist.");

  const remainingEntries = [...playlist.songEntries];
  const takeEntry = (songId: string) => {
    const index = remainingEntries.findIndex((entry) => entry.songId === songId);
    if (index === -1) return { songId, addedAt: null };
    const [entry] = remainingEntries.splice(index, 1);
    return entry;
  };
  const songEntries = [
    ...songIds.map(takeEntry),
    ...remainingEntries,
  ];
  await updateDoc(doc(assertDb(), COLLECTION, id), {
    songIds: songEntries.map((entry) => entry.songId),
    songEntries,
    updatedAt: serverTimestamp(),
  });
  invalidatePlaylistCaches();
}
