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
  dailySnapshot?: {
    persisted: boolean;
    createdAt?: string | null;
    scope?: "public" | "admin" | string;
  };
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

// v6 invalidates any pre-fix cache that may contain a guest recommendation or
// a daily song chosen before the server-side daily snapshot existed.
const cacheKey = (viewer: string) => `farreo-home-recommendations-v6:${viewer}`;
const revealKey = (dayKey: string, songId: string) => `farreo-daily-reveal-v1:${auth?.currentUser?.uid || "guest"}:${dayKey}:${songId}`;
const volatileReveals = new Set<string>();
const pendingRecommendations = new Map<string, Promise<HomeRecommendations>>();

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

const currentViewer = () => auth?.currentUser?.uid || "guest";

const recommendationSeed = (viewer: string) => (
  viewer === "guest" ? getRecommendationSeed() : `account:${viewer}`
);

async function recommendationHeaders(viewer: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (viewer === "guest") return headers;

  const user = auth?.currentUser;
  if (!user || user.uid !== viewer) {
    throw new Error("La sesión cambió mientras se preparaban las recomendaciones.");
  }

  headers.Authorization = `Bearer ${await user.getIdToken()}`;
  return headers;
}

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
    // The reveal animation still works if local storage is unavailable.
  }
}

function readCache(viewer: string): CachedRecommendations | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(cacheKey(viewer)) || "null") as CachedRecommendations | null;
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
  viewer: string,
  cached: CachedRecommendations | null,
  now: number,
  keys: { dayKey: string; weekKey: string },
) {
  const heardSongIds = getListenedSongIds();
  const signedIn = viewer !== "guest";

  const response = await fetch(`${MUSIC_API_URL}/recommendations`, {
    method: "POST",
    headers: await recommendationHeaders(viewer),
    body: JSON.stringify({
      clientSeed: recommendationSeed(viewer),
      // Signed-in selection is account-scoped. Device-local listening history
      // still controls the reveal/unheard UI, but never changes the chosen song.
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

  const data = normalizeRecommendations({
    ...next,
    dailySongUnheard,
  });

  if (typeof window !== "undefined") {
    const key = cacheKey(viewer);
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
  const viewer = currentViewer();
  const cached = readCache(viewer);
  const now = Date.now();
  const keys = currentRecommendationKeys();

  // Guests have no server identity, so their device cache is the stable source.
  // Signed-in users always revalidate against the account snapshots on Linux.
  if (
    !force
    && viewer === "guest"
    && cached
    && cached.data.dayKey === keys.dayKey
    && cached.data.weekKey === keys.weekKey
  ) {
    return normalizeRecommendations(cached.data);
  }

  const requestKey = `${viewer}:${keys.dayKey}:${keys.weekKey}`;
  const existing = pendingRecommendations.get(requestKey);
  if (existing) return existing;

  const request = fetchRecommendations(viewer, cached, now, keys)
    .finally(() => {
      if (pendingRecommendations.get(requestKey) === request) {
        pendingRecommendations.delete(requestKey);
      }
    });

  pendingRecommendations.set(requestKey, request);
  return request;
}

export async function getSharedRecommendation(token: string) {
  const response = await fetch(`${MUSIC_API_URL}/recommendations/shared/${encodeURIComponent(token)}`);
  const data = await response.json().catch(() => ({})) as WeeklyRecommendation & { error?: string };
  if (!response.ok) throw new Error(data.error || "No se pudo abrir la recomendacion.");
  return data;
}

export const recommendationHref = (token: string) => `/recommendation/${encodeURIComponent(token)}`;
