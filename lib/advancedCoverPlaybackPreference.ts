"use client";

export const ADVANCED_COVER_SYNC_STORAGE_KEY = "farreo-advanced-cover-sync-v1";
export const ADVANCED_COVER_SYNC_CHANGE_EVENT = "farreo:advanced-cover-sync-change";
export const DEFAULT_ADVANCED_COVER_SYNC = true;

export function getAdvancedCoverSyncEnabled() {
  if (typeof window === "undefined") return DEFAULT_ADVANCED_COVER_SYNC;

  try {
    const stored = window.localStorage.getItem(ADVANCED_COVER_SYNC_STORAGE_KEY);
    if (stored === "off") return false;
    if (stored === "on") return true;
    return DEFAULT_ADVANCED_COVER_SYNC;
  } catch {
    return DEFAULT_ADVANCED_COVER_SYNC;
  }
}

export function setAdvancedCoverSyncEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      ADVANCED_COVER_SYNC_STORAGE_KEY,
      enabled ? "on" : "off",
    );
  } catch {
    // The current tab still receives the event even if storage is unavailable.
  }

  window.dispatchEvent(new CustomEvent<boolean>(
    ADVANCED_COVER_SYNC_CHANGE_EVENT,
    { detail: enabled },
  ));
}
