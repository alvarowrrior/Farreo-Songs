"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { useMusicPlayer } from "@/components/MusicPlayerProvider";
import { MUSIC_API_URL } from "@/lib/radioApi";
import {
  DEFAULT_YOUTUBE_RADIO_BACKGROUND_ENABLED,
  DEFAULT_YOUTUBE_VIDEO_BACKGROUND_ENABLED,
  YOUTUBE_RADIO_BACKGROUND_CHANGE_EVENT,
  YOUTUBE_RADIO_BACKGROUND_STORAGE_KEY,
  YOUTUBE_VIDEO_BACKGROUND_CHANGE_EVENT,
  YOUTUBE_VIDEO_BACKGROUND_STORAGE_KEY,
  getYoutubeRadioBackgroundEnabled,
  getYoutubeVideoBackgroundEnabled,
  isYoutubeVideoBackgroundContext,
  setYoutubeVideoBackgroundEnabled,
} from "@/lib/youtubeVideoBackgroundPreference";
import styles from "./DesktopYoutubeVideoToggle.module.scss";

export default function DesktopYoutubeVideoToggle() {
  const pathname = usePathname();
  const {
    currentSource,
    currentTrack,
    playerMode,
  } = useMusicPlayer();

  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [enabled, setEnabled] = useState(
    DEFAULT_YOUTUBE_VIDEO_BACKGROUND_ENABLED,
  );
  const [isDesktop, setIsDesktop] = useState(false);
  const [radioEnabled, setRadioEnabled] = useState(
    DEFAULT_YOUTUBE_RADIO_BACKGROUND_ENABLED,
  );

  const contextActive = isYoutubeVideoBackgroundContext(
    pathname,
    currentSource,
    playerMode,
  );

  useEffect(() => {
    const findTarget = () => {
      setTarget(
        document.querySelector<HTMLElement>(
          ".playlist-admin__now-playing-pitch-row",
        ),
      );
    };

    findTarget();
    const observer = new MutationObserver(findTarget);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 760px)");
    const refresh = () => setIsDesktop(media.matches);
    refresh();
    media.addEventListener("change", refresh);
    return () => media.removeEventListener("change", refresh);
  }, []);

  useEffect(() => {
    const refresh = () => setRadioEnabled(getYoutubeRadioBackgroundEnabled());
    const onStorage = (event: StorageEvent) => {
      if (event.key === YOUTUBE_RADIO_BACKGROUND_STORAGE_KEY) refresh();
    };

    refresh();
    window.addEventListener(YOUTUBE_RADIO_BACKGROUND_CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener(YOUTUBE_RADIO_BACKGROUND_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    const refresh = () => setEnabled(getYoutubeVideoBackgroundEnabled());
    const onStorage = (event: StorageEvent) => {
      if (event.key === YOUTUBE_VIDEO_BACKGROUND_STORAGE_KEY) refresh();
    };

    refresh();
    window.addEventListener(YOUTUBE_VIDEO_BACKGROUND_CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener(YOUTUBE_VIDEO_BACKGROUND_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    let active = true;
    setHasVideo(false);

    if (
      !isDesktop
      || !contextActive
      || (playerMode === "radio" && !radioEnabled)
      || !currentTrack?.id
    ) return () => {
      active = false;
    };

    fetch(
      `${MUSIC_API_URL}/youtube-backgrounds/${encodeURIComponent(currentTrack.id)}`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ youtubeUrl?: string | null }>;
      })
      .then((data) => {
        if (active) setHasVideo(Boolean(data?.youtubeUrl));
      })
      .catch(() => {
        if (active) setHasVideo(false);
      });

    return () => {
      active = false;
    };
  }, [
    contextActive,
    currentTrack?.id,
    isDesktop,
    playerMode,
    radioEnabled,
  ]);

  if (
    !target
    || !isDesktop
    || !contextActive
    || (playerMode === "radio" && !radioEnabled)
    || !hasVideo
  ) return null;

  return createPortal(
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={`${styles.switch} ${enabled ? styles.switchOn : ""}`}
      onClick={() => {
        const next = !enabled;
        setEnabled(next);
        setYoutubeVideoBackgroundEnabled(next);
      }}
      title={enabled
        ? "Videoclip de fondo activado"
        : "Videoclip de fondo desactivado"}
    >
      <span aria-hidden="true" />
    </button>,
    target,
  );
}
