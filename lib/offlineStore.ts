"use client";

// Almacen local para el modo sin conexion: guarda el audio (Blob) de cada
// cancion y las playlists descargadas en IndexedDB, dentro del propio
// dispositivo. No depende del servidor de musica ni de Firebase.

import { getMediaUrl, type ApiSong } from "@/lib/radioApi";
import type { getFarreoNativeAudio } from "@/lib/nativeAudio";

type NativePlugin = NonNullable<ReturnType<typeof getFarreoNativeAudio>>;

// En la APK el audio se guarda como archivo de la app (lo reproduce Media3,
// tambien con la pantalla bloqueada). En el navegador se guarda en IndexedDB.
let nativeBackend: NativePlugin | null = null;
export function setNativeOfflineBackend(plugin: NativePlugin | null) {
  nativeBackend = plugin;
}

const DB_NAME = "farreo-offline";
const DB_VERSION = 1;
const SONGS = "songs";
const PLAYLISTS = "playlists";

export interface OfflineSong {
  id: string;
  name: string;
  variantes: string[];
  duration: number | null;
  audio: Blob;
  icon: Blob | null;
  /** file:// del audio guardado por la APK (si existe, `audio` va vacio). */
  nativeUri?: string | null;
  size: number;
  savedAt: number;
}

export type OfflineSongMeta = Omit<OfflineSong, "audio" | "icon"> & { hasIcon: boolean };

export interface OfflinePlaylist {
  id: string;
  nombre: string;
  /** "private" = playlist privada del usuario (Firestore); por defecto global. */
  kind?: "global" | "private";
  songIds: string[];
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Este navegador no permite guardar musica sin conexion."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SONGS)) db.createObjectStore(SONGS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PLAYLISTS)) db.createObjectStore(PLAYLISTS, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error("No se pudo abrir el almacen local."));
    };
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || new Error("Operacion cancelada (¿sin espacio?)."));
  }));
}

/** Lista las canciones guardadas sin cargar el audio en memoria. */
export function listOfflineSongs(): Promise<OfflineSongMeta[]> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const out: OfflineSongMeta[] = [];
    const tx = db.transaction(SONGS, "readonly");
    const req = tx.objectStore(SONGS).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const { audio: _audio, icon, ...meta } = cursor.value as OfflineSong;
      void _audio;
      out.push({ ...meta, hasIcon: Boolean(icon) });
      cursor.continue();
    };
    tx.oncomplete = () => resolve(out.sort((a, b) => a.name.localeCompare(b.name, "es")));
    tx.onerror = () => reject(tx.error);
  }));
}

export function getOfflineSong(id: string): Promise<OfflineSong | undefined> {
  return run<OfflineSong | undefined>(SONGS, "readonly", (s) => s.get(id));
}

export function listOfflinePlaylists(): Promise<OfflinePlaylist[]> {
  return run<OfflinePlaylist[]>(PLAYLISTS, "readonly", (s) => s.getAll()).then((list) =>
    list.sort((a, b) => a.nombre.localeCompare(b.nombre, "es")),
  );
}

export function saveOfflinePlaylist(playlist: OfflinePlaylist) {
  return run(PLAYLISTS, "readwrite", (s) => s.put(playlist));
}

export async function deleteOfflinePlaylist(id: string, removeOrphanSongs = true) {
  const playlists = await listOfflinePlaylists();
  const target = playlists.find((p) => p.id === id);
  await run(PLAYLISTS, "readwrite", (s) => s.delete(id));
  if (!target || !removeOrphanSongs) return;
  const stillUsed = new Set(playlists.filter((p) => p.id !== id).flatMap((p) => p.songIds));
  for (const songId of target.songIds) {
    if (!stillUsed.has(songId)) await removeSongRecord(songId);
  }
}

async function removeSongRecord(id: string) {
  const record = await getOfflineSong(id);
  if (record?.nativeUri && nativeBackend?.deleteOfflineSong) {
    await nativeBackend.deleteOfflineSong({ id }).catch(() => undefined);
  }
  await run(SONGS, "readwrite", (s) => s.delete(id));
}

export async function deleteOfflineSong(id: string) {
  await removeSongRecord(id);
  const playlists = await listOfflinePlaylists();
  for (const pl of playlists) {
    if (pl.songIds.includes(id)) {
      await saveOfflinePlaylist({ ...pl, songIds: pl.songIds.filter((s) => s !== id) });
    }
  }
}

export async function hasOfflineSong(id: string) {
  const key = await run<IDBValidKey | undefined>(SONGS, "readonly", (s) => s.getKey(id));
  return key !== undefined;
}

/** Las canciones de YouTube se reproducen en streaming y no se pueden guardar. */
export function canDownloadSong(song: Pick<ApiSong, "id" | "url">) {
  return Boolean(song.url) && !song.id.startsWith("youtube:");
}

/** Descarga el MP3 (y la portada si hay) y lo guarda en el dispositivo. */
export async function downloadSong(song: ApiSong, signal?: AbortSignal): Promise<void> {
  if (!canDownloadSong(song)) throw new Error("Esta cancion no se puede descargar.");
  if (await hasOfflineSong(song.id)) return;

  let audio: Blob;
  let nativeUri: string | null = null;
  let nativeSize = 0;
  if (nativeBackend?.saveOfflineSong) {
    const file = await nativeBackend.saveOfflineSong({ id: song.id, url: getMediaUrl(song.url) });
    if (signal?.aborted) throw new DOMException("Cancelada", "AbortError");
    audio = new Blob([]);
    nativeUri = file.uri;
    nativeSize = file.size;
  } else {
    const res = await fetch(getMediaUrl(song.url), { signal });
    if (!res.ok) throw new Error(`Error ${res.status} descargando "${song.name}".`);
    audio = await res.blob();
  }

  let icon: Blob | null = null;
  if (song.iconUrl) {
    try {
      const iconRes = await fetch(getMediaUrl(song.iconUrl), { signal });
      if (iconRes.ok) icon = await iconRes.blob();
    } catch {
      icon = null;
    }
  }

  const record: OfflineSong = {
    id: song.id,
    name: song.name,
    variantes: song.variantes || [],
    duration: song.duration ?? null,
    audio,
    icon,
    nativeUri,
    size: (nativeSize || audio.size) + (icon?.size || 0),
    savedAt: Date.now(),
  };
  await run(SONGS, "readwrite", (s) => s.put(record));
}

/** Pide al navegador que no borre la musica guardada cuando falte espacio. */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function getStorageEstimate() {
  try {
    const est = await navigator.storage?.estimate?.();
    return { usage: est?.usage ?? 0, quota: est?.quota ?? 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

export function formatBytes(bytes: number) {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
