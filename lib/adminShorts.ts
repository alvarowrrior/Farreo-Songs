"use client";

import { auth } from "@/lib/firebase";
import { MUSIC_API_URL, type ApiSong } from "@/lib/radioApi";

const SESSION_STORAGE_KEY = "farreo-admin-shorts-session";
const DEFERRED_STORAGE_PREFIX = "farreo-admin-shorts-deferred";

export type AdminShortLyricsMode = "none" | "static" | "dynamic";

export interface AdminShortSong extends ApiSong {
  themeIds: string[];
  pasada_admin_short: number;
}

export interface AdminShortsState {
  versionGlobal: number;
  updatedAt?: string | null;
  songs: AdminShortSong[];
  totalEligible: number;
  lockedCount: number;
}

export interface AdminShortLyricsDraftPayload {
  changed: boolean;
  mode: AdminShortLyricsMode;
  staticLyrics?: string;
  dynamicFile?: File | null;
}

export interface AdminShortSongDraftPayload {
  nombre: string;
  variantes: string[];
  themeIds: string[];
  iconFile?: File | null;
  advancedCoverFile?: File | null;
  lyrics?: AdminShortLyricsDraftPayload;
}

interface DeferredAdminShortsState {
  round: number;
  songIds: string[];
}

export class AdminShortsApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "AdminShortsApiError";
    this.status = status;
    this.code = code;
  }
}

async function adminHeaders(json = false) {
  const user = auth?.currentUser;
  if (!user) throw new Error("Inicia sesión como administrador.");
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${await user.getIdToken()}`,
  };
}

async function parse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
  if (!response.ok) {
    throw new AdminShortsApiError(
      data.error || "No se pudo completar la operación de Admin Shorts.",
      response.status,
      data.code,
    );
  }
  return data as T;
}

const randomSessionId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `shorts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const deferredStorageKey = (sessionId: string) => `${DEFERRED_STORAGE_PREFIX}:${sessionId}`;

function readDeferredAdminShorts(sessionId: string): DeferredAdminShortsState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(deferredStorageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeferredAdminShortsState>;
    const round = Number(parsed.round);
    const songIds = Array.isArray(parsed.songIds)
      ? [...new Set(parsed.songIds.map(String).filter(Boolean))]
      : [];
    if (!Number.isInteger(round) || round < 1) return null;
    return { round, songIds };
  } catch {
    return null;
  }
}

function writeDeferredAdminShorts(sessionId: string, state: DeferredAdminShortsState | null) {
  if (typeof window === "undefined") return;
  try {
    const key = deferredStorageKey(sessionId);
    if (!state || state.songIds.length === 0) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Si sessionStorage no está disponible, la reserva del backend se libera
    // igualmente; lo único que perdemos es recordar la posposición en esta pestaña.
  }
}

export function rememberDeferredAdminShort(songId: string, sessionId: string, round: number) {
  const existing = readDeferredAdminShorts(sessionId);
  const songIds = existing?.round === round ? existing.songIds : [];
  if (songIds.includes(songId)) return;
  writeDeferredAdminShorts(sessionId, {
    round,
    songIds: [...songIds, songId],
  });
}

export function getAdminShortsSessionId() {
  if (typeof window === "undefined") return randomSessionId();
  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const created = randomSessionId();
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return randomSessionId();
  }
}

export const isAdminShortClaimConflict = (error: unknown) => (
  error instanceof AdminShortsApiError
  && error.status === 409
  && (error.code === "claimed" || error.code === "already-passed" || error.code === "claim-required")
);

export async function getAdminShortsState(sessionId: string) {
  const params = new URLSearchParams({ sessionId });
  const state = await parse<AdminShortsState>(await fetch(`${MUSIC_API_URL}/admin/shorts?${params.toString()}`, {
    headers: await adminHeaders(),
    cache: "no-store",
  }));

  const deferred = readDeferredAdminShorts(sessionId);
  if (!deferred) return state;

  if (deferred.round !== state.versionGlobal) {
    writeDeferredAdminShorts(sessionId, null);
    return state;
  }

  const deferredIds = new Set(deferred.songIds);
  let availableDeferred = 0;
  const songs = state.songs.filter((song) => {
    if (!deferredIds.has(song.id)) return true;
    availableDeferred += 1;
    return false;
  });

  return {
    ...state,
    songs,
    totalEligible: Math.max(0, state.totalEligible - availableDeferred),
  };
}

export async function getAdminShortSong(songId: string) {
  return parse<AdminShortSong>(await fetch(`${MUSIC_API_URL}/admin/shorts/${encodeURIComponent(songId)}`, {
    headers: await adminHeaders(),
    cache: "no-store",
  }));
}

export async function claimAdminShort(songId: string, sessionId: string) {
  return parse<{
    success: boolean;
    songId: string;
    round: number;
    expiresAt: number;
  }>(await fetch(`${MUSIC_API_URL}/admin/shorts/${encodeURIComponent(songId)}/claim`, {
    method: "POST",
    headers: await adminHeaders(true),
    body: JSON.stringify({ sessionId }),
  }));
}

export async function heartbeatAdminShortClaim(songId: string, sessionId: string) {
  return parse<{ success: boolean; songId: string; expiresAt: number }>(
    await fetch(`${MUSIC_API_URL}/admin/shorts/${encodeURIComponent(songId)}/heartbeat`, {
      method: "POST",
      headers: await adminHeaders(true),
      body: JSON.stringify({ sessionId }),
    }),
  );
}

export async function releaseAdminShortClaim(songId: string, sessionId: string, keepalive = false) {
  return parse<{ success: boolean }>(
    await fetch(`${MUSIC_API_URL}/admin/shorts/${encodeURIComponent(songId)}/claim`, {
      method: "DELETE",
      headers: await adminHeaders(true),
      body: JSON.stringify({ sessionId }),
      keepalive,
    }),
  );
}

export async function releaseAdminShortSessionClaims(sessionId: string, keepalive = false) {
  return parse<{ success: boolean; released: number }>(
    await fetch(`${MUSIC_API_URL}/admin/shorts/claims`, {
      method: "DELETE",
      headers: await adminHeaders(true),
      body: JSON.stringify({ sessionId }),
      keepalive,
    }),
  );
}

export async function setAdminShortsVersion(versionGlobal: number, sessionId?: string) {
  return parse<{ success: boolean; versionGlobal: number; updatedAt?: string | null }>(
    await fetch(`${MUSIC_API_URL}/admin/shorts/version`, {
      method: "PATCH",
      headers: await adminHeaders(true),
      body: JSON.stringify({ versionGlobal, sessionId }),
    }),
  );
}

export async function markAdminShortPassed(songId: string, sessionId: string) {
  return parse<{
    success: boolean;
    songId: string;
    pasada_admin_short: number;
    versionGlobal: number;
    passedRound: number;
  }>(await fetch(`${MUSIC_API_URL}/admin/shorts/${encodeURIComponent(songId)}/pass`, {
    method: "POST",
    headers: await adminHeaders(true),
    body: JSON.stringify({ sessionId }),
  }));
}

async function saveAdminShortLyrics(songId: string, lyrics: AdminShortLyricsDraftPayload) {
  const formData = new FormData();
  formData.append("mode", lyrics.mode);
  if (lyrics.mode === "static") {
    formData.append("staticLyrics", lyrics.staticLyrics || "");
  }
  if (lyrics.mode === "dynamic" && lyrics.dynamicFile) {
    formData.append("lyrics", lyrics.dynamicFile);
  }

  return parse<{ success: boolean; song: AdminShortSong }>(
    await fetch(`${MUSIC_API_URL}/admin/shorts/${encodeURIComponent(songId)}/lyrics`, {
      method: "PUT",
      headers: await adminHeaders(),
      body: formData,
    }),
  );
}

export async function saveAdminShortSong(songId: string, payload: AdminShortSongDraftPayload) {
  const formData = new FormData();
  if (payload.iconFile) formData.append("icon", payload.iconFile);
  if (payload.advancedCoverFile) formData.append("advancedCover", payload.advancedCoverFile);
  formData.append("metadata", JSON.stringify({
    nombre: payload.nombre.trim(),
    variantes: payload.variantes,
    themeIds: payload.themeIds,
    removeLyrics: false,
  }));

  await parse<{ success: boolean; message: string; data: Record<string, unknown> }>(
    await fetch(`${MUSIC_API_URL}/cancion/${encodeURIComponent(songId)}`, {
      method: "PUT",
      headers: await adminHeaders(),
      body: formData,
    }),
  );

  if (payload.lyrics?.changed) {
    await saveAdminShortLyrics(songId, payload.lyrics);
  }

  return getAdminShortSong(songId);
}

export async function getAlternativeNameMap() {
  return parse<Record<string, string>>(await fetch(`${MUSIC_API_URL}/etiquetas`, {
    headers: await adminHeaders(),
    cache: "no-store",
  }));
}
