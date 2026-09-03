"use client";

import { useEffect } from "react";
import { useMusicPlayer } from "@/components/MusicPlayerProvider";
import { getFarreoNativeAudio } from "@/lib/nativeAudio";

/**
 * The mobile playlist row used to route a tap on the currently playing song
 * back through playTracks(), which reloads the queue and intentionally shows
 * "Preparando audio...". For the active row the intended action is just a
 * play/pause toggle, so intercept it before React's playlist-row handler.
 */
export default function MobileCurrentTrackClickFix() {
  const { togglePlayPause } = useMusicPlayer();

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const row = event.target.closest<HTMLElement>(
        ".mobile-farreo__song-row--playlist.mobile-farreo__song-row--current",
      );
      if (!row) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const native = getFarreoNativeAudio();
      if (!native) {
        togglePlayPause();
        return;
      }

      void native.getState()
        .then((state) => state.isPlaying ? native.pause() : native.play())
        .catch(() => {
          // Web fallback keeps the control usable if the native bridge happens
          // to be unavailable during a WebView lifecycle transition.
          togglePlayPause();
        });
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [togglePlayPause]);

  return null;
}
