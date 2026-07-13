"use client";

import type { MusicPlaylistSource, MusicTrack } from "@/components/MusicPlayerProvider";
import type { RadioState } from "@/lib/radioApi";

export type FarreoNativeEvent =
  | "state"
  | "progress"
  | "trackChanged"
  | "ended"
  | "error"
  | "frequency";

export interface FarreoNativeQueuePayload {
  tracks: MusicTrack[];
  startIndex?: number;
  source?: MusicPlaylistSource | null;
  shuffle?: boolean;
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
  canPlayNext?: boolean;
  canPlayPrev?: boolean;
  radioState?: RadioState | null;
}

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
  enterRadio: (payload?: { apiUrl?: string }) => Promise<FarreoNativeState>;
  leaveRadio: () => Promise<FarreoNativeState>;
  getState: () => Promise<FarreoNativeState>;
  getAppInfo: () => Promise<{ version: string; build: number }>;
  enableVisualization: () => Promise<{ enabled: boolean }>;
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
