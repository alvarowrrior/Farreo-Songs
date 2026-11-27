"use client";

import type { MusicPlaylistSource, MusicTrack } from "@/components/MusicPlayerProvider";
import type { RadioState } from "@/lib/radioApi";

export type FarreoNativeEvent =
  | "state"
  | "progress"
  | "trackChanged"
  | "firstListenStarted"
  | "ended"
  | "error"
  | "frequency";

export interface FarreoNativeQueuePayload {
  tracks: MusicTrack[];
  startIndex?: number;
  source?: MusicPlaylistSource | null;
  shuffle?: boolean;
  autoRandomPitch?: boolean;
  pitch?: number;
  volume?: number;
}

export interface FarreoNativeState {
  isAvailable: boolean;
  stateVersion?: number;
  isPlaying: boolean;
  isBuffering?: boolean;
  currentTrack: MusicTrack | null;
  currentSource: MusicPlaylistSource | null;
  position: number;
  duration: number;
  volume: number;
  pitch: number;
  shuffle: boolean;
  autoRandomPitch?: boolean;
  isPitchLocked?: boolean;
  canPlayNext?: boolean;
  canPlayPrev?: boolean;
  radioState?: RadioState | null;
}

export interface FarreoOfflineFile {
  exists: boolean;
  uri: string;
  size: number;
}

/** Primera version de la APK que guarda canciones como archivos para el modo sin conexion. */
export const NATIVE_OFFLINE_MIN_BUILD = 23;

type ListenerHandle = {
  remove: () => Promise<void> | void;
};

type NativePlugin = {
  loadQueue: (payload: FarreoNativeQueuePayload) => Promise<FarreoNativeState>;
  play: () => Promise<FarreoNativeState>;
  pause: () => Promise<FarreoNativeState>;
  seek: (payload: { position: number }) => Promise<FarreoNativeState>;
  next: () => Promise<FarreoNativeState>;
  previous: () => Promise<FarreoNativeState>;
  setVolume: (payload: { volume: number }) => Promise<FarreoNativeState>;
  setPitch: (payload: { pitch: number }) => Promise<FarreoNativeState>;
  setShuffle: (payload: { shuffle: boolean }) => Promise<FarreoNativeState>;
  setAutoRandomPitch?: (payload: { enabled: boolean }) => Promise<FarreoNativeState>;
  enterRadio: (payload?: { apiUrl?: string }) => Promise<FarreoNativeState>;
  leaveRadio: () => Promise<FarreoNativeState>;
  getState: () => Promise<FarreoNativeState>;
  getPendingFirstPlays?: () => Promise<{ items: Array<{ albumId: string; albumEntryId: string }> }>;
  confirmFirstPlay?: (payload: { albumId: string; albumEntryId: string; forcePitch?: boolean }) => Promise<FarreoNativeState>;
  getAppInfo: () => Promise<{ version: string; build: number }>;
  openExternalUrl?: (payload: { url: string }) => Promise<void>;
  enableVisualization: () => Promise<{ enabled: boolean }>;
  // Modo sin conexion (APK build >= 23)
  saveOfflineSong?: (payload: { id: string; url: string }) => Promise<FarreoOfflineFile>;
  getOfflineSong?: (payload: { id: string }) => Promise<FarreoOfflineFile>;
  deleteOfflineSong?: (payload: { id: string }) => Promise<{ deleted: boolean }>;
  addListener: (
    eventName: FarreoNativeEvent,
    listener: (payload: unknown) => void,
  ) => Promise<ListenerHandle>;
};

declare global {
  interface Window {
    Capacitor?: {
      Plugins?: Record<string, unknown>;
      getPlatform?: () => string;
    };
  }
}

export function getFarreoNativeAudio(): NativePlugin | null {
  if (typeof window === "undefined") return null;
  return (window.Capacitor?.Plugins?.FarreoNativeAudio as NativePlugin | undefined) ?? null;
}

export function isFarreoNativeAudioAvailable() {
  return Boolean(getFarreoNativeAudio());
}

export async function getFarreoNativeState() {
  const plugin = getFarreoNativeAudio();
  if (!plugin) return null;
  return plugin.getState();
}

export async function addFarreoNativeListener(
  eventName: FarreoNativeEvent,
  listener: (payload: unknown) => void,
) {
  const plugin = getFarreoNativeAudio();
  if (!plugin) return null;
  return plugin.addListener(eventName, listener);
}

/**
 * Devuelve el plugin nativo solo si la APK instalada sabe guardar canciones sin
 * conexion (las APK antiguas no tienen esos metodos).
 */
export async function getNativeOfflineAudio(): Promise<NativePlugin | null> {
  const plugin = getFarreoNativeAudio();
  if (!plugin) return null;
  try {
    const info = await plugin.getAppInfo();
    return Number(info.build) >= NATIVE_OFFLINE_MIN_BUILD ? plugin : null;
  } catch {
    return null;
  }
}
