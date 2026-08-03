"use client";

import { auth } from "@/lib/firebase";
import { getListenedSongIds, getRecommendationSeed } from "@/lib/listeningHistory";
import { MUSIC_API_URL, type ApiSong } from "@/lib/radioApi";
import type { AlbumCard } from "@/lib/albums";

export interface WeeklyRecommendation {
  id: string;
  name: string;
  songs: ApiSong[];
  themeNames: string[];
  shareToken: string;
}

export interface HomeRecommendations {
  dayKey: string;
  weekKey: string;
  dailySong: ApiSong | null;
  weeklyPlaylists: WeeklyRecommendation[];
  weeklyAlbum: AlbumCard | null;
}

interface CachedRecommendations {
  dailyChosenAt: number;
  weeklyChosenAt: number;
  data: HomeRecommendations;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const cacheKey = () => `farreo-home-recommendations-v1:${auth?.currentUser?.uid || "guest"}`;

function readCache(): CachedRecommendations | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(cacheKey()) || "null") as CachedRecommendations | null;
    return parsed?.data ? parsed : null;
  } catch {
    return null;
  }
}

export async function getHomeRecommendations(force = false): Promise<HomeRecommendations> {
  const cached = readCache();
  const now = Date.now();
  if (!force && cached && now - cached.dailyChosenAt < DAY_MS) return cached.data;

  const response = await fetch(`${MUSIC_API_URL}/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientSeed: getRecommendationSeed(),
      heardSongIds: getListenedSongIds(),
    }),
  });
  const next = await response.json().catch(() => ({})) as HomeRecommendations & { error?: string };
  if (!response.ok) throw new Error(next.error || "No se pudieron preparar las recomendaciones.");

  const keepWeekly = cached && now - cached.weeklyChosenAt < WEEK_MS;
  const data = keepWeekly ? {
    ...next,
    weekKey: cached.data.weekKey,
    weeklyPlaylists: cached.data.weeklyPlaylists,
    weeklyAlbum: cached.data.weeklyAlbum,
  } : next;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(cacheKey(), JSON.stringify({
      dailyChosenAt: now,
      weeklyChosenAt: keepWeekly ? cached.weeklyChosenAt : now,
      data,
    } satisfies CachedRecommendations));
  }
  return data;
}

export async function getSharedRecommendation(token: string) {
  const response = await fetch(`${MUSIC_API_URL}/recommendations/shared/${encodeURIComponent(token)}`);
  const data = await response.json().catch(() => ({})) as WeeklyRecommendation & { error?: string };
  if (!response.ok) throw new Error(data.error || "No se pudo abrir la recomendacion.");
  return data;
}

export const recommendationHref = (token: string) => `/recommendation/${encodeURIComponent(token)}`;

