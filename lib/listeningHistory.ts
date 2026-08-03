"use client";

import { auth } from "@/lib/firebase";

const HISTORY_PREFIX = "farreo-listening-history-v1";
const SEED_PREFIX = "farreo-recommendation-seed-v1";

const identity = () => auth?.currentUser?.uid || "guest";
const storageKey = (prefix: string) => `${prefix}:${identity()}`;

export function getListenedSongIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey(HISTORY_PREFIX)) || "[]");
    return Array.isArray(value) ? value.filter(item => typeof item === "string").slice(-10000) : [];
  } catch {
    return [];
  }
}

export function recordSongListened(songId?: string | null) {
  if (typeof window === "undefined" || !songId) return;
  const ids = getListenedSongIds().filter(id => id !== songId);
  ids.push(songId);
  window.localStorage.setItem(storageKey(HISTORY_PREFIX), JSON.stringify(ids.slice(-10000)));
}

export function getRecommendationSeed() {
  if (typeof window === "undefined") return "farreo";
  const key = storageKey(SEED_PREFIX);
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const seed = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  window.localStorage.setItem(key, seed);
  return seed;
}
