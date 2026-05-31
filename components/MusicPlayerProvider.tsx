"use client";

import { createContext, useCallback, useContext, useRef, useState, useEffect, type ReactNode } from "react";
import { ArrowRightIcon, DicesIcon, PauseIcon, PlayIcon, ShuffleIcon, SkipBackIcon, SkipForwardIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { usePathname } from "next/navigation";

export interface MusicTrack {
  id: string;
  name: string;
  url?: string;
  variantes?: string[];
}

export interface MusicPlaylistSource {
  id: string;
  name: string;
  type: "global" | "private" | "song" | "admin";
}

interface MusicPlayerContextValue {
  currentTrack: MusicTrack | null;
  currentSource: MusicPlaylistSource | null;
  isPlaying: boolean;
  playbackPitch: number;
  volume: number;
  currentTime: number;
  duration: number;
  isShuffle: boolean;
  autoRandomPitch: boolean;
  loadQueue: (tracks: MusicTrack[], source?: MusicPlaylistSource | null) => void;
  playQueue: (tracks: MusicTrack[], index: number, source?: MusicPlaylistSource | null) => void;
  toggleTrack: (track: MusicTrack, tracks?: MusicTrack[], source?: MusicPlaylistSource | null) => void;
  playNext: () => void;
  playPrev: () => void;
  togglePlayPause: () => void;
  handleVolumeChange: (val: number) => void;
  handlePitchChange: (val: number) => void;
  handleSeek: (val: number) => void;
  setAutoRandomPitch: (val: boolean | ((prev: boolean) => boolean)) => void;
  setIsShuffle: (val: boolean | ((prev: boolean) => boolean)) => void;
  stop: () => void;
}

const MusicPlayerContext = createContext<MusicPlayerContextValue | null>(null);
const STORAGE_KEY = "farreo-player-state";

interface StoredPlayerState {
  currentTrack: MusicTrack | null;
  queue: MusicTrack[];
  queueSource: MusicPlaylistSource | null;
  currentSource: MusicPlaylistSource | null;
  currentTime: number;
  playbackPitch: number;
  volume: number;
  isShuffle: boolean;
  autoRandomPitch: boolean;
}

export function useMusicPlayer() {
  const context = useContext(MusicPlayerContext);
  if (!context) {
    throw new Error("useMusicPlayer debe usarse dentro de MusicPlayerProvider");
  }
  return context;
}

const formatTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? "0" : ""}${sec}`;
};

export default function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hasRestoredRef = useRef(false);
  const [storageReady, setStorageReady] = useState(false);
  const [queue, setQueue] = useState<MusicTrack[]>([]);
  const [queueSource, setQueueSource] = useState<MusicPlaylistSource | null>(null);
  const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null);
  const [currentSource, setCurrentSource] = useState<MusicPlaylistSource | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPitch, setPlaybackPitch] = useState(1);
  const [volume, setVolume] = useState(0.8);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isShuffle, setIsShuffle] = useState(true);
  const [autoRandomPitch, setAutoRandomPitch] = useState(true);
  const [history, setHistory] = useState<MusicTrack[]>([]);

  const startTrack = (track: MusicTrack, source = queueSource) => {
    if (!track.url) return;

    let pitch = playbackPitch;
    if (autoRandomPitch) {
      pitch = Math.random() * (1.2 - 0.8) + 0.8;
      setPlaybackPitch(pitch);
    }

    setCurrentTrack(track);
    setCurrentSource(source);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(true);
    setTimeout(() => {
      if (!audioRef.current) return;
      audioRef.current.preservesPitch = false;
      audioRef.current.playbackRate = pitch;
      audioRef.current.volume = volume;
      audioRef.current.play().catch(() => setIsPlaying(false));
    }, 50);
  };

  const playQueue = (tracks: MusicTrack[], index: number, source?: MusicPlaylistSource | null) => {
    const track = tracks[index];
    if (!track) return;
    setQueue(tracks);
    setQueueSource(source ?? null);
    setHistory([]);
    startTrack(track, source ?? null);
  };

  const loadQueue = useCallback((tracks: MusicTrack[], source?: MusicPlaylistSource | null) => {
    setQueue(tracks);
    setQueueSource(source ?? null);
    setHistory([]);
  }, []);

  const toggleTrack = (track: MusicTrack, tracks?: MusicTrack[], source?: MusicPlaylistSource | null) => {
    if (tracks) {
      setQueue(tracks);
      setQueueSource(source ?? null);
    }

    if (currentTrack?.id === track.id) {
      if (!audioRef.current) return;
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play().catch(() => setIsPlaying(false));
      }
      setIsPlaying(!isPlaying);
      return;
    }

    setHistory([]);
    startTrack(track, source ?? queueSource);
  };

  const playNext = () => {
    if (queue.length === 0) return;
    
    if (currentTrack) {
      setHistory((prev) => [...prev, currentTrack]);
    }

    if (isShuffle) {
      let nextIndex = Math.floor(Math.random() * queue.length);
      if (queue.length > 1 && currentTrack) {
        while (queue[nextIndex].id === currentTrack.id) {
          nextIndex = Math.floor(Math.random() * queue.length);
        }
      }
      startTrack(queue[nextIndex], queueSource);
      return;
    }

    if (!currentTrack) {
      startTrack(queue[0], queueSource);
      return;
    }

    const idx = queue.findIndex((track) => track.id === currentTrack.id);
    startTrack(queue[(idx + 1) % queue.length], queueSource);
  };

  const playPrev = () => {
    if (queue.length === 0) return;

    if (history.length > 0) {
      const prevTrack = history[history.length - 1];
      setHistory((prev) => prev.slice(0, -1));
      startTrack(prevTrack, currentSource);
      return;
    }

    if (!currentTrack) {
      startTrack(queue[queue.length - 1], queueSource);
      return;
    }

    const idx = queue.findIndex((track) => track.id === currentTrack.id);
    startTrack(queue[(idx - 1 + queue.length) % queue.length], queueSource);
  };

  const togglePlayPause = () => {
    if (!currentTrack && queue.length > 0) {
      const startIndex = isShuffle ? Math.floor(Math.random() * queue.length) : 0;
      startTrack(queue[startIndex], queueSource);
      return;
    }

    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(() => setIsPlaying(false));
    }
    setIsPlaying(!isPlaying);
  };

  const handleVolumeChange = (val: number) => {
    setVolume(val);
    if (audioRef.current) audioRef.current.volume = val;
  };

  const handlePitchChange = (val: number) => {
    setPlaybackPitch(val);
    if (audioRef.current) {
      audioRef.current.preservesPitch = false;
      audioRef.current.playbackRate = val;
    }
  };

  const handleSeek = (val: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = val;
      setCurrentTime(val);
    }
  };

  const stop = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setCurrentTrack(null);
    setCurrentSource(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  };

  useEffect(() => {
    if (typeof window === "undefined" || hasRestoredRef.current) return;
    hasRestoredRef.current = true;

    try {
      const rawState = window.localStorage.getItem(STORAGE_KEY);
      if (!rawState) {
        setStorageReady(true);
        return;
      }
      const state = JSON.parse(rawState) as Partial<StoredPlayerState>;

      setQueue(Array.isArray(state.queue) ? state.queue : []);
      setQueueSource(state.queueSource ?? null);
      setCurrentTrack(state.currentTrack ?? null);
      setCurrentSource(state.currentSource ?? null);
      setCurrentTime(typeof state.currentTime === "number" ? state.currentTime : 0);
      setPlaybackPitch(typeof state.playbackPitch === "number" ? state.playbackPitch : 1);
      setVolume(typeof state.volume === "number" ? state.volume : 0.8);
      setIsShuffle(typeof state.isShuffle === "boolean" ? state.isShuffle : true);
      setAutoRandomPitch(typeof state.autoRandomPitch === "boolean" ? state.autoRandomPitch : true);
      setIsPlaying(false);
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !storageReady) return;

    const state: StoredPlayerState = {
      currentTrack,
      queue,
      queueSource,
      currentSource,
      currentTime,
      playbackPitch,
      volume,
      isShuffle,
      autoRandomPitch,
    };

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [autoRandomPitch, currentSource, currentTime, currentTrack, isShuffle, playbackPitch, queue, queueSource, storageReady, volume]);

  // Media Session API Sync
  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;

    if (currentTrack) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.name,
        artist: "Farreo",
        album: currentSource?.name || "Farreo Player",
        artwork: [
          { src: "/favicon.ico", sizes: "32x32", type: "image/x-icon" }
        ],
      });
    } else {
      navigator.mediaSession.metadata = null;
    }
  }, [currentSource, currentTrack]);

  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator) || !audioRef.current) return;
    if ("setPositionState" in navigator.mediaSession && duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: duration,
          playbackRate: playbackPitch,
          position: currentTime,
        });
      } catch (e) {
        console.error("Error setting media session position state:", e);
      }
    }
  }, [currentTime, duration, playbackPitch]);

  // Use refs to avoid re-binding handlers on state change
  const playPrevRef = useRef(playPrev);
  const playNextRef = useRef(playNext);
  const togglePlayPauseRef = useRef(togglePlayPause);
  const handleSeekRef = useRef(handleSeek);

  useEffect(() => {
    playPrevRef.current = playPrev;
    playNextRef.current = playNext;
    togglePlayPauseRef.current = togglePlayPause;
    handleSeekRef.current = handleSeek;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;

    try {
      navigator.mediaSession.setActionHandler("play", () => {
        togglePlayPauseRef.current();
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        togglePlayPauseRef.current();
      });
      navigator.mediaSession.setActionHandler("previoustrack", () => {
        playPrevRef.current();
      });
      navigator.mediaSession.setActionHandler("nexttrack", () => {
        playNextRef.current();
      });
      navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (details.seekTime !== undefined) {
          handleSeekRef.current(details.seekTime);
        }
      });
    } catch (error) {
      console.error("Error setting media session action handlers:", error);
    }

    return () => {
      if (typeof window === "undefined" || !("mediaSession" in navigator)) return;
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("previoustrack", null);
      navigator.mediaSession.setActionHandler("nexttrack", null);
      navigator.mediaSession.setActionHandler("seekto", null);
    };
  }, []);

  return (
    <MusicPlayerContext.Provider
      value={{
        currentTrack,
        currentSource,
        isPlaying,
        playbackPitch,
        volume,
        currentTime,
        duration,
        isShuffle,
        autoRandomPitch,
        loadQueue,
        playQueue,
        toggleTrack,
        playNext,
        playPrev,
        togglePlayPause,
        handleVolumeChange,
        handlePitchChange,
        handleSeek,
        setAutoRandomPitch,
        setIsShuffle,
        stop,
      }}
    >
      {children}

      {!pathname.startsWith("/admin") && (
      <div className="playlist-admin__player">
        <div className="playlist-admin__now-playing">
          {currentTrack ? (
            <>
              <span className="playlist-admin__now-playing-title">{currentTrack.name}</span>
              {currentSource && (
                <span className="playlist-admin__now-playing-source">{currentSource.name}</span>
              )}
              <span className="playlist-admin__now-playing-pitch">Pitch: {playbackPitch.toFixed(2)}x</span>
            </>
          ) : (
            <span className="playlist-admin__now-playing-title" style={{ color: "#666" }}>Sin canción</span>
          )}
        </div>

        <div className="playlist-admin__player-center">
          <div className="playlist-admin__player-buttons">
            <button
              className={`playlist-admin__control-btn playlist-admin__control-btn--shuffle ${isShuffle ? "playlist-admin__control-btn--active" : ""}`}
              onClick={() => setIsShuffle((v) => !v)}
              title={isShuffle ? "Aleatorio activado" : "En orden"}
            >
              {isShuffle ? <ShuffleIcon size={16} /> : <ArrowRightIcon size={16} />}
            </button>
            <button className="playlist-admin__control-btn" onClick={playPrev} title="Anterior"><SkipBackIcon size={16} /></button>
            <button className="playlist-admin__control-btn playlist-admin__control-btn--play" onClick={togglePlayPause} title={isPlaying ? "Pausar" : "Reproducir"}>
              {isPlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
            </button>
            <button className="playlist-admin__control-btn" onClick={playNext} title="Siguiente"><SkipForwardIcon size={16} /></button>
          </div>

          <div className="playlist-admin__progress">
            <span className="playlist-admin__progress-time">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              value={currentTime}
              onChange={(e) => handleSeek(Number(e.target.value))}
              className="playlist-admin__progress-bar"
            />
            <span className="playlist-admin__progress-time">{formatTime(duration)}</span>
          </div>
        </div>

        <div className="playlist-admin__player-right">
          <div className="playlist-admin__slider-group">
            <button
              className={`playlist-admin__control-btn playlist-admin__control-btn--pitch-toggle ${autoRandomPitch ? "playlist-admin__control-btn--active" : ""}`}
              onClick={() => setAutoRandomPitch((v) => !v)}
              title={autoRandomPitch ? "Pitch aleatorio al cambiar canción" : "Pitch fijo"}
            >
              <DicesIcon size={16} />
            </button>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.01}
              value={playbackPitch}
              onChange={(e) => handlePitchChange(Number(e.target.value))}
              className="playlist-admin__mini-slider"
              title={`Pitch: ${playbackPitch.toFixed(2)}x`}
            />
          </div>

          <div className="playlist-admin__slider-group">
            <button
              className="playlist-admin__control-btn"
              onClick={() => handleVolumeChange(volume > 0 ? 0 : 0.8)}
              title={volume > 0 ? "Silenciar" : "Restaurar volumen"}
            >
              {volume > 0 ? <Volume2Icon size={16} /> : <VolumeXIcon size={16} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              className="playlist-admin__mini-slider"
              title={`Volumen: ${Math.round(volume * 100)}%`}
            />
          </div>
        </div>

      </div>
      )}

      <audio
        ref={audioRef}
        src={currentTrack?.url || undefined}
        onEnded={playNext}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onTimeUpdate={() => {
          if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
        }}
        onLoadedMetadata={() => {
          if (!audioRef.current) return;
          setDuration(audioRef.current.duration);
          audioRef.current.volume = volume;
          audioRef.current.preservesPitch = false;
          audioRef.current.playbackRate = playbackPitch;
          if (!isPlaying && currentTime > 0 && audioRef.current.currentTime !== currentTime) {
            audioRef.current.currentTime = currentTime;
          }
        }}
        style={{ display: "none" }}
      />
    </MusicPlayerContext.Provider>
  );
}
