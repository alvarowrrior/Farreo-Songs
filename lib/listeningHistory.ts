"use client";

import { auth } from "@/lib/firebase";

const HISTORY_PREFIX = "farreo-listening-history-v1";
const SEED_PREFIX = "farreo-recommendation-seed-v1";
const volatileSeeds = new Map<string, string>();

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
  try {
    window.localStorage.setItem(storageKey(HISTORY_PREFIX), JSON.stringify(ids.slice(-10000)));
  } catch {
    // Escuchar una cancion nunca debe fallar porque el almacenamiento local
    // este lleno o bloqueado.
  }
}

export function getRecommendationSeed() {
  if (typeof window === "undefined") return "farreo";
  const key = storageKey(SEED_PREFIX);
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
  } catch {
    // La semilla volatil mantiene estable la seleccion durante esta sesion.
  }
  const volatile = volatileSeeds.get(key);
  if (volatile) return volatile;
  const seed = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  volatileSeeds.set(key, seed);
  try {
    window.localStorage.setItem(key, seed);
  } catch {
    // Las recomendaciones pueden generarse aunque no sea posible persistir.
  }
  return seed;
}
