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
  dailySongUnheard: boolean;
  weeklyPlaylists: WeeklyRecommendation[];
  weeklyAlbum: AlbumCard | null;
}

interface CachedRecommendations {
  dailyChosenAt: number;
  weeklyChosenAt: number;
  data: HomeRecommendations;
}

// v2 invalida las selecciones antiguas, que podian superar el nuevo limite
// semanal de 16 canciones.
const cacheKey = () => `farreo-home-recommendations-v2:${auth?.currentUser?.uid || "guest"}`;
const revealKey = (dayKey: string, songId: string) => `farreo-daily-reveal-v1:${auth?.currentUser?.uid || "guest"}:${dayKey}:${songId}`;
const volatileReveals = new Set<string>();

const localDateKey = (date: Date) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, "0"),
  String(date.getDate()).padStart(2, "0"),
].join("-");

const currentRecommendationKeys = (now = new Date()) => {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return { dayKey: localDateKey(now), weekKey: localDateKey(monday) };
};

export function millisecondsUntilNextRecommendationDay(now = new Date()) {
  const next = new Date(now);
  next.setHours(24, 0, 0, 750);
  return Math.max(1000, next.getTime() - now.getTime());
}

export function isDailyRecommendationRevealed(dayKey: string, songId: string) {
  if (typeof window === "undefined") return false;
  const key = revealKey(dayKey, songId);
  if (volatileReveals.has(key)) return true;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function markDailyRecommendationRevealed(dayKey: string, songId: string) {
  if (typeof window === "undefined") return;
  const key = revealKey(dayKey, songId);
  volatileReveals.add(key);
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // La animacion sigue funcionando aunque el navegador no pueda recordar
    // localmente el descubrimiento.
  }
}

function readCache(): CachedRecommendations | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(cacheKey()) || "null") as CachedRecommendations | null;
    return parsed?.data ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeRecommendations(data: HomeRecommendations): HomeRecommendations {
  return {
    ...data,
    weeklyPlaylists: (data.weeklyPlaylists || []).map((playlist) => ({
      ...playlist,
      songs: (playlist.songs || []).slice(0, 16),
    })),
  };
}

export async function getHomeRecommendations(force = false): Promise<HomeRecommendations> {
  const cached = readCache();
  const now = Date.now();
  const keys = currentRecommendationKeys();
  if (!force && cached && cached.data.dayKey === keys.dayKey && cached.data.weekKey === keys.weekKey) {
    return normalizeRecommendations(cached.data);
  }

  const response = await fetch(`${MUSIC_API_URL}/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientSeed: getRecommendationSeed(),
      heardSongIds: getListenedSongIds(),
      dayKey: keys.dayKey,
      weekKey: keys.weekKey,
    }),
  });
  const next = await response.json().catch(() => ({})) as HomeRecommendations & { error?: string };
  if (!response.ok) throw new Error(next.error || "No se pudieron preparar las recomendaciones.");

  const keepWeekly = cached && cached.data.weekKey === keys.weekKey;
  const data = normalizeRecommendations(keepWeekly ? {
    ...next,
    weekKey: cached.data.weekKey,
    weeklyPlaylists: cached.data.weeklyPlaylists,
    weeklyAlbum: cached.data.weeklyAlbum,
  } : next);
  if (typeof window !== "undefined") {
    const key = cacheKey();
    const serialized = JSON.stringify({
      dailyChosenAt: now,
      weeklyChosenAt: keepWeekly ? cached.weeklyChosenAt : now,
      data,
    } satisfies CachedRecommendations);
    try {
      window.localStorage.setItem(key, serialized);
    } catch {
      // Las cuentas usadas anteriormente pueden acumular caches distintas.
      // Son datos regenerables: retiramos las antiguas y reintentamos, pero
      // nunca convertimos un fallo de cache en un fallo de recomendaciones.
      try {
        const staleKeys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
          .filter((item): item is string => Boolean(item?.startsWith("farreo-home-recommendations-") && item !== key));
        staleKeys.forEach(item => window.localStorage.removeItem(item));
        window.localStorage.setItem(key, serialized);
      } catch {
        // Los datos recibidos se devuelven igualmente y se muestran en pantalla.
      }
    }
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
