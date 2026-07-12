"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, useEffect, type ReactNode, type SyntheticEvent } from "react";
import { ArrowRightIcon, DicesIcon, Mic2Icon, PauseIcon, PlayIcon, RotateCcwIcon, ShuffleIcon, SkipBackIcon, SkipForwardIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MUSIC_API_URL, calibrateRadioClock, getLiveRadioPosition, getMediaUrl, getRadioServerNow, radioPatch, radioPost, type RadioState } from "@/lib/radioApi";
import { computeCurrentLyric } from "@/lib/lyrics";
import SongArtwork from "@/components/SongArtwork";

export interface MusicTrack {
  id: string;
  name: string;
  url?: string;
  variantes?: string[];
  lyricsSrt?: string | null;
  lyricsUrl?: string | null;
  lyricsFileName?: string | null;
  staticLyrics?: string | null;
  duration?: number | null;
  iconUrl?: string | null;
  advancedCoverUrl?: string | null;
  advancedCoverType?: string | null;
  addedAt?: string | null;
  createdAt?: { seconds: number; nanoseconds: number } | Date | string | null;
}

export interface MusicPlaylistSource {
  id: string;
  name: string;
  type: "global" | "private" | "song" | "admin" | "radio";
}

interface MusicPlayerContextValue {
  currentTrack: MusicTrack | null;
  currentSource: MusicPlaylistSource | null;
  hasCurrentLyrics: boolean;
  isPlaying: boolean;
  playbackPitch: number;
  volume: number;
  duration: number;
  isShuffle: boolean;
  canPlayNext: boolean;
  canPlayPrev: boolean;
  autoRandomPitch: boolean;
  lyricsEnabled: boolean;
  playerMode: "local" | "radio";
  isRadioBuffering: boolean;
  isRadioAwaitingUserGesture: boolean;
  radioState: RadioState | null;
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
  enableRadioMode: () => Promise<void>;
  disableRadioMode: () => void;
  getAudioFrequencyData: () => Uint8Array<ArrayBuffer> | null;
  stop: () => void;
}

// Contexto separado para los valores que cambian varias veces por segundo
// durante la reproduccion (tiempo y lyric actual). Asi las paginas que solo
// necesitan controles/estado (listas de canciones enteras) no se re-renderizan
// con cada tick del audio.
interface MusicPlayerTimeContextValue {
  currentTime: number;
  visualCurrentTime: number;
  currentLyric: CurrentLyric | null;
}

const MusicPlayerContext = createContext<MusicPlayerContextValue | null>(null);
const MusicPlayerTimeContext = createContext<MusicPlayerTimeContextValue | null>(null);
const STORAGE_KEY = "farreo-player-state";

const getSourceHref = (source: MusicPlaylistSource | null) => {
  if (!source) return null;
  if (source.type === "global") return `/playlist/${encodeURIComponent(source.id)}`;
  if (source.type === "private") return `/user-playlist/${encodeURIComponent(source.id)}`;
  return null;
};

interface StoredPlayerState {
  currentTrack: MusicTrack | null;
  queue: MusicTrack[];
  queueSource: MusicPlaylistSource | null;
  currentSource: MusicPlaylistSource | null;
  currentTime: number;
  playbackPitch: number;
  volume: number;
  lastNonZeroVolume: number;
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

interface AudioAnalysisConnection {
  source: MediaElementAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
}

export function useMusicPlayer() {
  const context = useContext(MusicPlayerContext);
  if (!context) {
    throw new Error("useMusicPlayer debe usarse dentro de MusicPlayerProvider");
  }
  return context;
}

// Solo para componentes que pintan el tiempo/lyrics: se re-renderizan con cada
// tick del audio, asi que conviene que sean lo mas pequenos posible.
export function useMusicPlayerTime() {
  const context = useContext(MusicPlayerTimeContext);
  if (!context) {
    throw new Error("useMusicPlayerTime debe usarse dentro de MusicPlayerProvider");
  }
  return context;
}

const formatTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? "0" : ""}${sec}`;
};

const clampVolume = (value: number) => Math.min(1, Math.max(0, value));

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

export function LyricsDisplay({ lyric, visible }: { lyric: CurrentLyric | null; visible: boolean }) {
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
  const { hasCurrentLyrics, lyricsEnabled } = useMusicPlayer();
  const { currentLyric } = useMusicPlayerTime();
  return <LyricsDisplay lyric={currentLyric} visible={lyricsEnabled && hasCurrentLyrics} />;
}

// Barra de progreso compartida (reproductor global y biblioteca). Es el unico
// trozo de UI que consume el tiempo de reproduccion, de modo que el tick del
// audio solo re-renderiza este componente y no la pagina que lo contiene.
export function PlayerProgressBar() {
  const { duration, handleSeek } = useMusicPlayer();
  const { currentTime, visualCurrentTime } = useMusicPlayerTime();
  const progressPercent = duration > 0
    ? Math.min(100, Math.max(0, (visualCurrentTime / duration) * 100))
    : 0;
  const progressFill = progressPercent <= 0
    ? "0%"
    : progressPercent >= 100
      ? "100%"
      : `calc(${progressPercent}% + ${6 - (progressPercent * 0.12)}px)`;

  return (
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
  );
}

export default function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isMobileRoute = pathname.startsWith("/mobile");
  const playerStorageKey = isMobileRoute ? `${STORAGE_KEY}-mobile` : STORAGE_KEY;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Doble buffer (gapless): dos elementos fisicos de audio. audioRef.current
  // SIEMPRE apunta al elemento activo; el otro precarga la siguiente cancion.
  const elARef = useRef<HTMLAudioElement | null>(null);
  const elBRef = useRef<HTMLAudioElement | null>(null);
  const activeIdRef = useRef<"a" | "b">("a");
  const preloadedTrackRef = useRef<MusicTrack | null>(null);
  const preloadedPitchRef = useRef(1);
  // URL exacta asignada al elemento de precarga. Se compara contra track.url
  // (no contra preEl.src, que el navegador puede normalizar/re-encodear y
  // romper la igualdad silenciosamente, desactivando el doble buffer).
  const preloadedUrlRef = useRef("");
  const lastPreloadRetryRef = useRef(0);
  const shuffleRemainingRef = useRef<string[]>([]);
  const shuffleQueueSignatureRef = useRef("");
  const lastPositionStateRef = useRef({ duration: -1, rate: -1, position: 0, at: 0 });
  const volumeRef = useRef(0.8);
  const lastNonZeroVolumeRef = useRef(0.8);
  const playerModeRef = useRef<"local" | "radio">("local");
  const radioStateRef = useRef<RadioState | null>(null);
  const radioAwaitingUserGestureRef = useRef(false);
  const pendingRadioJoinSyncRef = useRef(false);
  const scheduledRadioStartRef = useRef<string | null>(null);
  const lastRadioDriftCheckRef = useRef(0);
  const lastVisualTimeUpdateRef = useRef(0);
  const visualCurrentTimeRef = useRef(0);
  const radioEventsRef = useRef<EventSource | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioAnalysisConnectionsRef = useRef<WeakMap<HTMLAudioElement, AudioAnalysisConnection>>(new WeakMap());
  const audioAnalysisUnavailableRef = useRef<WeakSet<HTMLAudioElement>>(new WeakSet());
  const lastRadioItemRef = useRef<string | null>(null);
  const hasRestoredRef = useRef(false);
  const pendingPlayRef = useRef(false);
  const [storageReady, setStorageReady] = useState(false);
  const [playerMode, setPlayerMode] = useState<"local" | "radio">("local");
  const [isRadioBuffering, setIsRadioBuffering] = useState(false);
  const [isRadioAwaitingUserGesture, setIsRadioAwaitingUserGesture] = useState(false);
  const [radioState, setRadioState] = useState<RadioState | null>(null);
  const [queue, setQueue] = useState<MusicTrack[]>([]);
  const [queueSource, setQueueSource] = useState<MusicPlaylistSource | null>(null);
  const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null);
  const [currentSource, setCurrentSource] = useState<MusicPlaylistSource | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPitch, setPlaybackPitch] = useState(1);
  const [volume, setVolume] = useState(0.8);
  const [lastNonZeroVolume, setLastNonZeroVolume] = useState(0.8);
  const [currentTime, setCurrentTime] = useState(0);
  const [visualCurrentTime, setVisualCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isShuffle, setIsShuffle] = useState(true);
  const [autoRandomPitch, setAutoRandomPitch] = useState(true);
  const [lyricsEnabled, setLyricsEnabled] = useState(true);
  const [history, setHistory] = useState<MusicTrack[]>([]);

  const lyricCues = useMemo(() => parseSrt(currentTrack?.lyricsSrt), [currentTrack?.lyricsSrt]);
  const hasCurrentLyrics = lyricCues.length > 0;
  const currentLyric = useMemo<CurrentLyric | null>(
    () => computeCurrentLyric(lyricCues, currentTime, duration),
    [currentTime, duration, lyricCues],
  );

  const radioTrackFromItem = (item: RadioState["queue"][number]): MusicTrack => ({
    id: item.song.id,
    name: item.song.name,
    url: getMediaUrl(item.song.url),
    variantes: item.song.variantes,
    lyricsSrt: item.song.lyricsSrt,
    lyricsUrl: item.song.lyricsUrl,
    lyricsFileName: item.song.lyricsFileName,
    staticLyrics: item.song.staticLyrics,
    duration: item.song.duration,
    iconUrl: item.song.iconUrl,
    advancedCoverUrl: item.song.advancedCoverUrl,
    advancedCoverType: item.song.advancedCoverType,
    createdAt: item.song.createdAt,
  });

  const getQueueSignature = (tracks: MusicTrack[]) => tracks.map((track) => track.id).join("\u0001");

  const resetShuffleBag = useCallback((tracks: MusicTrack[], currentId?: string | null) => {
    const seen = new Set<string>();
    shuffleQueueSignatureRef.current = getQueueSignature(tracks);
    shuffleRemainingRef.current = tracks
      .map((track) => track.id)
      .filter((id) => {
        if (!id || id === currentId || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  }, []);

  const ensureShuffleBagForCurrentQueue = () => {
    const signature = getQueueSignature(queue);
    const queueIds = new Set(queue.map((track) => track.id));

    if (shuffleQueueSignatureRef.current !== signature) {
      resetShuffleBag(queue, currentTrack?.id);
      return;
    }

    shuffleRemainingRef.current = shuffleRemainingRef.current.filter((id) => (
      queueIds.has(id) && id !== currentTrack?.id
    ));
  };

  const pickShuffleTrack = (consume = false): MusicTrack | null => {
    if (queue.length <= 1) return null;

    ensureShuffleBagForCurrentQueue();

    if (shuffleRemainingRef.current.length === 0) {
      resetShuffleBag(queue, currentTrack?.id);
    }

    const candidates = shuffleRemainingRef.current;
    if (candidates.length === 0) return null;

    const nextId = candidates[Math.floor(Math.random() * candidates.length)];
    if (consume) {
      shuffleRemainingRef.current = shuffleRemainingRef.current.filter((id) => id !== nextId);
    }

    return queue.find((track) => track.id === nextId) || null;
  };

  const syncAudioToLiveRadio = (threshold = 0.9) => {
    const audio = audioRef.current;
    const state = radioStateRef.current;
    if (!audio || playerModeRef.current !== "radio" || !state?.currentItem) return;

    const livePosition = getLiveRadioPosition(state);
    const duration = state.currentItem.song.duration || 0;
    const targetPosition = duration > 0
      ? Math.min(duration, livePosition)
      : livePosition;
    const drift = Math.abs(audio.currentTime - targetPosition);

    if (drift > threshold) {
      try {
        audio.currentTime = targetPosition;
      } catch {
        // The browser may reject seeks before metadata is available.
      }
      setCurrentTime(targetPosition);
      setVisualCurrentTime(targetPosition);
    }
  };

  const scheduleRadioJoinSync = () => {
    pendingRadioJoinSyncRef.current = true;
    [350, 1200].forEach((delay) => {
      window.setTimeout(() => {
        if (
          playerModeRef.current === "radio" &&
          radioStateRef.current?.status === "playing" &&
          audioRef.current &&
          !audioRef.current.paused
        ) {
          syncAudioToLiveRadio(0.75);
        }

        if (delay === 1200) {
          pendingRadioJoinSyncRef.current = false;
        }
      }, delay);
    });
  };

  const setRadioAwaitingGesture = (value: boolean) => {
    radioAwaitingUserGestureRef.current = value;
    setIsRadioAwaitingUserGesture(value);
  };

  const joinLiveRadioAudio = async (userInitiated = false) => {
    const audio = audioRef.current;
    const state = radioStateRef.current;
    if (!audio || !state?.currentItem) return;
    if (radioAwaitingUserGestureRef.current && !userInitiated) return;

    audio.preservesPitch = false;
    audio.playbackRate = state.currentItem.pitch;
    audio.volume = volumeRef.current;
    pendingRadioJoinSyncRef.current = true;
    syncAudioToLiveRadio(0.25);
    setIsRadioBuffering(true);

    try {
      await audio.play();
      syncAudioToLiveRadio(0.35);
      scheduleRadioJoinSync();
      setIsPlaying(true);
      setRadioAwaitingGesture(false);
      setIsRadioBuffering(false);
    } catch {
      setIsPlaying(false);
      setRadioAwaitingGesture(true);
      setIsRadioBuffering(false);
    }
  };

  const applyRadioSnapshot = (state: RadioState, receivedAt = Date.now()) => {
    calibrateRadioClock(state, receivedAt);
    radioStateRef.current = state;
    setRadioState(state);

    if (playerModeRef.current !== "radio") {
      return;
    }

    setPlayerMode("radio");
    setIsShuffle(state.shuffle);

    const item = state.currentItem;
    if (!item) {
      lastRadioItemRef.current = null;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }
      setQueue([]);
      setQueueSource({ id: "radio", name: "Radio", type: "radio" });
      setCurrentTrack(null);
      setCurrentSource({ id: "radio", name: "Radio", type: "radio" });
      setCurrentTime(0);
      setVisualCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      setIsRadioBuffering(false);
      setRadioAwaitingGesture(false);
      return;
    }

    const track = radioTrackFromItem(item);
    const source: MusicPlaylistSource = {
      id: item.source.id,
      name: `Radio - ${item.source.name}`,
      type: "radio",
    };
    const targetPosition = getLiveRadioPosition(state);
    const startDelayMs = state.status === "playing" && state.anchorUpdatedAt > state.serverTime && targetPosition <= 0.05
      ? Math.max(0, state.anchorUpdatedAt - getRadioServerNow())
      : 0;
    const radioQueue = state.queue.map(radioTrackFromItem);
    const itemChanged = lastRadioItemRef.current !== item.itemId;
    const audioBeforeSync = audioRef.current;
    const driftBeforeSync = audioBeforeSync ? Math.abs(audioBeforeSync.currentTime - targetPosition) : 0;
    const shouldUpdateClockState = itemChanged ||
      state.status !== "playing" ||
      !audioBeforeSync ||
      audioBeforeSync.paused ||
      driftBeforeSync > 0.45;
    const shouldShowBuffering = state.status === "playing" && !radioAwaitingUserGestureRef.current && (
      itemChanged ||
      !audioBeforeSync ||
      audioBeforeSync.paused ||
      driftBeforeSync > 0.75
    );

    setQueue(radioQueue);
    setQueueSource({ id: "radio", name: "Radio", type: "radio" });
    setCurrentTrack(track);
    setCurrentSource(source);
    setPlaybackPitch(item.pitch);
    if (shouldUpdateClockState) {
      setCurrentTime(targetPosition);
      setVisualCurrentTime(targetPosition);
    }
    setDuration(item.song.duration || 0);
    setIsRadioBuffering(shouldShowBuffering);

    lastRadioItemRef.current = item.itemId;

    window.setTimeout(() => {
      const audio = audioRef.current;
      if (!audio) return;

      audio.preservesPitch = false;
      audio.playbackRate = item.pitch;
      audio.volume = volumeRef.current;

      if (itemChanged || Math.abs(audio.currentTime - targetPosition) > 0.45) {
        try {
          audio.currentTime = targetPosition;
        } catch {
          // Metadata may not be ready yet; onLoadedMetadata will seek again.
        }
      }

      if (state.status === "playing") {
        if (radioAwaitingUserGestureRef.current) {
          setIsRadioBuffering(false);
          return;
        }

        if (startDelayMs > 50) {
          audio.pause();
          setIsPlaying(false);
          setIsRadioBuffering(true);
          if (scheduledRadioStartRef.current === item.itemId) return;
          scheduledRadioStartRef.current = item.itemId;
          window.setTimeout(() => {
            if (
              playerModeRef.current === "radio" &&
              radioStateRef.current?.currentItem?.itemId === item.itemId &&
              radioStateRef.current.status === "playing"
            ) {
              scheduledRadioStartRef.current = null;
              joinLiveRadioAudio();
              return;
            }
            if (scheduledRadioStartRef.current === item.itemId) {
              scheduledRadioStartRef.current = null;
            }
          }, startDelayMs);
          return;
        }

        if (itemChanged || audio.paused || audio.readyState === 0) {
          setIsRadioBuffering(true);
          joinLiveRadioAudio();
        } else {
          syncAudioToLiveRadio(0.45);
          setIsPlaying(true);
          setIsRadioBuffering(false);
        }
      } else {
        audio.pause();
        setIsPlaying(false);
        setIsRadioBuffering(false);
        setRadioAwaitingGesture(false);
      }
    }, 60);
  };

  const enableRadioMode = async () => {
    playerModeRef.current = "radio";
    setPlayerMode("radio");
    if (!radioEventsRef.current) {
      const events = new EventSource(`${MUSIC_API_URL}/radio/events`);
      const handleRadioEvent = (event: Event) => {
        applyRadioSnapshot(JSON.parse((event as MessageEvent).data) as RadioState, Date.now());
      };
      events.addEventListener("state", handleRadioEvent);
      events.addEventListener("play", handleRadioEvent);
      events.addEventListener("pause", handleRadioEvent);
      events.addEventListener("seek", handleRadioEvent);
      events.addEventListener("skip", handleRadioEvent);
      events.addEventListener("queue", handleRadioEvent);
      events.addEventListener("settings", handleRadioEvent);
      events.addEventListener("clear", handleRadioEvent);
      events.addEventListener("advance", handleRadioEvent);
      events.onerror = () => {
        // EventSource reconnects automatically; keep the current state while it does.
      };
      radioEventsRef.current = events;
    }

    const res = await fetch(`${MUSIC_API_URL}/radio`);
    if (res.ok) {
      applyRadioSnapshot((await res.json()) as RadioState, Date.now());
    }
  };

  const disableRadioMode = () => {
    playerModeRef.current = "local";
    setPlayerMode("local");
    setIsRadioBuffering(false);
    setRadioAwaitingGesture(false);
    pendingRadioJoinSyncRef.current = false;
    scheduledRadioStartRef.current = null;
    lastRadioItemRef.current = null;
  };

  const startTrack = (track: MusicTrack, source = queueSource) => {
    if (!track.url) return;
    if (playerMode === "radio") {
      disableRadioMode();
    }

    if (isShuffle) {
      shuffleRemainingRef.current = shuffleRemainingRef.current.filter((id) => id !== track.id);
    }

    let pitch = playbackPitch;
    if (autoRandomPitch) {
      pitch = Math.random() * (1.2 - 0.8) + 0.8;
      setPlaybackPitch(pitch);
    }

    pendingPlayRef.current = true;
    preloadedTrackRef.current = null;
    preloadedUrlRef.current = "";
    setCurrentTrack(track);
    setCurrentSource(source);
    setCurrentTime(0);
    setVisualCurrentTime(0);
    setDuration(0);
    setIsPlaying(true);
    // Cargamos el audio de forma IMPERATIVA aqui mismo (dentro del stack del
    // evento onEnded), sin esperar al re-render de React. Chrome aplaza/congela
    // el render de pestanas en segundo plano, asi que si dependieramos del
    // src controlado por React el siguiente tema no llegaba a cargarse y la
    // reproduccion se paraba al cambiar de cancion con la pantalla bloqueada.
    // CRITICO: el play() tambien debe pedirse AQUI, en el mismo stack. Con la
    // pantalla bloqueada Chrome puede congelar la pagina en cuanto deja de
    // sonar audio; si esperamos a onLoadedMetadata/onCanPlay para llamar a
    // play(), ese evento puede no llegar a ejecutarse nunca y la musica se
    // queda parada (era el fallo de "se para tras 2-3 canciones"). Un play()
    // pendiente mantiene al elemento como "potencialmente reproduciendo" y el
    // navegador sigue cargando y arranca solo en cuanto hay datos.
    const audio = audioRef.current;
    if (audio) {
      audio.src = track.url;
      audio.load();
      audio.preservesPitch = false;
      audio.defaultPlaybackRate = pitch;
      audio.playbackRate = pitch;
      audio.volume = volumeRef.current;
      audio.play().catch(() => {
        // onLoadedMetadata / onCanPlay reintentan via pendingPlayRef.
      });
    }
  };

  const playQueue = (tracks: MusicTrack[], index: number, source?: MusicPlaylistSource | null) => {
    if (playerMode === "radio") {
      disableRadioMode();
    }
    const startIndex = isShuffle
      ? Math.floor(Math.random() * tracks.length)
      : index;
    const track = tracks[startIndex];
    if (!track) return;
    resetShuffleBag(tracks, track.id);
    setQueue(tracks);
    setQueueSource(source ?? null);
    setHistory([]);
    startTrack(track, source ?? null);
  };

  const loadQueue = useCallback((tracks: MusicTrack[], source?: MusicPlaylistSource | null) => {
    if (playerMode === "radio") return;
    resetShuffleBag(tracks, currentTrack?.id);
    setQueue(tracks);
    setQueueSource(source ?? null);
    setHistory([]);
  }, [currentTrack?.id, playerMode, resetShuffleBag]);

  const toggleTrack = (track: MusicTrack, tracks?: MusicTrack[], source?: MusicPlaylistSource | null) => {
    if (playerMode === "radio") {
      disableRadioMode();
    }
    if (tracks) {
      resetShuffleBag(tracks, track.id);
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
    if (playerMode === "radio") {
      void radioPost<RadioState>("/radio/skip").then(applyRadioSnapshot).catch(() => undefined);
      return;
    }

    if (queue.length === 0) return;
    
    if (currentTrack) {
      setHistory((prev) => [...prev, currentTrack]);
    }

    if (isShuffle) {
      const nextTrack = pickShuffleTrack(true);
      if (nextTrack) startTrack(nextTrack, queueSource);
      return;
    }

    if (!currentTrack) {
      startTrack(queue[0], queueSource);
      return;
    }

    const idx = queue.findIndex((track) => track.id === currentTrack.id);
    startTrack(queue[(idx + 1) % queue.length], queueSource);
  };

  // ===== Doble buffer (reproduccion gapless en segundo plano) =====
  const getActiveAudio = () => (activeIdRef.current === "a" ? elARef.current : elBRef.current);
  const getPreloadAudio = () => (activeIdRef.current === "a" ? elBRef.current : elARef.current);

  const getAudioFrequencyData = useCallback(() => {
    if (typeof window === "undefined") return null;

    const audio = activeIdRef.current === "a" ? elARef.current : elBRef.current;
    if (!audio || audio.paused || audio.readyState < 2 || audioAnalysisUnavailableRef.current.has(audio)) {
      return null;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;

    let context = audioContextRef.current;
    if (!context) {
      context = new AudioCtx();
      audioContextRef.current = context;
    }

    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
      return null;
    }

    if (context.state === "closed") {
      return null;
    }

    let connection = audioAnalysisConnectionsRef.current.get(audio);
    if (!connection) {
      try {
        const source = context.createMediaElementSource(audio);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.72;
        source.connect(analyser);
        analyser.connect(context.destination);
        connection = {
          source,
          analyser,
          data: new Uint8Array(analyser.frequencyBinCount),
        };
        audioAnalysisConnectionsRef.current.set(audio, connection);
      } catch {
        audioAnalysisUnavailableRef.current.add(audio);
        return null;
      }
    }

    connection.analyser.getByteFrequencyData(connection.data);
    return connection.data;
  }, []);

  // Elige la siguiente pista SIN efectos secundarios (replica la logica de playNext).
  const pickNextTrack = (): MusicTrack | null => {
    if (queue.length === 0) return null;
    if (isShuffle) {
      return pickShuffleTrack(false);
    }
    if (!currentTrack) return queue[0];
    if (queue.length === 1) return null;
    const idx = queue.findIndex((track) => track.id === currentTrack.id);
    return queue[(idx + 1) % queue.length];
  };

  // Precarga (bufferiza) la siguiente pista en el elemento inactivo.
  const preloadNext = () => {
    if (playerModeRef.current === "radio") return;
    const preEl = getPreloadAudio();
    const next = pickNextTrack();
    if (!preEl || !next || !next.url) {
      preloadedTrackRef.current = null;
      preloadedUrlRef.current = "";
      return;
    }
    preloadedTrackRef.current = next;
    preloadedPitchRef.current = autoRandomPitch ? Math.random() * (1.2 - 0.8) + 0.8 : playbackPitch;
    if (preloadedUrlRef.current !== next.url || preEl.error) {
      preloadedUrlRef.current = next.url;
      preEl.preload = "auto";
      preEl.src = next.url;
      preEl.load();
    }
  };

  // ¿Esta la siguiente pista precargada y con datos suficientes para arrancar?
  const isPreloadReady = () => {
    const next = preloadedTrackRef.current;
    const preEl = getPreloadAudio();
    return Boolean(
      next?.url &&
      preEl &&
      preloadedUrlRef.current === next.url &&
      !preEl.error &&
      preEl.readyState >= 2,
    );
  };

  // Avance automatico: si la siguiente ya esta precargada y lista, cambiamos a
  // ese elemento al instante (sin hueco). Si no, fallback a playNext.
  // Con letOldFinish (encadenado anticipado) NO pausamos el elemento saliente:
  // se le deja terminar su ultima fraccion de segundo de forma natural, de modo
  // que la pagina nunca pasa por un instante "sin audio sonando" (que es cuando
  // Chrome puede congelarla en segundo plano).
  const finishSingleTrackQueue = () => {
    const audio = audioRef.current;
    if (audio) {
      try { audio.pause(); } catch { /* no-op */ }
      const endTime = Number.isFinite(audio.duration) ? audio.duration : duration;
      if (Number.isFinite(endTime) && endTime > 0) {
        setCurrentTime(endTime);
        setVisualCurrentTime(endTime);
      }
    }
    preloadedTrackRef.current = null;
    preloadedUrlRef.current = "";
    setIsPlaying(false);
  };

  const advanceToPreloaded = (opts?: { letOldFinish?: boolean }) => {
    if (queue.length <= 1 && currentTrack) {
      finishSingleTrackQueue();
      return;
    }

    const next = preloadedTrackRef.current;
    const preEl = getPreloadAudio();
    const oldActive = getActiveAudio();
    if (!next || !preEl || !isPreloadReady()) {
      playNext();
      return;
    }
    if (currentTrack) setHistory((prev) => [...prev, currentTrack]);
    if (isShuffle) {
      shuffleRemainingRef.current = shuffleRemainingRef.current.filter((id) => id !== next.id);
    }
    // Intercambio activo <-> precargador
    activeIdRef.current = activeIdRef.current === "a" ? "b" : "a";
    audioRef.current = preEl;
    const pitch = preloadedPitchRef.current;
    preEl.preservesPitch = false;
    preEl.playbackRate = pitch;
    preEl.volume = volumeRef.current;
    try { preEl.currentTime = 0; } catch { /* puede fallar antes de tener datos */ }
    preloadedTrackRef.current = null;
    setPlaybackPitch(pitch);
    setCurrentTrack(next);
    setCurrentSource(queueSource);
    setCurrentTime(0);
    setVisualCurrentTime(0);
    setDuration(preEl.duration || 0);
    setIsPlaying(true);
    preEl.play().catch(() => setIsPlaying(false));
    if (oldActive && !opts?.letOldFinish) { try { oldActive.pause(); } catch { /* no-op */ } }
    // La precarga de la NUEVA siguiente la hace el efecto al cambiar currentTrack.
  };

  // Handlers compartidos por los dos <audio>. Solo el ELEMENTO ACTIVO controla
  // el estado; los eventos del precargador se ignoran (guard por currentTarget).
  const audioEventProps = {
    onEnded: (e: SyntheticEvent<HTMLAudioElement>) => {
      if (e.currentTarget !== audioRef.current) return;
      if (playerModeRef.current === "radio") return;
      advanceToPreloaded();
    },
    onPause: (e: SyntheticEvent<HTMLAudioElement>) => {
      if (e.currentTarget !== audioRef.current) return;
      if (playerModeRef.current === "radio" && radioStateRef.current?.status === "playing") {
        setIsRadioBuffering(true);
        return;
      }
      setIsPlaying(false);
    },
    onPlay: (e: SyntheticEvent<HTMLAudioElement>) => {
      if (e.currentTarget !== audioRef.current) return;
      // El visualizador enruta el audio por un AudioContext: si el sistema lo
      // suspende (pantalla bloqueada, cambio de foco), el elemento "reproduce"
      // pero no suena nada. Reanudarlo en cada arranque/encadenado lo cubre.
      const ctx = audioContextRef.current;
      if (ctx && ctx.state === "suspended") {
        void ctx.resume().catch(() => undefined);
      }
      setIsPlaying(true);
    },
    onTimeUpdate: (e: SyntheticEvent<HTMLAudioElement>) => {
      if (e.currentTarget !== audioRef.current) return;
      const el = e.currentTarget;
      // visualCurrentTime lo actualiza el bucle de rAF (250ms) y handleSeek;
      // duplicarlo aqui doblaba los re-renders durante la reproduccion.
      setCurrentTime(el.currentTime);

      if (playerModeRef.current === "radio" || el.paused) return;

      // Si la precarga fallo (red del servidor casero, etc.), reintentala de
      // vez en cuando desde este evento, que sigue ejecutandose en segundo
      // plano mientras suena la musica (los timers normales no).
      const preEl = getPreloadAudio();
      if (
        preloadedTrackRef.current &&
        preEl?.error &&
        Date.now() - lastPreloadRetryRef.current > 5000
      ) {
        lastPreloadRetryRef.current = Date.now();
        preloadNext();
      }

      // Encadenado anticipado: arrancamos la siguiente pista ~0.3s antes de que
      // acabe la actual (dejando que esta termine sola). Asi nunca hay un
      // instante sin audio y Chrome no puede congelar la pagina justo en el
      // cambio de cancion con la pantalla bloqueada. onEnded queda de respaldo
      // por si este evento no llega a ver la ventana final.
      if (Number.isFinite(el.duration) && el.duration > 0) {
        const remaining = el.duration - el.currentTime;
        if (queue.length > 1 && remaining <= 0.3 && isPreloadReady()) {
          advanceToPreloaded({ letOldFinish: true });
        }
      }
    },
    onLoadedMetadata: (e: SyntheticEvent<HTMLAudioElement>) => {
      if (e.currentTarget !== audioRef.current) return;
      const el = e.currentTarget;
      setDuration(el.duration);
      el.volume = volumeRef.current;
      el.preservesPitch = false;
      el.playbackRate = playbackPitch;
      if (playerModeRef.current === "radio" && radioStateRef.current) {
        const livePosition = getLiveRadioPosition(radioStateRef.current);
        if (Math.abs(el.currentTime - livePosition) > 0.5) {
          el.currentTime = livePosition;
        }
        setCurrentTime(livePosition);
        setVisualCurrentTime(livePosition);
      }
      if (playerModeRef.current !== "radio" && !isPlaying && currentTime > 0 && el.currentTime !== currentTime) {
        el.currentTime = currentTime;
      }
      if (playerModeRef.current !== "radio" && pendingPlayRef.current) {
        pendingPlayRef.current = false;
        el.play().catch(() => setIsPlaying(false));
      }
    },
    onLoadStart: (e: SyntheticEvent<HTMLAudioElement>) => {
      if (e.currentTarget !== audioRef.current) return;
      if (playerModeRef.current === "radio" && radioStateRef.current?.status === "playing") {
        setIsRadioBuffering(true);
      }
    },
    onWaiting: (e: SyntheticEvent<HTMLAudioElement>) => {
      if (e.currentTarget !== audioRef.current) return;
      if (playerModeRef.current === "radio" && radioStateRef.current?.status === "playing") {
        setIsRadioBuffering(true);
      }
    },
    onStalled: (e: SyntheticEvent<HTMLAudioElement>) => {
      if (e.currentTarget !== audioRef.current) return;
      if (playerModeRef.current === "radio" && radioStateRef.current?.status === "playing") {
        setIsRadioBuffering(true);
      }
    },
    onCanPlay: (e: SyntheticEvent<HTMLAudioElement>) => {
      if (e.currentTarget !== audioRef.current) return;
      if (playerModeRef.current === "radio" && radioStateRef.current?.status === "playing") {
        syncAudioToLiveRadio(pendingRadioJoinSyncRef.current ? 0.5 : 0.75);
        return;
      }
      if (playerModeRef.current !== "radio" && pendingPlayRef.current) {
        pendingPlayRef.current = false;
        e.currentTarget.play().catch(() => setIsPlaying(false));
      }
    },
    onPlaying: (e: SyntheticEvent<HTMLAudioElement>) => {
      if (e.currentTarget !== audioRef.current) return;
      if (playerModeRef.current === "radio") {
        syncAudioToLiveRadio(pendingRadioJoinSyncRef.current ? 0.5 : 0.75);
        setIsRadioBuffering(false);
      }
    },
  };

  const playPrev = () => {
    if (playerMode === "radio") {
      void radioPost<RadioState>("/radio/seek", { position: 0 }).then(applyRadioSnapshot).catch(() => undefined);
      return;
    }

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
    if (playerMode === "radio") {
      if (radioState?.status === "playing" && !isPlaying && audioRef.current) {
        void joinLiveRadioAudio(true);
        return;
      }
      const action = radioState?.status === "playing" ? "/radio/pause" : "/radio/play";
      void radioPost<RadioState>(action).then(applyRadioSnapshot).catch(() => undefined);
      return;
    }

    if (!currentTrack && queue.length > 0) {
      const nextTrack = isShuffle ? pickShuffleTrack(true) : queue[0];
      if (nextTrack) startTrack(nextTrack, queueSource);
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
    const nextVolume = clampVolume(val);
    volumeRef.current = nextVolume;
    setVolume(nextVolume);
    if (nextVolume > 0.01) {
      lastNonZeroVolumeRef.current = nextVolume;
      setLastNonZeroVolume(nextVolume);
    }
    if (audioRef.current) audioRef.current.volume = nextVolume;
  };

  const handlePitchChange = (val: number) => {
    setPlaybackPitch(val);
    if (playerMode === "radio" && radioState?.currentItem) {
      void radioPatch<RadioState>(`/radio/queue/${encodeURIComponent(radioState.currentItem.itemId)}`, { pitch: val })
        .then(applyRadioSnapshot)
        .catch(() => undefined);
      return;
    }

    if (audioRef.current) {
      audioRef.current.preservesPitch = false;
      audioRef.current.playbackRate = val;
    }
  };

  const handleSeek = (val: number) => {
    if (playerMode === "radio") {
      setCurrentTime(val);
      setVisualCurrentTime(val);
      void radioPost<RadioState>("/radio/seek", { position: val }).then(applyRadioSnapshot).catch(() => undefined);
      return;
    }

    if (audioRef.current) {
      audioRef.current.currentTime = val;
      setCurrentTime(val);
      setVisualCurrentTime(val);
    }
  };

  const updateShuffle = (val: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof val === "function" ? val(isShuffle) : val;
    setIsShuffle(next);
    if (next && playerMode !== "radio") {
      resetShuffleBag(queue, currentTrack?.id);
    }
    if (playerMode === "radio") {
      void radioPatch<RadioState>("/radio/settings", { shuffle: next }).then(applyRadioSnapshot).catch(() => undefined);
    }
  };

  const stop = () => {
    if (playerMode === "radio") {
      disableRadioMode();
    }
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
      const rawState = window.localStorage.getItem(playerStorageKey);
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
      const restoredVolume = clampVolume(typeof state.volume === "number" ? state.volume : 0.8);
      const restoredLastNonZeroVolume = clampVolume(
        typeof state.lastNonZeroVolume === "number"
          ? state.lastNonZeroVolume
          : restoredVolume > 0.01
            ? restoredVolume
            : 0.8,
      ) || 0.8;
      volumeRef.current = restoredVolume;
      lastNonZeroVolumeRef.current = restoredLastNonZeroVolume;
      setVolume(restoredVolume);
      setLastNonZeroVolume(restoredLastNonZeroVolume);
      setIsShuffle(typeof state.isShuffle === "boolean" ? state.isShuffle : true);
      setAutoRandomPitch(typeof state.autoRandomPitch === "boolean" ? state.autoRandomPitch : true);
      setLyricsEnabled(typeof state.lyricsEnabled === "boolean" ? state.lyricsEnabled : true);
      setIsPlaying(false);
    } catch {
      window.localStorage.removeItem(playerStorageKey);
    } finally {
      setStorageReady(true);
    }
  }, [playerStorageKey]);

  useEffect(() => {
    return () => {
      if (radioEventsRef.current) {
        radioEventsRef.current.close();
        radioEventsRef.current = null;
      }
    };
  }, []);

  // Cuantizamos el tiempo persistido a bloques de 5s: antes este efecto
  // serializaba la cola COMPLETA a localStorage en cada tick del audio
  // (~4 veces por segundo), un coste constante en el hilo principal.
  const persistedTime = Math.floor(currentTime / 5) * 5;

  useEffect(() => {
    if (typeof window === "undefined" || !storageReady) return;
    if (playerMode === "radio") return;

    const keepOnlyMobilePlaylistReference = isMobileRoute && (
      currentSource?.type === "global" || currentSource?.type === "private"
    );
    const state: StoredPlayerState = {
      currentTrack,
      // En movil la lista se recarga desde Farreo al volver a abrirla: asi no
      // persistimos una copia larga y potencialmente desactualizada.
      queue: keepOnlyMobilePlaylistReference ? [] : queue,
      queueSource: keepOnlyMobilePlaylistReference ? null : queueSource,
      currentSource,
      currentTime: persistedTime,
      playbackPitch,
      volume,
      lastNonZeroVolume,
      isShuffle,
      autoRandomPitch,
      lyricsEnabled,
    };

    window.localStorage.setItem(playerStorageKey, JSON.stringify(state));
  }, [autoRandomPitch, currentSource, isMobileRoute, persistedTime, currentTrack, isShuffle, lastNonZeroVolume, lyricsEnabled, playbackPitch, playerMode, playerStorageKey, queue, queueSource, storageReady, volume]);

  useEffect(() => {
    if (typeof window === "undefined" || !storageReady) return;

    try {
      const rawState = window.localStorage.getItem(playerStorageKey);
      const state = rawState ? JSON.parse(rawState) as Partial<StoredPlayerState> : {};
      window.localStorage.setItem(playerStorageKey, JSON.stringify({
        ...state,
        volume,
        lastNonZeroVolume,
      }));
    } catch {
      window.localStorage.setItem(playerStorageKey, JSON.stringify({
        volume,
        lastNonZeroVolume,
      }));
    }
  }, [lastNonZeroVolume, playerStorageKey, storageReady, volume]);

  useEffect(() => {
    if (!isPlaying) return;

    let frameId = 0;
    const syncVisualTime = () => {
      if (audioRef.current) {
        const now = window.performance.now();
        if (playerModeRef.current === "radio" && radioStateRef.current?.status === "playing") {
          if (now - lastRadioDriftCheckRef.current > 1000) {
            const livePosition = getLiveRadioPosition(radioStateRef.current);
            if (Math.abs(audioRef.current.currentTime - livePosition) > 0.9) {
              setIsRadioBuffering(audioRef.current.readyState < 3);
              try {
                audioRef.current.currentTime = livePosition;
              } catch {
                // Seeking can fail briefly while the browser is still loading metadata.
              }
            }
            lastRadioDriftCheckRef.current = now;
          }
        }

        if (
          now - lastVisualTimeUpdateRef.current > 250 ||
          Math.abs(audioRef.current.currentTime - visualCurrentTimeRef.current) > 0.75
        ) {
          lastVisualTimeUpdateRef.current = now;
          visualCurrentTimeRef.current = audioRef.current.currentTime;
          setVisualCurrentTime(audioRef.current.currentTime);
        }
      }
      frameId = window.requestAnimationFrame(syncVisualTime);
    };

    frameId = window.requestAnimationFrame(syncVisualTime);
    return () => window.cancelAnimationFrame(frameId);
  }, [isPlaying]);

  // Keep the <audio> src in sync with the current track for the cases that are
  // NOT time-critical (restoring from storage, radio snapshots). The local
  // auto-advance path already sets src imperatively inside startTrack so it
  // works in backgrounded tabs; this effect is idempotent (only touches the
  // element when the src actually differs) so it never reloads what startTrack
  // already loaded.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const url = currentTrack?.url || "";
    if (url) {
      if (audio.src !== url) {
        audio.src = url;
        audio.load();
      }
    } else if (audio.getAttribute("src")) {
      audio.removeAttribute("src");
      audio.load();
    }
  }, [currentTrack?.url]);

  // Precargar la siguiente cancion en el elemento inactivo (doble buffer) para
  // poder encadenar sin hueco en segundo plano. Solo en modo local.
  useEffect(() => {
    if (playerMode === "radio") return;
    if (!currentTrack || queue.length === 0) return;
    preloadNext();
    // preloadNext lee el estado actual via closure; no es una dependencia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, queue, isShuffle, autoRandomPitch, playerMode]);

  // Media Session API Sync
  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;

    if (currentTrack) {
      const artwork = currentTrack.iconUrl
        ? [{ src: getMediaUrl(currentTrack.iconUrl), sizes: "512x512", type: "image/png" }]
        : [
            { src: "/brand/farreo-f.png", sizes: "192x192", type: "image/png" },
            { src: "/brand/farreo.png", sizes: "512x512", type: "image/png" },
          ];
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.name,
        artist: "Farreo",
        album: currentSource?.name || "Farreo Player",
        artwork,
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
        // El sistema extrapola la posicion solo con playbackRate, asi que basta
        // con reenviarla cuando cambia duracion/pitch o tras un salto (seek);
        // llamarla en cada tick era una llamada al navegador 4 veces/segundo.
        const last = lastPositionStateRef.current;
        const expected = last.position + ((performance.now() - last.at) / 1000) * last.rate;
        const drift = Math.abs(safePosition - expected);
        if (last.duration === safeDuration && last.rate === playbackPitch && drift < 2) return;
        navigator.mediaSession.setPositionState({
          duration: safeDuration,
          playbackRate: playbackPitch,
          position: safePosition,
        });
        lastPositionStateRef.current = {
          duration: safeDuration,
          rate: playbackPitch,
          position: safePosition,
          at: performance.now(),
        };
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

  // Identidades estables para las funciones expuestas: los wrappers llaman
  // siempre a la version del ultimo render via apiRef. Sin esto, el value del
  // contexto cambiaria en cada render y todos los consumidores (paginas con
  // listas enteras de canciones) se re-renderizarian con cada tick del audio.
  const apiRef = useRef({
    loadQueue,
    playQueue,
    toggleTrack,
    playNext,
    playPrev,
    togglePlayPause,
    handleVolumeChange,
    handlePitchChange,
    handleSeek,
    updateShuffle,
    enableRadioMode,
    disableRadioMode,
    stop,
  });
  useEffect(() => {
    apiRef.current = {
      loadQueue,
      playQueue,
      toggleTrack,
      playNext,
      playPrev,
      togglePlayPause,
      handleVolumeChange,
      handlePitchChange,
      handleSeek,
      updateShuffle,
      enableRadioMode,
      disableRadioMode,
      stop,
    };
  });

  const stableApi = useMemo(() => ({
    loadQueue: (tracks: MusicTrack[], source?: MusicPlaylistSource | null) => apiRef.current.loadQueue(tracks, source),
    playQueue: (tracks: MusicTrack[], index: number, source?: MusicPlaylistSource | null) => apiRef.current.playQueue(tracks, index, source),
    toggleTrack: (track: MusicTrack, tracks?: MusicTrack[], source?: MusicPlaylistSource | null) => apiRef.current.toggleTrack(track, tracks, source),
    playNext: () => apiRef.current.playNext(),
    playPrev: () => apiRef.current.playPrev(),
    togglePlayPause: () => apiRef.current.togglePlayPause(),
    handleVolumeChange: (val: number) => apiRef.current.handleVolumeChange(val),
    handlePitchChange: (val: number) => apiRef.current.handlePitchChange(val),
    handleSeek: (val: number) => apiRef.current.handleSeek(val),
    setIsShuffle: (val: boolean | ((prev: boolean) => boolean)) => apiRef.current.updateShuffle(val),
    enableRadioMode: () => apiRef.current.enableRadioMode(),
    disableRadioMode: () => apiRef.current.disableRadioMode(),
    stop: () => apiRef.current.stop(),
  }), []);

  const canPlayNext = playerMode === "radio" ? Boolean(radioState?.currentItem) : queue.length > 1 || (!currentTrack && queue.length > 0);
  const canPlayPrev = playerMode === "radio" ? Boolean(radioState?.currentItem) : history.length > 0 || queue.length > 1;

  const contextValue = useMemo<MusicPlayerContextValue>(() => ({
    currentTrack,
    currentSource,
    hasCurrentLyrics,
    isPlaying,
    playbackPitch,
    volume,
    duration,
    isShuffle,
    canPlayNext,
    canPlayPrev,
    autoRandomPitch,
    lyricsEnabled,
    playerMode,
    isRadioBuffering,
    isRadioAwaitingUserGesture,
    radioState,
    getAudioFrequencyData,
    setAutoRandomPitch,
    setLyricsEnabled,
    ...stableApi,
  }), [autoRandomPitch, canPlayNext, canPlayPrev, currentSource, currentTrack, duration, getAudioFrequencyData, hasCurrentLyrics, isPlaying, isRadioAwaitingUserGesture, isRadioBuffering, isShuffle, lyricsEnabled, playbackPitch, playerMode, radioState, stableApi, volume]);

  const timeContextValue = useMemo<MusicPlayerTimeContextValue>(() => ({
    currentTime,
    visualCurrentTime,
    currentLyric,
  }), [currentLyric, currentTime, visualCurrentTime]);
  const currentSourceHref = getSourceHref(currentSource);
  const showDesktopPlayer = !pathname.startsWith("/admin") && !pathname.startsWith("/mobile");

  return (
    <MusicPlayerContext.Provider value={contextValue}>
      <MusicPlayerTimeContext.Provider value={timeContextValue}>
      {children}

      {showDesktopPlayer && (
      <>
      <LyricsDisplay lyric={currentLyric} visible={lyricsEnabled && hasCurrentLyrics} />
      <div className="playlist-admin__player">
        <div className="playlist-admin__now-playing">
          {currentTrack ? (
            <div className="playlist-admin__now-playing-inner">
              <SongArtwork src={currentTrack.iconUrl} alt={currentTrack.name} className="playlist-admin__now-playing-artwork" />
              <div className="playlist-admin__now-playing-text">
                <span className="playlist-admin__now-playing-title">{currentTrack.name}</span>
                {currentSource && (
                  currentSourceHref ? (
                    <Link href={currentSourceHref} className="playlist-admin__now-playing-source playlist-admin__now-playing-source--link">
                      {currentSource.name}
                    </Link>
                  ) : (
                    <span className="playlist-admin__now-playing-source">{currentSource.name}</span>
                  )
                )}
                {playerMode === "radio" && isRadioBuffering && (
                  <span className="playlist-admin__now-playing-sync">Sincronizando radio...</span>
                )}
                {playerMode === "radio" && isRadioAwaitingUserGesture && (
                  <span className="playlist-admin__now-playing-sync">Pulsa play para unirte</span>
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
              </div>
            </div>
          ) : (
            <span className="playlist-admin__now-playing-title" style={{ color: "#666" }}>Sin canción</span>
          )}
        </div>

        <div className="playlist-admin__player-center">
          <div className="playlist-admin__player-buttons">
            <button
              className={`playlist-admin__control-btn playlist-admin__control-btn--shuffle ${isShuffle ? "playlist-admin__control-btn--active" : ""}`}
              onClick={() => updateShuffle((v) => !v)}
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

          <PlayerProgressBar />
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
              onClick={() => handleVolumeChange(volume > 0 ? 0 : lastNonZeroVolumeRef.current || lastNonZeroVolume || 0.8)}
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
        ref={(el) => {
          elARef.current = el;
          if (activeIdRef.current === "a") audioRef.current = el;
        }}
        crossOrigin="anonymous"
        preload="auto"
        style={{ display: "none" }}
        {...audioEventProps}
      />
      <audio
        ref={(el) => {
          elBRef.current = el;
          if (activeIdRef.current === "b") audioRef.current = el;
        }}
        crossOrigin="anonymous"
        preload="auto"
        style={{ display: "none" }}
        {...audioEventProps}
      />
      </MusicPlayerTimeContext.Provider>
    </MusicPlayerContext.Provider>
  );
}
