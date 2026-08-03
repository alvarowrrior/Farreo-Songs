"use client";

import { MUSIC_API_URL, type ApiSong } from "@/lib/radioApi";

export async function listSimilarSongs(songId: string, limit = 12) {
  const response = await fetch(`${MUSIC_API_URL}/songs/${encodeURIComponent(songId)}/similar?limit=${limit}`);
  const data = await response.json().catch(() => ([])) as ApiSong[] & { error?: string };
  if (!response.ok) throw new Error(data.error || "No se pudieron cargar canciones similares.");
  return data;
}
