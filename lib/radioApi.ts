export const MUSIC_API_URL =
  process.env.NEXT_PUBLIC_MUSIC_API_URL || "https://welite.ddns.net:3001";

export const getMediaUrl = (url?: string | null) => {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  return `${MUSIC_API_URL}${url}`;
};

export interface ApiSong {
  id: string;
  name: string;
  url: string;
  variantes?: string[];
  lyricsSrt?: string | null;
  lyricsUrl?: string | null;
  lyricsFileName?: string | null;
  duration?: number | null;
}

export interface ApiPlaylistInfo {
  id: string;
  nombre: string;
  iconUrl?: string | null;
  numCanciones: number;
}

export interface RadioSource {
  type: "song" | "global" | "private";
  id: string;
  name: string;
}

export interface RadioQueueItem {
  itemId: string;
  song: ApiSong;
  source: RadioSource;
  pitch: number;
  addedAt: string;
  addedBy?: string;
}

export interface RadioState {
  status: "playing" | "paused";
  queue: RadioQueueItem[];
  currentItem: RadioQueueItem | null;
  shuffle: boolean;
  autoRandomPitch?: boolean;
  version: number;
  anchorPosition: number;
  anchorUpdatedAt: number;
  position: number;
  serverTime: number;
  updatedAt: string;
}

export type RadioInsertAt = "first" | "next" | "last" | "now" | number;

async function parseResponse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Error conectando con la radio.");
  }
  return data as T;
}

export async function radioGet<T>(path: string): Promise<T> {
  const res = await fetch(`${MUSIC_API_URL}${path}`);
  return parseResponse<T>(res);
}

export async function radioPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${MUSIC_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse<T>(res);
}

export async function radioPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${MUSIC_API_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse<T>(res);
}

export async function radioDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${MUSIC_API_URL}${path}`, { method: "DELETE" });
  return parseResponse<T>(res);
}

let serverClockOffsetMs = 0;

export function calibrateRadioClock(state: RadioState | null, receivedAt = Date.now()) {
  if (!state || typeof state.serverTime !== "number") return;
  serverClockOffsetMs = state.serverTime - receivedAt;
}

export function getRadioServerNow() {
  return Date.now() + serverClockOffsetMs;
}

export function getLiveRadioPosition(state: RadioState | null) {
  if (!state?.currentItem) return 0;
  if (state.status !== "playing") return state.position || 0;

  const startsInFuture = state.anchorUpdatedAt > state.serverTime && (state.position || 0) <= 0.05;
  const baseTime = startsInFuture ? state.anchorUpdatedAt : state.serverTime;
  const elapsed = Math.max(0, (getRadioServerNow() - baseTime) / 1000);
  const position = (state.position || 0) + elapsed * state.currentItem.pitch;
  const duration = state.currentItem.song.duration || 0;
  return duration > 0 ? Math.min(duration, position) : position;
}
