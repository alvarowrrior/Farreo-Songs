"use client";

import { MUSIC_API_URL, type ApiSong } from "@/lib/radioApi";

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; songs: ApiSong[] }>();
const pending = new Map<string, Promise<ApiSong[]>>();

export async function listSimilarSongs(songId: string, limit = 12) {
  const key = `${songId}:${limit}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.songs;

  const existing = pending.get(key);
  if (existing) return existing;

  const request = (async () => {
    const response = await fetch(`${MUSIC_API_URL}/songs/${encodeURIComponent(songId)}/similar?limit=${limit}`);
    const data = await response.json().catch(() => ([])) as ApiSong[] & { error?: string };
    if (!response.ok) throw new Error(data.error || "No se pudieron cargar canciones similares.");
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, songs: data });
    return data;
  })().finally(() => pending.delete(key));

  pending.set(key, request);
  return request;
}
