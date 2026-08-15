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
  weeklySnapshot?: {
    persisted: boolean;
    createdAt?: string | null;
    scope?: "public" | "admin" | string;
  };
}

interface CachedRecommendations {
  dailyChosenAt: number;
  weeklyChosenAt: number;
  data: HomeRecommendations;
}

// v5 invalidates this week's previous cache after enforcing strict weekly
// theme matching. Weekly playlists may now contain fewer than 16 tracks, but
// every track must match at least one theme that names the playlist.
const cacheKey = () => `farreo-home-recommendations-v5:${auth?.currentUser?.uid || "guest"}`;
const revealKey = (dayKey: string, songId: string) => `farreo-daily-reveal-v1:${auth?.currentUser?.uid || "guest"}:${dayKey}:${songId}`;
const volatileReveals = new Set<string>();
let pendingRecommendations: Promise<HomeRecommendations> | null = null;

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

const recommendationSeed = () => {
  const uid = auth?.currentUser?.uid;
  return uid ? `account:${uid}` : getRecommendationSeed();
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
    // The animation still works if local storage is blocked.
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

async function fetchRecommendations(
  cached: CachedRecommendations | null,
  now: number,
  keys: { dayKey: string; weekKey: string },
) {
  const heardSongIds = getListenedSongIds();
  const signedIn = Boolean(auth?.currentUser?.uid);

  const response = await fetch(`${MUSIC_API_URL}/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientSeed: recommendationSeed(),
      // The daily song must be identical across devices for the same signed-in
      // account. Local listening history only controls the "unheard" UI state.
      heardSongIds: signedIn ? [] : heardSongIds,
      dayKey: keys.dayKey,
      weekKey: keys.weekKey,
    }),
  });

  const next = await response.json().catch(() => ({})) as HomeRecommendations & { error?: string };
  if (!response.ok) throw new Error(next.error || "No se pudieron preparar las recomendaciones.");

  const dailySongUnheard = next.dailySong
    ? !heardSongIds.includes(next.dailySong.id)
    : false;

  const normalizedNext = normalizeRecommendations({
    ...next,
    dailySongUnheard,
  });

  // Once v4 is active the server is authoritative for weekly selection. Do not
  // preserve a device-local weekly set over the server snapshot.
  const data = normalizedNext;

  if (typeof window !== "undefined") {
    const key = cacheKey();
    const serialized = JSON.stringify({
      dailyChosenAt: now,
      weeklyChosenAt: cached?.data.weekKey === keys.weekKey
        ? cached.weeklyChosenAt
        : now,
      data,
    } satisfies CachedRecommendations);

    try {
      window.localStorage.setItem(key, serialized);
    } catch {
      try {
        const staleKeys = Array.from(
          { length: window.localStorage.length },
          (_, index) => window.localStorage.key(index),
        ).filter((item): item is string => Boolean(
          item?.startsWith("farreo-home-recommendations-") && item !== key,
        ));
        staleKeys.forEach((item) => window.localStorage.removeItem(item));
        window.localStorage.setItem(key, serialized);
      } catch {
        // Recommendations remain usable even if they cannot be persisted.
      }
    }
  }

  return data;
}

export async function getHomeRecommendations(force = false): Promise<HomeRecommendations> {
  const cached = readCache();
  const now = Date.now();
  const keys = currentRecommendationKeys();

  const signedIn = Boolean(auth?.currentUser?.uid);
  if (
    !force
    && !signedIn
    && cached
    && cached.data.dayKey === keys.dayKey
    && cached.data.weekKey === keys.weekKey
  ) {
    return normalizeRecommendations(cached.data);
  }

  if (pendingRecommendations) return pendingRecommendations;

  pendingRecommendations = fetchRecommendations(cached, now, keys)
    .finally(() => {
      pendingRecommendations = null;
    });

  return pendingRecommendations;
}

export async function getSharedRecommendation(token: string) {
  const response = await fetch(`${MUSIC_API_URL}/recommendations/shared/${encodeURIComponent(token)}`);
  const data = await response.json().catch(() => ({})) as WeeklyRecommendation & { error?: string };
  if (!response.ok) throw new Error(data.error || "No se pudo abrir la recomendacion.");
  return data;
}

export const recommendationHref = (token: string) => `/recommendation/${encodeURIComponent(token)}`;
