"use client";

import { auth } from "@/lib/firebase";
import { MUSIC_API_URL, type ApiSong, type RadioInsertAt } from "@/lib/radioApi";

const VISITOR_STORAGE_KEY = "farreo-album-visitor-token";

export type AlbumTrackState = "scheduled" | "mystery" | "revealed" | "normal";

export interface AlbumCard {
  id: string;
  nombre: string;
  iconUrl?: string | null;
  numCanciones: number;
  scheduledCount?: number;
  revelationEnabled: boolean;
  revelationVersion: number;
  followerCount: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  isFollowing?: boolean;
  followedAt?: string | null;
  lastOpenedAt?: string | null;
}

export interface AlbumTrackEntry {
  entryId: string;
  position: number;
  addedAt?: string | null;
  releaseAt?: string | null;
  state: AlbumTrackState;
  song?: ApiSong | null;
}

export interface AlbumDetail extends AlbumCard {
  tracks: AlbumTrackEntry[];
  serverTime: number;
  futureCount: number;
  fullyPublished: boolean;
}

export class AlbumApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function visitorToken() {
  if (typeof window === "undefined") return null;
  const existing = window.localStorage.getItem(VISITOR_STORAGE_KEY);
  if (existing) return existing;

  const response = await fetch(`${MUSIC_API_URL}/album-session`, { method: "POST" });
  const data = await response.json().catch(() => ({})) as { token?: string; error?: string };
  if (!response.ok || !data.token) throw new AlbumApiError(data.error || "No se pudo iniciar la revelación.", response.status);
  window.localStorage.setItem(VISITOR_STORAGE_KEY, data.token);
  return data.token;
}

async function albumHeaders(options: { admin?: boolean; json?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (options.json) headers["Content-Type"] = "application/json";
  const user = auth?.currentUser;
  if (user) {
    headers.Authorization = `Bearer ${await user.getIdToken()}`;
  } else if (!options.admin) {
    const token = await visitorToken();
    if (token) headers["X-Farreo-Visitor-Token"] = token;
  }
  return headers;
}

async function parse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new AlbumApiError(data.error || "No se pudo conectar con los álbumes.", response.status);
  return data as T;
}

async function request<T>(path: string, init: RequestInit = {}, options: { admin?: boolean; json?: boolean } = {}) {
  const headers = await albumHeaders(options);
  return parse<T>(await fetch(`${MUSIC_API_URL}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  }));
}

export const listAlbums = () => request<AlbumCard[]>("/albums");
export const listSongAlbums = (songId: string) => request<AlbumCard[]>(`/songs/${encodeURIComponent(songId)}/albums`);
export const getAlbum = (albumId: string) => request<AlbumDetail>(`/albums/${encodeURIComponent(albumId)}`);
export const getAdminAlbum = (albumId: string) => request<AlbumDetail>(`/admin/albums/${encodeURIComponent(albumId)}`, {}, { admin: true });

export const revealAlbumTrack = (albumId: string, entryId: string) => request<{
  entryId: string;
  variant: number;
  song: ApiSong;
}>(`/albums/${encodeURIComponent(albumId)}/tracks/${encodeURIComponent(entryId)}/reveal`, { method: "POST" });

export const claimAlbumFirstPlay = (albumId: string, entryId: string) => request<{
  forcePitch: boolean;
  firstPlay: boolean;
}>(`/albums/${encodeURIComponent(albumId)}/tracks/${encodeURIComponent(entryId)}/first-play`, { method: "POST" });

export const followAlbum = (albumId: string) => request<{ success: boolean }>(`/albums/${encodeURIComponent(albumId)}/follow`, { method: "POST" });
export const unfollowAlbum = (albumId: string) => request<{ success: boolean }>(`/albums/${encodeURIComponent(albumId)}/follow`, { method: "DELETE" });
export const touchAlbum = (albumId: string) => request<{ success: boolean }>(`/albums/${encodeURIComponent(albumId)}/touch`, { method: "POST" });

export async function addAlbumToRadio<T>(albumId: string, input: {
  entryIds: string[];
  insertAt?: RadioInsertAt;
  shuffle?: boolean;
  pitch?: number;
  randomPitch?: boolean;
  addedBy?: string;
}) {
  const headers = await albumHeaders({ json: true });
  return parse<T>(await fetch(`${MUSIC_API_URL}/radio/queue/album`, {
    method: "POST",
    headers,
    body: JSON.stringify({ albumId, ...input }),
  }));
}

export async function createAlbum(form: FormData) {
  return request<{ success: boolean; id: string }>("/admin/albums", { method: "POST", body: form }, { admin: true });
}

export async function updateAlbum(albumId: string, form: FormData) {
  return request<{ success: boolean }>(`/admin/albums/${encodeURIComponent(albumId)}`, { method: "PATCH", body: form }, { admin: true });
}

export const deleteAlbum = (albumId: string) => request<{ success: boolean }>(`/admin/albums/${encodeURIComponent(albumId)}`, { method: "DELETE" }, { admin: true });

export const addAlbumTrack = (albumId: string, input: { songId: string; releaseAt?: string | null }) => request<{ success: boolean }>(
  `/admin/albums/${encodeURIComponent(albumId)}/tracks`,
  { method: "POST", body: JSON.stringify(input) },
  { admin: true, json: true },
);

export const updateAlbumTrack = (albumId: string, entryId: string, releaseAt?: string | null) => request<{ success: boolean }>(
  `/admin/albums/${encodeURIComponent(albumId)}/tracks/${encodeURIComponent(entryId)}`,
  { method: "PATCH", body: JSON.stringify({ releaseAt: releaseAt || null }) },
  { admin: true, json: true },
);

export const removeAlbumTrack = (albumId: string, entryId: string) => request<{ success: boolean }>(
  `/admin/albums/${encodeURIComponent(albumId)}/tracks/${encodeURIComponent(entryId)}`,
  { method: "DELETE" },
  { admin: true },
);

export const reorderAlbumTracks = (albumId: string, entryIds: string[]) => request<{ success: boolean }>(
  `/admin/albums/${encodeURIComponent(albumId)}/reorder`,
  { method: "POST", body: JSON.stringify({ entryIds }) },
  { admin: true, json: true },
);
