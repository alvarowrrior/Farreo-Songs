"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, useEffect, type ReactNode } from "react";
import { ArrowRightIcon, DicesIcon, Mic2Icon, PauseIcon, PlayIcon, RotateCcwIcon, ShuffleIcon, SkipBackIcon, SkipForwardIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { usePathname } from "next/navigation";

export interface MusicTrack {
  id: string;
  name: string;
  url?: string;
  variantes?: string[];
  lyricsSrt?: string | null;
  lyricsUrl?: string | null;
  lyricsFileName?: string | null;
}

export interface MusicPlaylistSource {
  id: string;
  name: string;
  type: "global" | "private" | "song" | "admin";
}

interface MusicPlayerContextValue {
  currentTrack: MusicTrack | null;
  currentSource: MusicPlaylistSource | null;
  currentLyric: CurrentLyric | null;
  hasCurrentLyrics: boolean;
  isPlaying: boolean;
  playbackPitch: number;
  volume: number;
  currentTime: number;
  visualCurrentTime: number;
  duration: number;
  isShuffle: boolean;
  autoRandomPitch: boolean;
  lyricsEnabled: boolean;
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
  setLyricsEnabled: (val: boolean | ((prev: boolean) => boolean)) => void;
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
  lyricsEnabled: boolean;
}

interface LyricCue {
  id: string;
  start: number;
  end: number;
  text: string;
}

interface CurrentLyric {
  id: string;
  text: string;
  state: "active" | "past" | "silence";
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

const parseSrtTime = (value: string) => {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length < 2) return 0;

  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length > 0 ? Number(parts.pop()) : 0;

  if ([hours, minutes, seconds].some((part) => Number.isNaN(part))) {
    return 0;
  }

  return (hours * 3600) + (minutes * 60) + seconds;
};

const parseSrt = (srt?: string | null): LyricCue[] => {
  if (!srt) return [];

  return srt
    .replace(/\r/g, "")
    .split(/\n\s*\n/g)
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex === -1) return null;

      const [rawStart, rawEnd] = lines[timingIndex].split("-->").map((part) => part.trim());
      const text = lines
        .slice(timingIndex + 1)
        .join(" ")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (!rawStart || !rawEnd || !text) return null;

      const start = parseSrtTime(rawStart.split(/\s+/)[0]);
      const end = parseSrtTime(rawEnd.split(/\s+/)[0]);
      if (end <= start) return null;

      return {
        id: `${start}-${end}-${text}`,
        start,
        end,
        text,
      };
    })
    .filter((cue): cue is LyricCue => Boolean(cue))
    .sort((a, b) => a.start - b.start);
};

function LyricsDisplay({ lyric, visible }: { lyric: CurrentLyric | null; visible: boolean }) {
  const [activeLyric, setActiveLyric] = useState<CurrentLyric | null>(lyric);
  const [leavingLyric, setLeavingLyric] = useState<CurrentLyric | null>(null);
  const lyricId = lyric?.id;
  const lyricState = lyric?.state;
  const lyricText = lyric?.text;

  useEffect(() => {
    const nextLyric = lyricId && lyricText && lyricState
      ? { id: lyricId, text: lyricText, state: lyricState }
      : null;

    const frame = window.setTimeout(() => {
      if (!visible) {
        setActiveLyric(null);
        setLeavingLyric(null);
        return;
      }

      setActiveLyric((current) => {
        if (!nextLyric) return null;
        if (!current || current.id === nextLyric.id) return nextLyric;
        setLeavingLyric(current);
        return nextLyric;
      });

      if (!nextLyric) {
        setLeavingLyric(null);
      }
    }, 0);

    const timer = setTimeout(() => setLeavingLyric(null), 320);
    return () => {
      window.clearTimeout(frame);
      clearTimeout(timer);
    };
  }, [lyricId, lyricState, lyricText, visible]);

  if (!visible) return null;

  return (
    <div className="playlist-admin__lyrics-bar" aria-live="polite">
      <div className="playlist-admin__lyrics-window">
        {leavingLyric && (
          <span className="playlist-admin__lyrics-line playlist-admin__lyrics-line--leaving">
            {leavingLyric.text}
          </span>
        )}
        {activeLyric && (
          <span
            key={activeLyric.id}
            className={`playlist-admin__lyrics-line playlist-admin__lyrics-line--entering ${activeLyric.state === "past" ? "playlist-admin__lyrics-line--past" : ""} ${activeLyric.state === "silence" ? "playlist-admin__lyrics-line--silence" : ""}`}
          >
            {activeLyric.text}
          </span>
        )}
      </div>
    </div>
  );
}

export function MusicLyricsBar() {
  const { currentLyric, hasCurrentLyrics, lyricsEnabled } = useMusicPlayer();
  return <LyricsDisplay lyric={currentLyric} visible={lyricsEnabled && hasCurrentLyrics} />;
}

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
  const [visualCurrentTime, setVisualCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isShuffle, setIsShuffle] = useState(true);
  const [autoRandomPitch, setAutoRandomPitch] = useState(true);
  const [lyricsEnabled, setLyricsEnabled] = useState(true);
  const [history, setHistory] = useState<MusicTrack[]>([]);
  const progressPercent = duration > 0
    ? Math.min(100, Math.max(0, (visualCurrentTime / duration) * 100))
    : 0;
  const progressFill = progressPercent <= 0
    ? "0%"
    : progressPercent >= 100
      ? "100%"
      : `calc(${progressPercent}% + ${6 - (progressPercent * 0.12)}px)`;

  const lyricCues = useMemo(() => parseSrt(currentTrack?.lyricsSrt), [currentTrack?.lyricsSrt]);
  const hasCurrentLyrics = lyricCues.length > 0;
  const currentLyric = useMemo<CurrentLyric | null>(() => {
    if (lyricCues.length === 0) return null;

    const activeCue = lyricCues.find((cue) => currentTime >= cue.start && currentTime <= cue.end);
    if (activeCue) {
      return { id: activeCue.id, text: activeCue.text, state: "active" };
    }

    const firstCue = lyricCues[0];
    if (currentTime < firstCue.start) {
      if (firstCue.start > 2) {
        return { id: `silence-start-${firstCue.id}`, text: "♫", state: "silence" };
      }
      return null;
    }

    let previousIndex = -1;
    for (let i = 0; i < lyricCues.length; i += 1) {
      if (currentTime > lyricCues[i].end) previousIndex = i;
      else break;
    }

    const previousCue = previousIndex >= 0 ? lyricCues[previousIndex] : null;
    if (previousCue) {
      const nextCue = lyricCues[previousIndex + 1];
      if (nextCue && currentTime < nextCue.start && nextCue.start - previousCue.end > 2) {
        return { id: `silence-${previousCue.id}-${nextCue.id}`, text: "♫", state: "silence" };
      }

      const hasLongOutro = duration > 0
        ? duration - previousCue.end > 2
        : currentTime - previousCue.end > 2;
      if (!nextCue && hasLongOutro) {
        return { id: `silence-end-${previousCue.id}`, text: "♫", state: "silence" };
      }

      return { id: previousCue.id, text: previousCue.text, state: "past" };
    }

    return null;
  }, [currentTime, duration, lyricCues]);

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
    setVisualCurrentTime(0);
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
      setVisualCurrentTime(val);
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
    setVisualCurrentTime(0);
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
      const restoredTime = typeof state.currentTime === "number" ? state.currentTime : 0;
      setCurrentTime(restoredTime);
      setVisualCurrentTime(restoredTime);
      setPlaybackPitch(typeof state.playbackPitch === "number" ? state.playbackPitch : 1);
      setVolume(typeof state.volume === "number" ? state.volume : 0.8);
      setIsShuffle(typeof state.isShuffle === "boolean" ? state.isShuffle : true);
      setAutoRandomPitch(typeof state.autoRandomPitch === "boolean" ? state.autoRandomPitch : true);
      setLyricsEnabled(typeof state.lyricsEnabled === "boolean" ? state.lyricsEnabled : true);
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
      lyricsEnabled,
    };

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [autoRandomPitch, currentSource, currentTime, currentTrack, isShuffle, lyricsEnabled, playbackPitch, queue, queueSource, storageReady, volume]);

  useEffect(() => {
    if (!isPlaying) return;

    let frameId = 0;
    const syncVisualTime = () => {
      if (audioRef.current) {
        setVisualCurrentTime(audioRef.current.currentTime);
      }
      frameId = window.requestAnimationFrame(syncVisualTime);
    };

    frameId = window.requestAnimationFrame(syncVisualTime);
    return () => window.cancelAnimationFrame(frameId);
  }, [isPlaying]);

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
        const safeDuration = Math.max(0, duration);
        const safePosition = Math.min(Math.max(0, currentTime), safeDuration);
        navigator.mediaSession.setPositionState({
          duration: safeDuration,
          playbackRate: playbackPitch,
          position: safePosition,
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
        currentLyric,
        hasCurrentLyrics,
        isPlaying,
        playbackPitch,
        volume,
        currentTime,
        visualCurrentTime,
        duration,
        isShuffle,
        autoRandomPitch,
        lyricsEnabled,
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
        setLyricsEnabled,
        stop,
      }}
    >
      {children}

      {!pathname.startsWith("/admin") && (
      <>
      <LyricsDisplay lyric={currentLyric} visible={lyricsEnabled && hasCurrentLyrics} />
      <div className="playlist-admin__player">
        <div className="playlist-admin__now-playing">
          {currentTrack ? (
            <>
              <span className="playlist-admin__now-playing-title">{currentTrack.name}</span>
              {currentSource && (
                <span className="playlist-admin__now-playing-source">{currentSource.name}</span>
              )}
              <span className="playlist-admin__now-playing-pitch-row">
                <span className="playlist-admin__now-playing-pitch">Pitch: {playbackPitch.toFixed(2)}x</span>
                <button
                  className="playlist-admin__pitch-reset"
                  onClick={() => handlePitchChange(1)}
                  title="Restaurar pitch a 1x"
                >
                  <RotateCcwIcon size={11} />
                </button>
              </span>
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
            <button
              className={`playlist-admin__control-btn playlist-admin__control-btn--lyrics ${lyricsEnabled ? "playlist-admin__control-btn--active" : ""}`}
              onClick={() => setLyricsEnabled((v) => !v)}
              title={lyricsEnabled ? "Lyrics activadas" : "Lyrics desactivadas"}
            >
              <Mic2Icon size={16} />
            </button>
          </div>

          <div className="playlist-admin__progress">
            <span className="playlist-admin__progress-time">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step="any"
              value={visualCurrentTime}
              onChange={(e) => handleSeek(Number(e.target.value))}
              className="playlist-admin__progress-bar"
              style={{ background: `linear-gradient(to right, #fff 0%, #fff ${progressFill}, #535353 ${progressFill}, #535353 100%)` }}
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
      </>
      )}

      <audio
        ref={audioRef}
        src={currentTrack?.url || undefined}
        onEnded={playNext}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onTimeUpdate={() => {
          if (audioRef.current) {
            setCurrentTime(audioRef.current.currentTime);
            setVisualCurrentTime(audioRef.current.currentTime);
          }
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
