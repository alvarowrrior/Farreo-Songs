"use client";

import type { MusicTrack, MusicPlaylistSource } from "@/components/MusicPlayerProvider";
import { getMediaUrl } from "@/lib/radioApi";
import { getAdvancedCoverSyncEnabled } from "@/lib/advancedCoverPlaybackPreference";

const PANEL_VISIBILITY_KEY = "farreo-song-info-sidebar";
const MAX_PANEL_WAIT_MS = 6500;

export function shouldPrepareAdvancedCover(
  track: MusicTrack,
  source: MusicPlaylistSource | null,
) {
  if (typeof window === "undefined" || document.visibilityState !== "visible") return false;
  // The sidebar is a desktop-only surface. Do not wait for it in the APK/mobile.
  if (!window.matchMedia("(min-width: 721px)").matches) return false;
  if (!getAdvancedCoverSyncEnabled()) return false;
  try {
    if (window.localStorage.getItem(PANEL_VISIBILITY_KEY) === "closed") return false;
  } catch { /* Use open-by-default behavior. */ }
  // During the album first-listen lock the sidebar is deliberately hidden.
  if (source?.type === "album" && track.firstListenPending) return false;
  return Boolean(track.advancedCoverUrl || track.iconUrl);
}

function preloadImage(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const img = new Image();
    img.fetchPriority = "high";
    let complete = false;
    const finish = () => {
      if (complete) return;
      complete = true;
      img.onload = null;
      img.onerror = null;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    img.onload = () => { void img.decode().catch(() => undefined).then(finish); };
    img.onerror = finish;
    signal.addEventListener("abort", finish, { once: true });
    img.src = url;
    if (img.complete && img.naturalWidth > 0) {
      void img.decode().catch(() => undefined).then(finish);
    }
  });
}

function preloadVideo(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    let complete = false;
    const finish = () => {
      if (complete) return;
      complete = true;
      video.removeEventListener("loadeddata", finish);
      video.removeEventListener("error", finish);
      signal.removeEventListener("abort", finish);
      video.removeAttribute("src");
      resolve();
    };
    video.addEventListener("loadeddata", finish, { once: true });
    video.addEventListener("error", finish, { once: true });
    signal.addEventListener("abort", finish, { once: true });
    video.src = url;
    video.load();
  });
}

export async function prepareAdvancedCoverBeforeAudio(
  track: MusicTrack,
  source: MusicPlaylistSource | null,
  signal: AbortSignal,
): Promise<void> {
  if (!shouldPrepareAdvancedCover(track, source) || signal.aborted) return;
  const advancedUrl = track.advancedCoverUrl ? getMediaUrl(track.advancedCoverUrl) : "";
  const iconUrl = track.iconUrl ? getMediaUrl(track.iconUrl) : "";
  const tasks: Promise<void>[] = [];
  if (advancedUrl) {
    const isVideo = track.advancedCoverType?.startsWith("video/")
      || /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(advancedUrl);
    tasks.push(isVideo ? preloadVideo(advancedUrl, signal) : preloadImage(advancedUrl, signal));
  }
  if (iconUrl) tasks.push(preloadImage(iconUrl, signal));
  if (!tasks.length) return;

  // Optional visuals must never strand music indefinitely.
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>((resolve) => window.setTimeout(resolve, MAX_PANEL_WAIT_MS)),
  ]);
}
