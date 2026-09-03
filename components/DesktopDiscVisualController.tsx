"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import AlbumDiscBackdrop from "@/components/AlbumDiscBackdrop";
import { useMusicPlayer } from "@/components/MusicPlayerProvider";
import SongArtwork from "@/components/SongArtwork";
import {
  DEFAULT_DISC_VISUAL_MODE,
  DISC_VISUAL_CHANGE_EVENT,
  DISC_VISUAL_STORAGE_KEY,
  getDiscVisualMode,
  isDiscVisualMode,
  type DiscVisualMode,
} from "@/lib/discVisualPreference";
import styles from "./DesktopDiscVisualController.module.scss";

const decodeRouteSegment = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const routeIdAfter = (pathname: string, prefix: string) => {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).split("/")[0] || "";
  return rest ? decodeRouteSegment(rest) : null;
};

export default function DesktopDiscVisualController() {
  const pathname = usePathname();
  const {
    currentSource,
    currentTrack,
    isPlaying,
    playerMode,
    radioState,
  } = useMusicPlayer();

  const [mode, setMode] = useState<DiscVisualMode>(DEFAULT_DISC_VISUAL_MODE);
  const [backgroundHost, setBackgroundHost] = useState<HTMLElement | null>(null);
  const [radioTitleHost, setRadioTitleHost] = useState<HTMLElement | null>(null);

  const isDesktop = !pathname.startsWith("/mobile") && !pathname.startsWith("/admin");

  const albumRouteId = routeIdAfter(pathname, "/album/");
  const globalPlaylistId = routeIdAfter(pathname, "/playlist/");
  const privatePlaylistId = routeIdAfter(pathname, "/user-playlist/");
  const recommendationToken = routeIdAfter(pathname, "/recommendation/");

  const inMatchingGlobalPlaylist = Boolean(
    mode === "always"
    && globalPlaylistId
    && currentTrack
    && currentSource?.type === "global"
    && currentSource.id === globalPlaylistId,
  );

  const inMatchingPrivatePlaylist = Boolean(
    mode === "always"
    && privatePlaylistId
    && currentTrack
    && currentSource?.type === "private"
    && currentSource.id === privatePlaylistId,
  );

  const inMatchingWeeklySelection = Boolean(
    mode === "always"
    && recommendationToken
    && currentTrack
    && currentSource?.type === "song"
    && currentSource.id === `recommendation:${recommendationToken}`,
  );

  const showBackgroundDisc = Boolean(
    isDesktop
    && (inMatchingGlobalPlaylist || inMatchingPrivatePlaylist || inMatchingWeeklySelection),
  );

  const showRadioMiniDisc = Boolean(
    isDesktop
    && mode === "always"
    && pathname.startsWith("/radio")
    && playerMode === "radio"
    && currentTrack,
  );

  useEffect(() => {
    setMode(getDiscVisualMode());

    const onPreference = (event: Event) => {
      const next = (event as CustomEvent<DiscVisualMode>).detail;
      if (isDiscVisualMode(next)) setMode(next);
      else setMode(getDiscVisualMode());
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === DISC_VISUAL_STORAGE_KEY) setMode(getDiscVisualMode());
    };

    window.addEventListener(DISC_VISUAL_CHANGE_EVENT, onPreference);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DISC_VISUAL_CHANGE_EVENT, onPreference);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useLayoutEffect(() => {
    if (!isDesktop) {
      delete document.documentElement.dataset.farreoDiscMode;
      delete document.documentElement.dataset.farreoDiscController;
      setBackgroundHost(null);
      setRadioTitleHost(null);
      return;
    }

    document.documentElement.dataset.farreoDiscMode = mode;

    if (showBackgroundDisc) {
      document.documentElement.dataset.farreoDiscController = "background";
      setBackgroundHost(document.querySelector<HTMLElement>(".app-main .playlist-admin"));
    } else {
      delete document.documentElement.dataset.farreoDiscController;
      setBackgroundHost(null);
    }

    if (showRadioMiniDisc) {
      setRadioTitleHost(document.querySelector<HTMLElement>(".radio-page__title"));
    } else {
      setRadioTitleHost(null);
    }

    return () => {
      delete document.documentElement.dataset.farreoDiscController;
    };
  }, [isDesktop, mode, pathname, showBackgroundDisc, showRadioMiniDisc]);

  return (
    <>
      {showBackgroundDisc && backgroundHost && currentTrack ? createPortal(
        <AlbumDiscBackdrop
          artworkUrl={currentTrack.iconUrl}
          isPlaying={isPlaying}
          visible
        />,
        backgroundHost,
      ) : null}

      {showRadioMiniDisc && radioTitleHost && currentTrack ? createPortal(
        <span
          className={styles.radioMiniDisc}
          data-playing={radioState?.status === "playing" ? "true" : "false"}
          title={currentTrack.name}
          aria-label={`Disco de ${currentTrack.name}`}
        >
          <SongArtwork
            src={currentTrack.iconUrl}
            alt=""
            className={styles.radioMiniArtwork}
            sizes="30px"
            eager
          />
          <i aria-hidden="true" />
        </span>,
        radioTitleHost,
      ) : null}

    </>
  );
}
