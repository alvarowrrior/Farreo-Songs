"use client";

import { useLayoutEffect } from "react";
import { auth } from "@/lib/firebase";
import { MUSIC_API_URL } from "@/lib/radioApi";

const VISITOR_STORAGE_KEY = "farreo-album-visitor-token";
const STATIC_PREFIXES = [
  "/audio/",
  "/lyrics/",
  "/playlist-icons/",
  "/private-playlist-icons/",
  "/album-icons/",
  "/song-icons/",
  "/song-icon/",
  "/song-advanced-covers/",
];

let visitorRequest: Promise<string | null> | null = null;

function backendApiUrl(value: string) {
  try {
    const api = new URL(MUSIC_API_URL);
    const url = new URL(value, window.location.href);
    if (url.origin !== api.origin) return null;
    if (STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return null;
    return url;
  } catch {
    return null;
  }
}

async function getVisitorToken(originalFetch: typeof window.fetch) {
  const existing = window.localStorage.getItem(VISITOR_STORAGE_KEY);
  if (existing) return existing;
  if (visitorRequest) return visitorRequest;

  visitorRequest = originalFetch(`${MUSIC_API_URL}/album-session`, { method: "POST" })
    .then(async (response) => {
      const data = await response.json().catch(() => ({})) as { token?: string };
      if (!response.ok || !data.token) return null;
      window.localStorage.setItem(VISITOR_STORAGE_KEY, data.token);
      return data.token;
    })
    .catch(() => null)
    .finally(() => {
      visitorRequest = null;
    });

  return visitorRequest;
}

/**
 * Legacy Farreo components call the Linux API with raw fetch(). Instead of
 * teaching every component about Firebase tokens, this bridge adds the token
 * only to API requests for the Farreo backend. Static audio/artwork requests
 * are deliberately left untouched.
 */
export default function BackendAuthBridge() {
  useLayoutEffect(() => {
    const originalFetch = window.fetch.bind(window);

    const patchedFetch: typeof window.fetch = async (input, init) => {
      const inputUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const apiUrl = backendApiUrl(inputUrl);
      if (!apiUrl || apiUrl.pathname === "/album-session") {
        return originalFetch(input, init);
      }

      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      }

      if (!headers.has("Authorization") && !headers.has("X-Farreo-Visitor-Token")) {
        const user = auth?.currentUser;
        if (user) {
          headers.set("Authorization", `Bearer ${await user.getIdToken()}`);
        } else {
          const visitor = await getVisitorToken(originalFetch);
          if (visitor) headers.set("X-Farreo-Visitor-Token", visitor);
        }
      }

      if (input instanceof Request) {
        return originalFetch(new Request(input, { ...init, headers }));
      }
      return originalFetch(input, { ...init, headers });
    };

    window.fetch = patchedFetch;
    return () => {
      if (window.fetch === patchedFetch) window.fetch = originalFetch;
    };
  }, []);

  return null;
}
