"use client";

import { useCallback, useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { hideSong, listHiddenSongIds, unhideSong } from "@/lib/hiddenSongs";

const ADMIN_EMAILS = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

export interface UseHiddenSongs {
  isAdmin: boolean;
  hiddenIds: Set<string>;
  loading: boolean;
  /** True if a non-admin should be able to see this song. Admins always do. */
  isVisible: (songId: string) => boolean;
  hide: (songId: string) => Promise<void>;
  unhide: (songId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Hidden songs are intentionally NOT observed with an onSnapshot listener.
 * The old realtime listener created a fresh Firestore subscription in every
 * mounted consumer. A shared read-through cache in hiddenSongs.ts is enough
 * for Farreo and avoids background/reconnection reads.
 */
export function useHiddenSongs(): UseHiddenSongs {
  const [isAdmin, setIsAdmin] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (force = false) => {
    try {
      const ids = await listHiddenSongIds(force);
      setHiddenIds(new Set(ids));
    } catch {
      // Keep whatever we already had if Firestore is temporarily unavailable.
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    let active = true;
    void listHiddenSongIds()
      .then((ids) => {
        if (active) setHiddenIds(new Set(ids));
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });

    const unsubscribeAuth = auth
      ? onAuthStateChanged(auth, (user) => {
        const email = user?.email?.trim().toLowerCase() || "";
        setIsAdmin(Boolean(email && ADMIN_EMAILS.includes(email)));
      })
      : () => undefined;

    // Refresh when the user returns to the app, but only when the shared cache
    // has expired. This gives other users' hide/unhide changes a natural sync
    // point without keeping a paid realtime listener open all day.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      active = false;
      unsubscribeAuth();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const isVisible = useCallback(
    (songId: string) => isAdmin || !hiddenIds.has(songId),
    [isAdmin, hiddenIds],
  );

  const hide = useCallback(async (songId: string) => {
    await hideSong(songId, auth?.currentUser?.email);
    setHiddenIds((prev) => new Set(prev).add(songId));
  }, []);

  const unhide = useCallback(async (songId: string) => {
    await unhideSong(songId);
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.delete(songId);
      return next;
    });
  }, []);

  return { isAdmin, hiddenIds, loading, isVisible, hide, unhide, refresh };
}
