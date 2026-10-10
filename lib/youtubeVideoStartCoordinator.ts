"use client";

import { getYoutubeVideoWaitForReady } from "@/lib/youtubeVideoBackgroundPreference";

type YoutubeVideoStartSource = {
  id: string;
  type: string;
} | null;

export interface YoutubeVideoStartRequest {
  trackId: string;
  source: YoutubeVideoStartSource;
  signal: AbortSignal;
  onWaitingChange: (waiting: boolean) => void;
}

type YoutubeVideoStartHandler = (
  request: YoutubeVideoStartRequest,
) => Promise<void>;

let handler: YoutubeVideoStartHandler | null = null;
let seekHandler: ((trackId: string, time: number) => void) | null = null;

export function registerYoutubeVideoSeekHandler(
  nextHandler: (trackId: string, time: number) => void,
) {
  seekHandler = nextHandler;
  return () => {
    if (seekHandler === nextHandler) seekHandler = null;
  };
}

export function notifyYoutubeVideoSeek(trackId: string, time: number) {
  seekHandler?.(trackId, time);
}

export function registerYoutubeVideoStartHandler(
  nextHandler: YoutubeVideoStartHandler,
) {
  handler = nextHandler;

  return () => {
    if (handler === nextHandler) handler = null;
  };
}

export async function prepareYoutubeVideoStart(
  request: YoutubeVideoStartRequest,
) {
  if (request.signal.aborted || !handler) return;

  // With the default non-blocking preference the mounted background component
  // already resolves the video asynchronously when currentTrack changes.
  // Do not claim its blocking start slot: start the audio immediately and let
  // onCanPlay synchronize the video to the audio's current playback position.
  if (!getYoutubeVideoWaitForReady()) return;

  // Opt-in legacy behaviour: hold audio for the video's ready event (or the
  // existing safety timeout/abort) using the exact same coordinator as before.
  await handler(request);
}
