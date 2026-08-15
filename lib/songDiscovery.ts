"use client";

import { auth } from "@/lib/firebase";
import { MUSIC_API_URL, type ApiSong } from "@/lib/radioApi";
import { listAdminSongs } from "@/lib/songThemes";

const ADMIN_EMAILS = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const POSITIVE_CACHE_TTL_MS = 60 * 1000;
const EMPTY_CACHE_TTL_MS = 10 * 1000;

const cache = new Map<string, { expiresAt: number; songs: ApiSong[] }>();
const pending = new Map<string, Promise<ApiSong[]>>();
let adminSongsPending: Promise<ApiSong[]> | null = null;

const isCurrentUserAdmin = () => {
  const email = auth?.currentUser?.email?.trim().toLowerCase() || "";
  return Boolean(email && ADMIN_EMAILS.includes(email));
};

const sharedThemeCount = (left?: string[], right?: string[]) => {
  if (!left?.length || !right?.length) return 0;
  const rightSet = new Set(right.map(String));
  return left.reduce((count, id) => count + (rightSet.has(String(id)) ? 1 : 0), 0);
};

async function loadFreshAdminSongs() {
  // Admin discovery is deliberately fresh. Admins are precisely the users who
  // change themes/visibility, so keeping a completed catalogue in a long-lived
  // client cache makes the review UI misleading. We only deduplicate concurrent
  // requests from multiple mounted components.
  if (adminSongsPending) return adminSongsPending;

  adminSongsPending = listAdminSongs()
    .finally(() => {
      adminSongsPending = null;
    });

  return adminSongsPending;
}

async function listAdminSimilarSongs(songId: string, limit: number) {
  const songs = await loadFreshAdminSongs();
  const source = songs.find((song) => song.id === songId);
  const sourceThemes = source?.themeIds?.map(String) || [];
  if (!source || sourceThemes.length === 0) return [];

  return songs
    .filter((song) => song.id !== source.id)
    .map((song) => ({
      song,
      sharedThemeCount: sharedThemeCount(sourceThemes, song.themeIds),
      random: Math.random(),
    }))
    .filter((entry) => entry.sharedThemeCount > 0)
    .sort((left, right) => (
      right.sharedThemeCount - left.sharedThemeCount
      || left.random - right.random
    ))
    .slice(0, limit)
    .map((entry) => entry.song);
}

export function invalidateSimilarSongs(songId?: string) {
  if (!songId) {
    cache.clear();
    return;
  }

  const prefix = `${songId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export async function listSimilarSongs(songId: string, limit = 12) {
  const safeLimit = Math.min(30, Math.max(1, Number(limit) || 12));

  // The public backend intentionally removes hidden songs. That is correct for
  // normal users, but an admin is allowed to inspect hidden songs too. Use the
  // already protected /admin/canciones catalogue so a hidden source (or hidden
  // candidate) can still participate in Admin similar-song discovery.
  if (isCurrentUserAdmin()) {
    return listAdminSimilarSongs(songId, safeLimit);
  }

  const key = `${songId}:${safeLimit}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.songs;

  const existing = pending.get(key);
  if (existing) return existing;

  const request = (async () => {
    const response = await fetch(
      `${MUSIC_API_URL}/songs/${encodeURIComponent(songId)}/similar?limit=${safeLimit}`,
      { cache: "no-store" },
    );
    const data = await response.json().catch(() => ([])) as ApiSong[] & { error?: string };
    if (!response.ok) throw new Error(data.error || "No se pudieron cargar canciones similares.");

    // Empty results are intentionally very short lived. A song may have just
    // been re-tagged while another tab still had an old result in memory.
    const ttl = data.length > 0 ? POSITIVE_CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
    cache.set(key, { expiresAt: Date.now() + ttl, songs: data });
    return data;
  })().finally(() => pending.delete(key));

  pending.set(key, request);
  return request;
}
