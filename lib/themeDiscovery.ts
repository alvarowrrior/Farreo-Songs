"use client";

import { auth } from "@/lib/firebase";
import { MUSIC_API_URL, type ApiSong } from "@/lib/radioApi";

export interface PublicSongTheme {
  id: string;
  name: string;
  count: number;
}

export interface ThemeDiscoverySong extends Pick<
  ApiSong,
  "id" | "name" | "url" | "variantes" | "themeIds" | "duration" | "iconUrl" | "createdAt"
> {
  themeIds: string[];
  hidden?: boolean;
}

export interface ThemeDiscoveryPayload {
  generatedAt: string;
  isAdmin: boolean;
  themes: PublicSongTheme[];
  songs: ThemeDiscoverySong[];
}

const CACHE_MS = 30 * 1000;
const cache = new Map<string, { expiresAt: number; data: ThemeDiscoveryPayload }>();
const pending = new Map<string, Promise<ThemeDiscoveryPayload>>();

const viewerKey = () => auth?.currentUser?.uid || "guest";

async function viewerHeaders() {
  const user = auth?.currentUser;
  return user ? { Authorization: `Bearer ${await user.getIdToken()}` } : {};
}

export function invalidateThemeDiscoveryCache() {
  cache.clear();
  pending.clear();
}

export async function getThemeDiscovery(force = false) {
  const key = viewerKey();
  const cached = cache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.data;

  const existing = pending.get(key);
  if (!force && existing) return existing;

  const request = fetch(`${MUSIC_API_URL}/theme-discovery`, {
    cache: "no-store",
    headers: await viewerHeaders(),
  })
    .then(async (response) => {
      const data = await response.json().catch(() => null) as ThemeDiscoveryPayload | { error?: string } | null;
      if (!response.ok || !data || !("themes" in data) || !("songs" in data)) {
        throw new Error((data && "error" in data && data.error) || "No se pudieron cargar los temas.");
      }
      const normalized: ThemeDiscoveryPayload = {
        generatedAt: String(data.generatedAt || ""),
        isAdmin: Boolean(data.isAdmin),
        themes: Array.isArray(data.themes) ? data.themes : [],
        songs: Array.isArray(data.songs) ? data.songs : [],
      };
      cache.set(key, { expiresAt: Date.now() + CACHE_MS, data: normalized });
      return normalized;
    })
    .finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });

  if (!force) pending.set(key, request);
  return request;
}

export async function getThemeDiscoverySong(songId: string) {
  const response = await fetch(
    `${MUSIC_API_URL}/theme-discovery/song/${encodeURIComponent(songId)}`,
    {
      cache: "no-store",
      headers: await viewerHeaders(),
    },
  );
  const data = await response.json().catch(() => ({})) as ApiSong & { error?: string; hidden?: boolean };
  if (!response.ok) throw new Error(data.error || "No se pudo cargar la canción.");
  return data;
}

export async function updateThemeDiscoverySongThemes(song: ThemeDiscoverySong, themeIds: string[]) {
  const user = auth?.currentUser;
  if (!user) throw new Error("Inicia sesión como administrador.");

  const form = new FormData();
  form.append("metadata", JSON.stringify({
    nombre: song.name,
    variantes: song.variantes || [],
    themeIds,
    removeLyrics: false,
  }));

  const response = await fetch(`${MUSIC_API_URL}/cancion/${encodeURIComponent(song.id)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${await user.getIdToken()}` },
    body: form,
  });
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(data.error || "No se pudieron actualizar los temas.");

  invalidateThemeDiscoveryCache();
}

export function songCreatedAtMs(song: Pick<ApiSong, "createdAt">) {
  const value = song.createdAt;
  if (!value) return 0;
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === "object" && typeof value.seconds === "number") {
    return value.seconds * 1000;
  }
  return 0;
}

export function themeColor(themeId: string) {
  let hash = 2166136261;
  for (let index = 0; index < themeId.length; index += 1) {
    hash ^= themeId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const hue = Math.abs(hash) % 360;
  const saturation = 66 + (Math.abs(hash >>> 8) % 14);
  const lightness = 48 + (Math.abs(hash >>> 16) % 10);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}
