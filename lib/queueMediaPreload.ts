"use client";

// The music player owns bandwidth priority. Background video may start its
// speculative download only after the NEXT audio has either reached canplay
// (normal file) or the YouTube audio proxy has accepted its URL prewarm.
// We keep only a short-lived signal, not a second streaming audio connection.
const readyAt = new Map<string, number>();
const listeners = new Set<(trackId: string) => void>();
const MAX_AGE_MS = 30_000;

export function markQueuedAudioPrepared(trackId: string) {
  readyAt.set(trackId, Date.now());
  if (readyAt.size > 24) {
    const oldest = readyAt.keys().next().value;
    if (oldest) readyAt.delete(oldest);
  }
  listeners.forEach((listener) => listener(trackId));
}

export function resetQueuedAudioPrepared(trackId: string) {
  readyAt.delete(trackId);
}

export function onQueuedAudioPrepared(trackId: string, callback: () => void) {
  const notify = (id: string) => { if (id === trackId) callback(); };
  listeners.add(notify);
  if (Date.now() - (readyAt.get(trackId) ?? 0) < MAX_AGE_MS) callback();
  return () => listeners.delete(notify);
}

// Automatic transitions which explicitly choose audio-first must not be
// paused again by the separately mounted song-info/sidebar cover sync gate.
const audioFirstTrackStarts = new Map<string, number>();
export function markAudioFirstTransition(trackId: string) {
  audioFirstTrackStarts.set(trackId, Date.now());
}
// Pure read for components that render during an audio-first queue switch.
// The sidebar must know BEFORE its first paint, not in a later effect (which
// would briefly mount and start fetching the competing video source).
export function isAudioFirstTransition(trackId: string): boolean {
  const at = audioFirstTrackStarts.get(trackId);
  return at !== undefined && Date.now() - at < 30_000;
}

export function consumeAudioFirstTransition(trackId: string): boolean {
  const at = audioFirstTrackStarts.get(trackId);
  audioFirstTrackStarts.delete(trackId);
  return at !== undefined && Date.now() - at < 30_000;
}

// A `playing` event alone does not mean a streaming audio source has a
// sustainable buffer. Only grant video bandwidth after audible progress and
// a useful buffered lead. Short songs get a proportional requirement.
export function audioHasVideoHeadroom(audio: Pick<HTMLMediaElement,
  "currentTime" | "duration" | "readyState" | "seeking" | "buffered">): boolean {
  if (audio.seeking || audio.readyState < 3 || audio.currentTime < 1.25) return false;
  let bufferedAhead = 0;
  for (let i = 0; i < audio.buffered.length; i += 1) {
    if (audio.buffered.start(i) <= audio.currentTime + 0.05
      && audio.buffered.end(i) >= audio.currentTime) {
      bufferedAhead = Math.max(bufferedAhead,
        audio.buffered.end(i) - audio.currentTime);
    }
  }
  const remaining = Number.isFinite(audio.duration)
    ? Math.max(0, audio.duration - audio.currentTime) : Infinity;
  const requiredLead = Math.min(4, Math.max(0.45, remaining - 0.3));
  return bufferedAhead >= requiredLead
    || (audio.readyState >= 4 && audio.currentTime >= 2);
}

const playingAudioAt = new Map<string, number>();
const activeAudioListeners = new Set<(trackId: string, playing: boolean) => void>();
export function resetActiveAudioPlaying(trackId: string) {
  playingAudioAt.delete(trackId);
  activeAudioListeners.forEach((listener) => listener(trackId, false));
}
export function markActiveAudioPlaying(trackId: string) {
  playingAudioAt.set(trackId, Date.now());
  activeAudioListeners.forEach((listener) => listener(trackId, true));
}
export function onActiveAudioPlaying(trackId: string, callback: (ready: boolean) => void) {
  const notify = (id: string, playing: boolean) => {
    if (id === trackId) callback(playing);
  };
  activeAudioListeners.add(notify);
  if (Date.now() - (playingAudioAt.get(trackId) ?? 0) < MAX_AGE_MS) callback(true);
  return () => { activeAudioListeners.delete(notify); };
}
