"use client";

import { auth } from "@/lib/firebase";
import { MUSIC_API_URL, type ApiSong } from "@/lib/radioApi";

export interface SongTheme {
  id: string;
  name: string;
  createdAt?: string | null;
}

async function parse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(data.error || "No se pudieron cargar los temas.");
  return data as T;
}

async function adminHeaders(json = false) {
  const user = auth?.currentUser;
  if (!user) throw new Error("Inicia sesión como administrador para gestionar temas.");
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${await user.getIdToken()}`,
  };
}

export async function listSongThemes() {
  return parse<SongTheme[]>(await fetch(`${MUSIC_API_URL}/admin/song-themes`, {
    headers: await adminHeaders(),
    cache: "no-store",
  }));
}

export async function listAdminSongs() {
  return parse<ApiSong[]>(await fetch(`${MUSIC_API_URL}/admin/canciones`, {
    headers: await adminHeaders(),
    cache: "no-store",
  }));
}

export async function createSongTheme(name: string) {
  return parse<{ theme: SongTheme; created: boolean }>(await fetch(`${MUSIC_API_URL}/admin/song-themes`, {
    method: "POST",
    headers: await adminHeaders(true),
    body: JSON.stringify({ name }),
  }));
}

export async function deleteSongTheme(themeId: string) {
  return parse<{ success: boolean; affectedSongs: number }>(await fetch(`${MUSIC_API_URL}/admin/song-themes/${encodeURIComponent(themeId)}`, {
    method: "DELETE",
    headers: await adminHeaders(),
  }));
}
