"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import SongInfoSidebar from "@/components/SongInfoSidebar";
import { useMusicPlayer } from "@/components/MusicPlayerProvider";
import { getYoutubeVideoWaitForReady } from "@/lib/youtubeVideoBackgroundPreference";
import { onActiveAudioPlaying } from "@/lib/queueMediaPreload";

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
  const { currentTrack, isPlaying, playerMode } = useMusicPlayer();
  const [audioReadyTrackId, setAudioReadyTrackId] = useState<string | null>(null);

  useEffect(() => {
    setAudioReadyTrackId(null);
    if (!currentTrack?.id || playerMode !== "local") return;
    return onActiveAudioPlaying(currentTrack.id, (ready) => {
      setAudioReadyTrackId(ready ? currentTrack.id : null);
    });
  }, [currentTrack?.id, playerMode]);

  useEffect(() => {
    if (!visible) return;
    const warmVisibleCover = () => {
      // A queued audio-first transition must acquire real audio data before
      // the panel forces a competing advanced-video preload and decoder.
      const audioFirst = playerMode === "local" && !getYoutubeVideoWaitForReady();
      if (audioFirst && (!isPlaying || audioReadyTrackId !== currentTrack?.id)) return;
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
  }, [visible, currentTrack?.id, isPlaying, playerMode, audioReadyTrackId]);

  return visible ? <SongInfoSidebar /> : null;
}
