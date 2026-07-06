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
import { db } from "@/lib/firebase";

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
}

export interface PrivatePlaylistSongEntry {
  songId: string;
  addedAt: string | null;
}

const COLLECTION = "privatePlaylists";

const assertDb = () => {
  if (!db) throw new Error("Firebase no esta configurado.");
  return db;
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
  };
};

export async function listOwnPrivatePlaylists(ownerId: string) {
  const ref = collection(assertDb(), COLLECTION);
  const q = query(ref, where("ownerId", "==", ownerId));
  const snap = await getDocs(q);
  return snap.docs.map((item) => mapPrivatePlaylist(item.id, item.data()));
}

export async function createPrivatePlaylist(input: {
  ownerId: string;
  ownerEmail?: string | null;
  nombre: string;
  iconUrl?: string | null;
  visibility?: PrivatePlaylistVisibility;
}) {
  const ref = await addDoc(collection(assertDb(), COLLECTION), {
    ownerId: input.ownerId,
    ownerEmail: input.ownerEmail || null,
    nombre: input.nombre,
    iconUrl: input.iconUrl || null,
    visibility: input.visibility || "private",
    songIds: [],
    songEntries: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return ref.id;
}

export async function updatePrivatePlaylist(id: string, input: {
  nombre?: string;
  iconUrl?: string | null;
  visibility?: PrivatePlaylistVisibility;
}) {
  await updateDoc(doc(assertDb(), COLLECTION, id), {
    ...input,
    updatedAt: serverTimestamp(),
  });
}

export async function deletePrivatePlaylist(id: string) {
  await deleteDoc(doc(assertDb(), COLLECTION, id));
}

export async function getPrivatePlaylist(id: string) {
  const snap = await getDoc(doc(assertDb(), COLLECTION, id));
  if (!snap.exists()) return null;
  return mapPrivatePlaylist(snap.id, snap.data());
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

  if (!validRequestedSongs) throw new Error("La reordenación debe contener canciones de la playlist.");

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
}
