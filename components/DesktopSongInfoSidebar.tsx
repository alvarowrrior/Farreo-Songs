"use client";

import { useEffect, useSyncExternalStore } from "react";
import SongInfoSidebar from "@/components/SongInfoSidebar";

// The sidebar's synchronous media gate must never run on mobile, where the
// sidebar is hidden by CSS and Android owns playback independently.
const QUERY = "(min-width: 721px)";

const subscribe = (notify: () => void) => {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
const getSnapshot = () => window.matchMedia(QUERY).matches;
const getServerSnapshot = () => false;

export default function DesktopSongInfoSidebar() {
  const visible = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!visible) return;
    const warmVisibleCover = () => {
      const panel = document.querySelector(".song-info-sidebar--open");
      if (!panel) return;
      // Advanced video must be able to reach loadeddata while local audio is
      // still paused for the panel gate. Default preload=metadata deadlocks it.
      panel.querySelectorAll<HTMLVideoElement>(".song-info-sidebar__advanced-cover video")
        .forEach((video) => {
          if (video.preload === "auto") return;
          video.preload = "auto";
          video.load();
        });
      panel.querySelectorAll<HTMLImageElement>(".song-info-sidebar__advanced-cover img, .song-info-sidebar__artwork")
        .forEach((image) => { image.fetchPriority = "high"; });
    };
    const observer = new MutationObserver(warmVisibleCover);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    warmVisibleCover();
    return () => observer.disconnect();
  }, [visible]);

  return visible ? <SongInfoSidebar /> : null;
}
