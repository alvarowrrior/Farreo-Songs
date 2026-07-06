"use client";

import { useCallback, useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { hideSong, listHiddenSongIds, unhideSong } from "@/lib/hiddenSongs";

const ADMIN_EMAILS = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "").split(",");

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
 * Shared hook for the "hidden songs" feature. Tracks admin state and the set
 * of hidden song ids (Firestore). Non-admins never see hidden songs; admins do.
 * If Firebase is not configured it degrades to "nothing hidden / not admin".
 */
export function useHiddenSongs(): UseHiddenSongs {
  const [isAdmin, setIsAdmin] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const ids = await listHiddenSongIds();
      setHiddenIds(new Set(ids));
    } catch {
      // Keep whatever we had; absence of data shouldn't hide everything.
    }
  }, []);

  useEffect(() => {
    let active = true;

    listHiddenSongIds()
      .then((ids) => {
        if (active) setHiddenIds(new Set(ids));
      })
      .catch(() => {
        // Keep whatever we had; absence of data shouldn't hide everything.
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    if (!auth) {
      return () => {
        active = false;
      };
    }

    const unsub = onAuthStateChanged(auth, (user) => {
      setIsAdmin(Boolean(user?.email && ADMIN_EMAILS.includes(user.email)));
    });
    return () => {
      active = false;
      unsub();
    };
  }, [refresh]);

  const isVisible = useCallback(
    (songId: string) => isAdmin || !hiddenIds.has(songId),
    [isAdmin, hiddenIds],
  );

  const hide = useCallback(async (songId: string) => {
    await hideSong(songId);
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
