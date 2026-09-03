"use client";

import { useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  PauseIcon,
  PlayIcon,
  RadioIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon,
} from "lucide-react";
import SongArtwork from "@/components/SongArtwork";
import {
  useMusicPlayer,
  useMusicPlayerTime,
  type MusicPlaylistSource,
  type MusicTrack,
} from "@/components/MusicPlayerProvider";
import styles from "./DesktopRadioClientLayer.module.scss";

const PLAYER_STORAGE_KEY = "farreo-player-state";
const LOCAL_BACKUP_KEY = "farreo-radio-local-player-backup-v1";

type LocalPlayerSnapshot = {
  currentTrack: MusicTrack | null;
  queue: MusicTrack[];
  queueSource: MusicPlaylistSource | null;
  currentSource: MusicPlaylistSource | null;
  currentTime: number;
  duration: number;
  playbackPitch: number;
  volume: number;
  lastNonZeroVolume?: number;
  isShuffle: boolean;
  autoRandomPitch: boolean;
  lyricsEnabled: boolean;
};

const formatTime = (seconds?: number | null) => {
  const safe = Number.isFinite(seconds) ? Math.max(0, Number(seconds)) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
};

const sourceHref = (source: MusicPlaylistSource | null) => {
  if (!source) return null;
  if (source.type === "global") return `/playlist/${encodeURIComponent(source.id)}`;
  if (source.type === "private") return `/user-playlist/${encodeURIComponent(source.id)}`;
  if (source.type === "album") return `/album/${encodeURIComponent(source.id)}`;
  return null;
};

function readStoredPlayerState() {
  if (typeof window === "undefined") return {} as Partial<LocalPlayerSnapshot>;
  try {
    return JSON.parse(window.localStorage.getItem(PLAYER_STORAGE_KEY) || "{}") as Partial<LocalPlayerSnapshot>;
  } catch {
    return {} as Partial<LocalPlayerSnapshot>;
  }
}

function readBackup() {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(window.sessionStorage.getItem(LOCAL_BACKUP_KEY) || "null") as LocalPlayerSnapshot | null;
  } catch {
    return null;
  }
}

function writeBackup(snapshot: LocalPlayerSnapshot) {
  try {
    window.sessionStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(snapshot));
  } catch {
    // The in-memory React snapshot still keeps the UI usable.
  }
}

function clearBackup() {
  try {
    window.sessionStorage.removeItem(LOCAL_BACKUP_KEY);
  } catch {
    // no-op
  }
}

function StaticLocalProgress({ snapshot }: { snapshot: LocalPlayerSnapshot }) {
  const duration = Math.max(0, snapshot.duration || snapshot.currentTrack?.duration || 0);
  const position = Math.min(duration || snapshot.currentTime, Math.max(0, snapshot.currentTime || 0));
  const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <div className="playlist-admin__progress">
      <span className="playlist-admin__progress-time">{formatTime(position)}</span>
      <div className={styles.localProgressTrack} aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="playlist-admin__progress-time">{formatTime(duration)}</span>
    </div>
  );
}

function RadioIslandProgress() {
  const { duration, radioState } = useMusicPlayer();
  const { visualCurrentTime } = useMusicPlayerTime();
  const liveDuration = Math.max(0, duration || radioState?.currentItem?.song.duration || 0);
  const livePosition = Math.min(liveDuration || visualCurrentTime, Math.max(0, visualCurrentTime));
  const percent = liveDuration > 0 ? Math.min(100, (livePosition / liveDuration) * 100) : 0;

  return (
    <div className={styles.radioProgress}>
      <span>{formatTime(livePosition)}</span>
      <div><span style={{ width: `${percent}%` }} /></div>
      <span>{formatTime(liveDuration)}</span>
    </div>
  );
}

export default function DesktopRadioClientLayer() {
  const pathname = usePathname();
  const {
    autoRandomPitch,
    currentSource,
    currentTrack,
    disableRadioMode,
    duration,
    handlePitchChange,
    handleSeek,
    handleVolumeChange,
    isPlaying,
    isRadioAwaitingUserGesture,
    isRadioBuffering,
    isShuffle,
    lyricsEnabled,
    playbackPitch,
    playerMode,
    radioState,
    setAutoRandomPitch,
    setIsShuffle,
    setLyricsEnabled,
    togglePlayPause,
    toggleTrack,
    volume,
  } = useMusicPlayer();

  const previousModeRef = useRef(playerMode);
  const lastLocalRef = useRef({
    currentTrack,
    currentSource,
    duration,
    playbackPitch,
    volume,
    isShuffle,
    autoRandomPitch,
    lyricsEnabled,
  });
  const [localSnapshot, setLocalSnapshot] = useState<LocalPlayerSnapshot | null>(() => (
    typeof window === "undefined" ? null : readBackup()
  ));

  const isDesktop = !pathname.startsWith("/mobile") && !pathname.startsWith("/admin");
  const islandVisible = isDesktop && playerMode === "radio" && !pathname.startsWith("/radio");

  if (playerMode === "local") {
    lastLocalRef.current = {
      currentTrack,
      currentSource,
      duration,
      playbackPitch,
      volume,
      isShuffle,
      autoRandomPitch,
      lyricsEnabled,
    };
  }

  useLayoutEffect(() => {
    if (!isDesktop) {
      document.documentElement.classList.remove(styles.radioStyleMarker);
      delete document.documentElement.dataset.farreoRadioClient;
      delete document.documentElement.dataset.farreoRadioIsland;
      return;
    }

    // The local CSS-module class lives on <html> so selectors can legally
    // target Farreo's global layout while remaining "pure" for Next/css-loader.
    document.documentElement.classList.add(styles.radioStyleMarker);

    if (playerMode === "radio") {
      document.documentElement.dataset.farreoRadioClient = "true";
      if (islandVisible) document.documentElement.dataset.farreoRadioIsland = "true";
      else delete document.documentElement.dataset.farreoRadioIsland;
    } else {
      delete document.documentElement.dataset.farreoRadioClient;
      delete document.documentElement.dataset.farreoRadioIsland;
    }

    return () => {
      document.documentElement.classList.remove(styles.radioStyleMarker);
      delete document.documentElement.dataset.farreoRadioIsland;
    };
  }, [isDesktop, islandVisible, playerMode]);

  useLayoutEffect(() => {
    const previousMode = previousModeRef.current;
    previousModeRef.current = playerMode;

    if (!isDesktop) return;

    if (previousMode === "local" && playerMode === "radio") {
      const stored = readStoredPlayerState();
      const live = lastLocalRef.current;
      const snapshot: LocalPlayerSnapshot = {
        currentTrack: live.currentTrack,
        queue: Array.isArray(stored.queue) ? stored.queue : [],
        queueSource: stored.queueSource ?? null,
        currentSource: live.currentSource,
        currentTime: typeof stored.currentTime === "number" ? stored.currentTime : 0,
        duration: live.duration || live.currentTrack?.duration || 0,
        playbackPitch: live.playbackPitch,
        volume: live.volume,
        lastNonZeroVolume: typeof stored.lastNonZeroVolume === "number"
          ? stored.lastNonZeroVolume
          : live.volume || 0.8,
        isShuffle: live.isShuffle,
        autoRandomPitch: live.autoRandomPitch,
        lyricsEnabled: live.lyricsEnabled,
      };
      writeBackup(snapshot);
      setLocalSnapshot(snapshot);
      return;
    }

    if (previousMode === "radio" && playerMode === "local") {
      clearBackup();
      setLocalSnapshot(null);
    }
  }, [isDesktop, playerMode]);

  const restoreStoredSnapshotForReload = () => {
    const snapshot = localSnapshot || readBackup();
    if (!snapshot) {
      try {
        window.localStorage.removeItem(PLAYER_STORAGE_KEY);
      } catch {
        // no-op
      }
      return;
    }

    try {
      window.localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify({
        currentTrack: snapshot.currentTrack,
        queue: snapshot.queue,
        queueSource: snapshot.queueSource,
        currentSource: snapshot.currentSource,
        currentTime: snapshot.currentTime,
        playbackPitch: snapshot.playbackPitch,
        volume: snapshot.volume,
        lastNonZeroVolume: snapshot.lastNonZeroVolume ?? snapshot.volume ?? 0.8,
        isShuffle: snapshot.isShuffle,
        autoRandomPitch: snapshot.autoRandomPitch,
        lyricsEnabled: snapshot.lyricsEnabled,
      }));
    } catch {
      // Provider will simply come back empty if storage is unavailable.
    }
  };

  const disconnectOnly = () => {
    restoreStoredSnapshotForReload();
    clearBackup();
    disableRadioMode();

    // The provider currently reuses the physical audio element for local and
    // radio playback. Reloading after restoring its own persisted local state
    // is the only way to return the exact previous local player PAUSED without
    // briefly starting it. No radio endpoint is called here.
    window.location.reload();
  };

  const resumeLocalPlayer = () => {
    const snapshot = localSnapshot || readBackup();
    if (!snapshot?.currentTrack) return;

    const queue = snapshot.queue.length > 0
      ? snapshot.queue.map((track) => (
          track.id === snapshot.currentTrack?.id ? snapshot.currentTrack : track
        ))
      : [snapshot.currentTrack];

    const target = snapshot.currentTrack;

    // toggleTrack already disconnects radio before starting local playback.
    // Keeping this direct user gesture avoids browser autoplay restrictions.
    toggleTrack(target, queue, snapshot.currentSource);

    window.setTimeout(() => {
      setAutoRandomPitch(snapshot.autoRandomPitch);
      setIsShuffle(snapshot.isShuffle);
      setLyricsEnabled(snapshot.lyricsEnabled);
      handleVolumeChange(snapshot.volume);
      handlePitchChange(snapshot.playbackPitch);
      if (snapshot.currentTime > 0) handleSeek(snapshot.currentTime);
      clearBackup();
    }, 140);
  };

  if (!isDesktop || playerMode !== "radio") return null;

  const serverPlaying = radioState?.status === "playing";
  const radioTitle = currentTrack?.name || radioState?.currentItem?.song.name || "Radio vacía";
  const radioSource = radioState?.currentItem?.source.name || currentSource?.name?.replace(/^Radio\s*-\s*/i, "") || "Farreo Radio";

  return (
    <>
      {islandVisible ? (
        <section className={styles.island} aria-label="Reproductor de radio">
          <Link href="/radio" className={styles.radioBadge} title="Abrir Radio">
            <RadioIcon size={18} />
          </Link>

          <SongArtwork
            src={currentTrack?.iconUrl || radioState?.currentItem?.song.iconUrl}
            alt={radioTitle}
            className={styles.artwork}
            sizes="54px"
            eager
          />

          <div className={styles.copy}>
            <span>RADIO</span>
            <strong>{radioTitle}</strong>
            <small>
              {isRadioBuffering
                ? "Sincronizando…"
                : isRadioAwaitingUserGesture
                  ? "Pulsa play para unirte"
                  : radioSource}
            </small>
          </div>

          <div className={styles.center}>
            <button
              type="button"
              className={styles.play}
              onClick={togglePlayPause}
              title={
                isRadioAwaitingUserGesture
                  ? "Unirme al directo"
                  : serverPlaying && isPlaying
                    ? "Pausar la radio"
                    : "Reproducir la radio"
              }
            >
              {serverPlaying && isPlaying
                ? <PauseIcon size={18} fill="currentColor" />
                : <PlayIcon size={18} fill="currentColor" />}
            </button>
            <RadioIslandProgress />
          </div>

          <div className={styles.volume}>
            <button
              type="button"
              onClick={() => handleVolumeChange(volume > 0 ? 0 : (localSnapshot?.lastNonZeroVolume || 0.8))}
              title={volume > 0 ? "Silenciar este cliente" : "Restaurar volumen"}
            >
              {volume > 0 ? <Volume2Icon size={16} /> : <VolumeXIcon size={16} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(event) => handleVolumeChange(Number(event.target.value))}
              aria-label="Volumen de la radio"
            />
          </div>

          <button
            type="button"
            className={styles.close}
            onClick={disconnectOnly}
            title="Desconectarme de la radio"
            aria-label="Salir de la radio en este dispositivo"
          >
            <XIcon size={16} />
          </button>
        </section>
      ) : null}

      {islandVisible ? (
      <div className={`playlist-admin__player farreo-radio-local-snapshot ${styles.localSnapshot}`}>
          <div className="playlist-admin__now-playing">
            {localSnapshot?.currentTrack ? (
              <div className="playlist-admin__now-playing-inner">
                <SongArtwork
                  src={localSnapshot.currentTrack.iconUrl}
                  alt={localSnapshot.currentTrack.name}
                  className="playlist-admin__now-playing-artwork"
                />
                <div className="playlist-admin__now-playing-text">
                  <span className="playlist-admin__now-playing-title">{localSnapshot.currentTrack.name}</span>
                  {localSnapshot.currentSource ? (
                    sourceHref(localSnapshot.currentSource) ? (
                      <Link
                        href={sourceHref(localSnapshot.currentSource)!}
                        className="playlist-admin__now-playing-source playlist-admin__now-playing-source--link"
                      >
                        {localSnapshot.currentSource.name}
                      </Link>
                    ) : (
                      <span className="playlist-admin__now-playing-source">{localSnapshot.currentSource.name}</span>
                    )
                  ) : null}
                  <span className={styles.pausedByRadio}>Pausado mientras escuchas la radio</span>
                </div>
              </div>
            ) : (
              <span className="playlist-admin__now-playing-title" style={{ color: "#666" }}>Sin canción local</span>
            )}
          </div>
  
          <div className="playlist-admin__player-center">
            <div className="playlist-admin__player-buttons">
              <button className="playlist-admin__control-btn" disabled title="Desconéctate de la radio para usar anterior">
                ‹
              </button>
              <button
                type="button"
                className="playlist-admin__control-btn playlist-admin__control-btn--play"
                onClick={resumeLocalPlayer}
                disabled={!localSnapshot?.currentTrack}
                title="Reanudar este reproductor y desconectarme de la radio"
              >
                <PlayIcon size={16} fill="currentColor" />
              </button>
              <button className="playlist-admin__control-btn" disabled title="Desconéctate de la radio para usar siguiente">
                ›
              </button>
            </div>
            {localSnapshot ? <StaticLocalProgress snapshot={localSnapshot} /> : null}
          </div>
  
          <div className={`playlist-admin__player-right ${styles.localRight}`}>
            {localSnapshot ? (
              <>
                <span>Pitch {localSnapshot.playbackPitch.toFixed(2)}x</span>
                <span>Vol. {Math.round(localSnapshot.volume * 100)}%</span>
              </>
            ) : null}
          </div>
        </div>
        ) : null}
    </>
  );
}
