"use client";

export const YOUTUBE_VIDEO_BACKGROUND_STORAGE_KEY = "farreo-youtube-video-background-enabled-v1";
export const YOUTUBE_VIDEO_BACKGROUND_CHANGE_EVENT = "farreo:youtube-video-background-change";
export const DEFAULT_YOUTUBE_VIDEO_BACKGROUND_ENABLED = true;

export const YOUTUBE_RADIO_BACKGROUND_STORAGE_KEY = "farreo-youtube-radio-background-enabled-v1";
export const YOUTUBE_RADIO_BACKGROUND_CHANGE_EVENT = "farreo:youtube-radio-background-change";
export const DEFAULT_YOUTUBE_RADIO_BACKGROUND_ENABLED = true;

type PlayerSourceLike = {
  id: string;
  type: string;
} | null | undefined;

function readBooleanPreference(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;

  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "off") return false;
    if (stored === "on") return true;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeBooleanPreference(
  key: string,
  eventName: string,
  enabled: boolean,
) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(key, enabled ? "on" : "off");
  } catch {
    // The current tab still receives the event if storage is unavailable.
  }

  window.dispatchEvent(new CustomEvent<boolean>(
    eventName,
    { detail: enabled },
  ));
}

export function getYoutubeVideoBackgroundEnabled() {
  return readBooleanPreference(
    YOUTUBE_VIDEO_BACKGROUND_STORAGE_KEY,
    DEFAULT_YOUTUBE_VIDEO_BACKGROUND_ENABLED,
  );
}

export function setYoutubeVideoBackgroundEnabled(enabled: boolean) {
  writeBooleanPreference(
    YOUTUBE_VIDEO_BACKGROUND_STORAGE_KEY,
    YOUTUBE_VIDEO_BACKGROUND_CHANGE_EVENT,
    enabled,
  );
}

export function getYoutubeRadioBackgroundEnabled() {
  return readBooleanPreference(
    YOUTUBE_RADIO_BACKGROUND_STORAGE_KEY,
    DEFAULT_YOUTUBE_RADIO_BACKGROUND_ENABLED,
  );
}

export function setYoutubeRadioBackgroundEnabled(enabled: boolean) {
  writeBooleanPreference(
    YOUTUBE_RADIO_BACKGROUND_STORAGE_KEY,
    YOUTUBE_RADIO_BACKGROUND_CHANGE_EVENT,
    enabled,
  );
}

const withoutTrailingSlash = (value: string) => (
  value.length > 1 ? value.replace(/\/+$/, "") : value
);

const decodedPath = (pathname: string) => {
  try {
    return decodeURIComponent(withoutTrailingSlash(pathname));
  } catch {
    return withoutTrailingSlash(pathname);
  }
};

export function isYoutubeVideoBackgroundContext(
  pathname: string,
  source: PlayerSourceLike,
  playerMode: "local" | "radio",
) {
  const path = decodedPath(pathname);

  if (path === "/radio") {
    return playerMode === "radio";
  }

  if (!source || playerMode !== "local") return false;

  if (source.type === "global") {
    return path === `/playlist/${source.id}`;
  }

  if (source.type === "private") {
    return path === `/user-playlist/${source.id}`;
  }

  return false;
}
