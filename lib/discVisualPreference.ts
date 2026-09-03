"use client";

export type DiscVisualMode = "always" | "album" | "never";

export const DISC_VISUAL_STORAGE_KEY = "farreo-disc-visual-mode-v1";
export const DISC_VISUAL_CHANGE_EVENT = "farreo:disc-visual-mode-change";
export const DEFAULT_DISC_VISUAL_MODE: DiscVisualMode = "album";

export function isDiscVisualMode(value: unknown): value is DiscVisualMode {
  return value === "always" || value === "album" || value === "never";
}

export function getDiscVisualMode(): DiscVisualMode {
  if (typeof window === "undefined") return DEFAULT_DISC_VISUAL_MODE;

  try {
    const stored = window.localStorage.getItem(DISC_VISUAL_STORAGE_KEY);
    return isDiscVisualMode(stored) ? stored : DEFAULT_DISC_VISUAL_MODE;
  } catch {
    return DEFAULT_DISC_VISUAL_MODE;
  }
}

export function setDiscVisualMode(mode: DiscVisualMode) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(DISC_VISUAL_STORAGE_KEY, mode);
  } catch {
    // The preference still applies for the current page through the event.
  }

  window.dispatchEvent(new CustomEvent<DiscVisualMode>(DISC_VISUAL_CHANGE_EVENT, {
    detail: mode,
  }));
}
