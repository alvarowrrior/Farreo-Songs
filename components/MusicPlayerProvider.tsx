"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, useEffect, useLayoutEffect, type ReactNode, type SyntheticEvent } from "react";
import { ArrowRightIcon, DicesIcon, LoaderCircleIcon, Mic2Icon, PauseIcon, PlayIcon, RotateCcwIcon, ShuffleIcon, SkipBackIcon, SkipForwardIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MUSIC_API_URL, calibrateRadioClock, getLiveRadioPosition, getMediaUrl, getRadioServerNow, radioPatch, radioPost, type RadioState } from "@/lib/radioApi";
import { computeCurrentLyric } from "@/lib/lyrics";
import SongArtwork from "@/components/SongArtwork";
import staticLyricsStyles from "./StaticLyricsPopover.module.scss";
import { claimAlbumFirstPlay } from "@/lib/albums";
import { recordSongListened } from "@/lib/listeningHistory";
import { notifyYoutubeVideoSeek, prepareYoutubeVideoStart } from "@/lib/youtubeVideoStartCoordinator";
import { prepareAdvancedCoverBeforeAudio, shouldPrepareAdvancedCover } from "@/lib/advancedCoverStartPreparation";
import { getYoutubeVideoWaitForReady } from "@/lib/youtubeVideoBackgroundPreference";

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
  albumId?: string;
  albumEntryId?: string;
  firstListenPending?: boolean;
}

export interface MusicPlaylistSource {
  id: string;
  name: string;
  type: "global" | "private" | "album" | "song" | "admin" | "radio";
}

export type PlaybackQueuePitch = { kind: "random" } | { kind: "fixed"; pitch: number };
export type PlaybackQueuePosition = "next" | "last" | "now";
export interface PlaybackQueueEntry {
  key: string;
  track: MusicTrack;
  source: MusicPlaylistSource | null;
  pitch: PlaybackQueuePitch;
  manual: boolean;
  placement?: "next" | "last";
}

export interface PlaybackShuffleSource {
  source: MusicPlaylistSource;
  count: number;
}

interface MusicPlayerContextValue {
  currentTrack: MusicTrack | null;
  currentSource: MusicPlaylistSource | null;
  nextTrackId: string | null;
  playbackHistory: PlaybackQueueEntry[];
  playbackUpcoming: PlaybackQueueEntry[];
  playbackQueueCleared: boolean;
  playbackShuffleSources: PlaybackShuffleSource[];
  playbackShuffleSourceKey: string | null;
  selectPlaybackShuffleSource: (
    source: MusicPlaylistSource | null, tracks?: MusicTrack[],
    sourceByTrackId?: Map<string, MusicPlaylistSource>,
  ) => void;
  addToPlaybackQueue: (track: MusicTrack, position: PlaybackQueuePosition, pitch: PlaybackQueuePitch, source?: MusicPlaylistSource | null) => void;
  removeFromPlaybackQueue: (key: string) => void;
  clearPlaybackHistory: () => void;
  clearPlaybackUpcoming: () => void;
  playPlaybackQueueEntry: (key: string) => void;
  reorderPlaybackQueueEntry: (key: string, targetIndex: number) => void;
  hasCurrentLyrics: boolean;
  isPlaying: boolean;
  playbackPitch: number;
  volume: number;
  duration: number;
  isShuffle: boolean;
  canPlayNext: boolean;
  canPlayPrev: boolean;
  autoRandomPitch: boolean;
  isPitchLocked: boolean;
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
  restoreLocalPlayer: (snapshot: LocalPlayerRestoreState) => void;
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
  if (source.type === "album") return `/album/${encodeURIComponent(source.id)}`;
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

type LocalPlayerRestoreState = Omit<StoredPlayerState, "lastNonZeroVolume"> & {
  lastNonZeroVolume?: number;
  duration?: number;
};

// La respuesta de una playlist incluye letras y otros metadatos que pueden ser
// bastante grandes. Persistirlos una vez por cada elemento de la cola puede
// superar facilmente la cuota de localStorage en playlists largas.
const compactQueuedTrack = (track: MusicTrack): MusicTrack => ({
  id: track.id,
  name: track.name,
  url: track.url,
  duration: track.duration,
  iconUrl: track.iconUrl,
  addedAt: track.addedAt,
  createdAt: track.createdAt,
  albumId: track.albumId,
  albumEntryId: track.albumEntryId,
  firstListenPending: track.firstListenPending,
});

const writeStoredPlayerState = (
  storage: Storage,
  key: string,
  state: Partial<StoredPlayerState>,
) => {
  try {
    storage.setItem(key, JSON.stringify(state));
    return;
  } catch {
    // Un estado antiguo puede estar ocupando casi toda la cuota. Lo retiramos
    // antes de intentar la version minima para que este fallo nunca alcance a
    // React como una excepcion no controlada.
    try {
      storage.removeItem(key);
      storage.setItem(key, JSON.stringify({
        currentTrack: state.currentTrack ? compactQueuedTrack(state.currentTrack) : null,
        currentSource: state.currentSource ?? null,
        currentTime: state.currentTime ?? 0,
        playbackPitch: state.playbackPitch ?? 1,
        volume: state.volume ?? 0.8,
        lastNonZeroVolume: state.lastNonZeroVolume ?? 0.8,
        isShuffle: state.isShuffle ?? true,
        autoRandomPitch: state.autoRandomPitch ?? true,
        lyricsEnabled: state.lyricsEnabled ?? true,
        queue: [],
        queueSource: null,
      }));
    } catch {
      // El reproductor sigue siendo usable aunque el navegador no permita
      // guardar nada (modo privado, cuota agotada o almacenamiento bloqueado).
    }
  }
};

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

// A YouTube audio URL is a live, on-demand proxy stream, not a normal MP3.
// Speculatively opening it on an inactive <audio> can exhaust/close its upstream
// connection before the element becomes active. Start it on the active player.
const isYoutubeProxyTrack = (track: MusicTrack | null | undefined) => Boolean(
  track && (track.id.startsWith("youtube:") ||
    /\/youtube-tracks\/[a-zA-Z0-9_-]{11}\/audio(?:[?#]|$)/.test(track.url || "")),
);

// Custom video covers also need the normal start path at automatic transitions.
const needsDirectAudioStart = (track: MusicTrack | null | undefined) => Boolean(
  isYoutubeProxyTrack(track) || (track?.advancedCoverType === "video" && track.advancedCoverUrl),
);

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
  const { currentTrack, hasCurrentLyrics, lyricsEnabled } = useMusicPlayer();
  const { currentLyric } = useMusicPlayerTime();
  const [staticLyricsOpen, setStaticLyricsOpen] = useState(false);
  const trackId = currentTrack?.id;
  useEffect(() => { setStaticLyricsOpen(false); }, [trackId]);
  if (!lyricsEnabled) return null;
  if (hasCurrentLyrics) return <LyricsDisplay lyric={currentLyric} visible />;
  if (!currentTrack?.staticLyrics) return null;
  return (
    <div className={staticLyricsStyles.root}>
      <button
        type="button"
        className={staticLyricsStyles.toggle}
        onClick={() => setStaticLyricsOpen((open) => !open)}
        aria-expanded={staticLyricsOpen}
        aria-label={staticLyricsOpen ? "Ocultar letra" : "Ver letra de la canción"}
      >
        <Mic2Icon size={17} /> {staticLyricsOpen ? "Ocultar letra" : "Ver letra"}
      </button>
      {staticLyricsOpen && (
        <section className={staticLyricsStyles.panel} aria-label={`Letra de ${currentTrack.name}`}>
          <div className={staticLyricsStyles.heading}>
            <strong>{currentTrack.name}</strong>
            <span>Letra no sincronizada</span>
          </div>
          <pre className={staticLyricsStyles.lyrics}>{currentTrack.staticLyrics}</pre>
        </section>
      )}
    </div>
  );
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
  // Unplayed candidates are NOT ordered. Only the next two are drawn and
  // reserved, so the UI, audio preloader and actual next track always agree.
  const shuffleRemainingRef = useRef<string[]>([]);
  const shuffleQueueSignatureRef = useRef("");
  const plannedAutomaticRef = useRef<PlaybackQueueEntry[]>([]);
  const shuffleSourceRef = useRef<{source: MusicPlaylistSource; tracks: MusicTrack[]} | null>(null);
  // In "Todas" the active pool is a union, but each selected song retains its
  // REAL playlist, so the queue, video background and next-track UI stay correct.
  const shuffleOriginRef = useRef<Map<string, MusicPlaylistSource> | null>(null);
  const playlistCursorIdRef = useRef<string | null>(null);
  // Number of automatic playlist tracks left in the current sequential pass.
  const playlistRemainingRef = useRef(0);
  const recentlyPlayedIdsRef = useRef<string[]>([]);
  const manualQueueRef = useRef<PlaybackQueueEntry[]>([]);
  const upcomingClearedRef = useRef(false);
  const entryCounterRef = useRef(0);
  // A reorder is a real playback decision, not a client-only decoration.
  // Store the order in refs so audio events, preload and UI see the same first item.
  const upcomingOrderRef = useRef<string[]>([]);
  const [upcomingOrder, setUpcomingOrder] = useState<string[]>([]);
  // Sequential playlists calculate their following songs from a cursor.
  // Pin the two visible choices while they are being reordered so an out-of-
  // sequence play does not make the other song vanish from the queue.
  const sequentialPinsRef = useRef<PlaybackQueueEntry[]>([]);
  const [sequentialPinsVersion, setSequentialPinsVersion] = useState(0);
  const resetUpcomingOrder = () => {
    upcomingOrderRef.current = [];
    setUpcomingOrder([]);
    sequentialPinsRef.current = [];
    setSequentialPinsVersion((n) => n + 1);
  };
  const removeSequentialPin = (key: string) => {
    const before = sequentialPinsRef.current.length;
    sequentialPinsRef.current = sequentialPinsRef.current.filter((item) => item.key !== key);
    if (before !== sequentialPinsRef.current.length) setSequentialPinsVersion((n) => n + 1);
  };

  const lastPositionStateRef = useRef({ duration: -1, rate: -1, position: 0, at: 0 });
  // Radio may change pitch/shuffle/volume for the shared station. None of those
  // mutations is allowed to become the user's persistent LOCAL preferences.
  const personalSettingsBeforeRadioRef = useRef<{
    volume: number;
    lastNonZeroVolume: number;
    playbackPitch: number;
    isShuffle: boolean;
    autoRandomPitch: boolean;
    lyricsEnabled: boolean;
  } | null>(null);
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
  // Playback intent is separate from isPlaying: a stalled YouTube stream may
  // never emit "playing", but still needs to be retried automatically.
  const localPlaybackIntentRef = useRef(false);

  const pitchLockedRef = useRef(false);
  // Initial state restoration has its own ONE-SHOT seek. Never reuse the
  // previous track's React currentTime during normal gapless transitions.
  const startupResumeRef = useRef<{ url: string; position: number } | null>(null);
  const localVideoStartAbortRef = useRef<AbortController | null>(null);
  const localVideoStartGenerationRef = useRef(0);
  const preloadedAdvanceTrackIdRef = useRef<string | null>(null);
  // Automatic gapless fallback must never wait for optional visuals by default.
  const bypassVisualPreparationOnceRef = useRef(false);
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
  const [isPlaybackPreparing, setIsPlaybackPreparing] = useState(false);
  const [playbackPitch, setPlaybackPitch] = useState(1);
  const [volume, setVolume] = useState(0.8);
  const [lastNonZeroVolume, setLastNonZeroVolume] = useState(0.8);
  const [currentTime, setCurrentTime] = useState(0);
  const [visualCurrentTime, setVisualCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isShuffle, setIsShuffle] = useState(true);
  const [autoRandomPitch, setAutoRandomPitch] = useState(true);
  const [isPitchLocked, setIsPitchLocked] = useState(false);
  const [lyricsEnabled, setLyricsEnabled] = useState(true);
  const [history, setHistory] = useState<PlaybackQueueEntry[]>([]);
  const [manualQueue, setManualQueue] = useState<PlaybackQueueEntry[]>([]);
  const [upcomingCleared, setUpcomingCleared] = useState(false);
  const [shuffleVersion, setShuffleVersion] = useState(0);
  const [plannedAutomatic, setPlannedAutomatic] = useState<PlaybackQueueEntry[]>([]);
  const [shuffleSource, setShuffleSource] = useState<{source: MusicPlaylistSource; tracks: MusicTrack[]} | null>(null);
  // Synchronous mirrors: a media event can fire before React commits an update.
  manualQueueRef.current = manualQueue;
  upcomingClearedRef.current = upcomingCleared;
  const nextKey = () => `local-${++entryCounterRef.current}-${Date.now().toString(36)}`;
  const updateManualQueue = (entries: PlaybackQueueEntry[]) => {
    manualQueueRef.current = entries;
    setManualQueue(entries);
  };
  const setFutureCleared = (value: boolean) => {
    upcomingClearedRef.current = value;
    setUpcomingCleared(value);
  };
  const addHistory = () => {
    if (!currentTrack) return;
    const previous: PlaybackQueueEntry = {
      key: nextKey(), track: currentTrack, source: currentSource,
      pitch: { kind: "fixed", pitch: playbackPitch }, manual: false,
    };
    recentlyPlayedIdsRef.current = [...recentlyPlayedIdsRef.current.slice(-31), currentTrack.id];
    setHistory((existing) => [...existing.slice(-199), previous]);
  };

  const lyricCues = useMemo(() => parseSrt(currentTrack?.lyricsSrt), [currentTrack?.lyricsSrt]);
  const hasCurrentLyrics = lyricCues.length > 0;
  const currentLyric = useMemo<CurrentLyric | null>(
    () => computeCurrentLyric(lyricCues, currentTime, duration),
    [currentTime, duration, lyricCues],
  );

  const currentTrackId = currentTrack?.id;
  useEffect(() => {
    if (currentTrackId && isPlaying) recordSongListened(currentTrackId);
  }, [currentTrackId, isPlaying]);

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
  const getSourceKey = (source: MusicPlaylistSource) => `${source.type}:${source.id}`;
  const updateAutomaticPlan = (entries: PlaybackQueueEntry[]) => {
    plannedAutomaticRef.current = entries;
    setPlannedAutomatic(entries);
  };

  const resetShuffleBag = useCallback((tracks: MusicTrack[], currentId?: string | null) => {
    const seen = new Set<string>();
    shuffleQueueSignatureRef.current = getQueueSignature(tracks);
    // This is a candidate pool, NOT a shuffled playback order. Selecting all
    // 150+ future titles in advance was both confusing and unnecessary.
    shuffleRemainingRef.current = tracks.map((track) => track.id).filter((id) => {
      if (!id || id === currentId || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    plannedAutomaticRef.current = [];
    setPlannedAutomatic([]);
    setShuffleVersion((version) => version + 1);
  }, []);

  const activeShufflePlaylist = () => shuffleSourceRef.current ?? { source: queueSource, tracks: queue };
  const consumePlannedAutomatic = (trackId: string) => {
    const entries = plannedAutomaticRef.current;
    const index = entries.findIndex((entry) => entry.track.id === trackId);
    if (index < 0) return;
    updateAutomaticPlan(entries.filter((_, i) => i !== index));
  };

  const refillAutomaticWindow = (
    tracks: MusicTrack[], source: MusicPlaylistSource | null,
    currentId: string | null | undefined, hasManualTail: boolean,
  ) => {
    if (playerModeRef.current === "radio" || upcomingClearedRef.current || !tracks.length) return;
    const byId = new Map(tracks.filter((track) => Boolean(track.url)).map((track) => [track.id, track]));
    const old = plannedAutomaticRef.current;
    const entries = old.filter((entry) => entry.track.id !== currentId && byId.has(entry.track.id));
    const originallyDifferent = entries.length !== old.length;
    // Keep exactly TWO committed automatic selections. Manual insertions are
    // separate, preserving all user-selected entries and their priorities.
    while (entries.length < 2) {
      let available = shuffleRemainingRef.current.filter((id) => byId.has(id) && id !== currentId && !entries.some((e) => e.track.id === id));
      if (!available.length) {
        if (hasManualTail || byId.size <= 1) break;
        // A new cycle begins only when the preceding candidate bag has run
        // out. The last heard songs are held back whenever alternatives exist.
        available = [...byId.keys()].filter((id) => id !== currentId && !entries.some((e) => e.track.id === id));
        if (!available.length) break;
        shuffleRemainingRef.current = available;
      }
      const recentWindow = Math.min(8, Math.max(1, Math.floor(byId.size / 5)));
      const recent = new Set(recentlyPlayedIdsRef.current.slice(-recentWindow));
      const preferred = available.filter((id) => !recent.has(id));
      const candidates = preferred.length ? preferred : available;
      const id = candidates[Math.floor(Math.random() * candidates.length)];
      const track = byId.get(id);
      if (!track) break;
      shuffleRemainingRef.current = shuffleRemainingRef.current.filter((item) => item !== id);
      const actualSource = shuffleOriginRef.current?.get(id) ?? source;
      entries.push({
        key: `playlist:${getSourceKey(actualSource ?? { id: "local", type: "song", name: "Playlist" })}:${id}`,
        track, source: actualSource, pitch: { kind: "random" }, manual: false,
      });
    }
    if (originallyDifferent || entries.length !== old.length || entries.some((e,i) => e.key !== old[i]?.key)) {
      updateAutomaticPlan(entries);
    }
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
    // Keep the inactive decoder silent even after a rapid local->radio switch.
    const inactive = activeIdRef.current === "a" ? elBRef.current : elARef.current;
    if (inactive && !inactive.paused) inactive.pause();
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

    // Radio transitions must switch the media source imperatively. Waiting for
    // the React currentTrack effect can leave an ended <audio> on the previous
    // source long enough for the scheduled play() to target the wrong song.
    // This mirrors the local player's background-safe source switching.
    if (itemChanged && audioBeforeSync && track.url) {
      pendingPlayRef.current = false;
      try {
        audioBeforeSync.pause();
        audioBeforeSync.src = track.url;
        audioBeforeSync.load();
      } catch {
        // The idempotent currentTrack effect remains a fallback.
      }
    }

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
      // An earlier snapshot may have scheduled this callback just before
      // the station advanced. Never use its old audio/pitch/position.
      if (playerModeRef.current !== "radio" ||
        radioStateRef.current?.currentItem?.itemId !== item.itemId) return;
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
    // Capture exactly once, BEFORE the first radio snapshot modifies the
    // shared React states. A reconnect while already in Radio must not replace
    // this with station values.
    if (playerModeRef.current !== "radio") {
      personalSettingsBeforeRadioRef.current = {
        volume: volumeRef.current,
        lastNonZeroVolume: lastNonZeroVolumeRef.current,
        playbackPitch,
        isShuffle,
        autoRandomPitch,
        lyricsEnabled,
      };
    }
    cancelLocalVideoPreparation();
    localPlaybackIntentRef.current = false;
    // The two physical media elements are used for local gapless playback.
    // Only ONE may remain audible after joining Radio. A buffered/outgoing
    // local element otherwise survives offscreen and doubles the sound while
    // the Radio slider controls only audioRef.current.
    const inactive = activeIdRef.current === "a" ? elBRef.current : elARef.current;
    if (inactive) {
      try {
        inactive.pause();
        inactive.removeAttribute("src");
        inactive.load();
        inactive.volume = volumeRef.current;
      } catch { /* best effort */ }
    }
    preloadedTrackRef.current = null;
    preloadedUrlRef.current = "";
    preloadedAdvanceTrackIdRef.current = null;
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
    const previous = personalSettingsBeforeRadioRef.current;
    personalSettingsBeforeRadioRef.current = null;
    if (previous) {
      // Restore the complete local configuration, not the station's pitch or
      // shuffle. When a full local-player snapshot follows, it may overwrite
      // these with the saved local track's exact values.
      volumeRef.current = previous.volume;
      lastNonZeroVolumeRef.current = previous.lastNonZeroVolume;
      setVolume(previous.volume);
      setLastNonZeroVolume(previous.lastNonZeroVolume);
      setPlaybackPitch(previous.playbackPitch);
      setIsShuffle(previous.isShuffle);
      setAutoRandomPitch(previous.autoRandomPitch);
      setLyricsEnabled(previous.lyricsEnabled);
      if (elARef.current) elARef.current.volume = previous.volume;
      if (elBRef.current) elBRef.current.volume = previous.volume;
    }
    setPlayerMode("local");
    setIsRadioBuffering(false);
    setRadioAwaitingGesture(false);
    pendingRadioJoinSyncRef.current = false;
    scheduledRadioStartRef.current = null;
    lastRadioItemRef.current = null;
  };

  const cancelLocalVideoPreparation = () => {
    localVideoStartGenerationRef.current += 1;
    localVideoStartAbortRef.current?.abort();
    localVideoStartAbortRef.current = null;
    setIsPlaybackPreparing(false);
  };

  const restoreLocalPlayer = (snapshot: LocalPlayerRestoreState) => {
    cancelLocalVideoPreparation();
    startupResumeRef.current = null;
    pendingPlayRef.current = false;
    preloadedTrackRef.current = null;
    preloadedUrlRef.current = "";
    preloadedAdvanceTrackIdRef.current = null;
    disableRadioMode();

    localPlaybackIntentRef.current = false;
    const restoredTrack = snapshot.currentTrack ?? null;
    const restoredQueue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
    const restoredTime = Number.isFinite(snapshot.currentTime)
      ? Math.max(0, snapshot.currentTime)
      : 0;
    const restoredPitch = Number.isFinite(snapshot.playbackPitch)
      ? Math.max(0.5, Math.min(1.5, snapshot.playbackPitch))
      : 1;
    const restoredVolume = clampVolume(
      Number.isFinite(snapshot.volume) ? snapshot.volume : 0.8,
    );
    const restoredLastNonZeroVolume = clampVolume(
      typeof snapshot.lastNonZeroVolume === "number"
        && Number.isFinite(snapshot.lastNonZeroVolume)
        ? snapshot.lastNonZeroVolume
        : restoredVolume > 0.01
          ? restoredVolume
          : 0.8,
    ) || 0.8;

    volumeRef.current = restoredVolume;
    lastNonZeroVolumeRef.current = restoredLastNonZeroVolume;
    pitchLockedRef.current = false;

    shuffleSourceRef.current = null;
    shuffleOriginRef.current = null;
    setShuffleSource(null);
    resetUpcomingOrder();
    setQueue(restoredQueue);
    setQueueSource(snapshot.queueSource ?? null);
    setCurrentTrack(restoredTrack);
    setCurrentSource(snapshot.currentSource ?? null);
    setPlaybackPitch(restoredPitch);
    setVolume(restoredVolume);
    setLastNonZeroVolume(restoredLastNonZeroVolume);
    setIsShuffle(snapshot.isShuffle);
    setAutoRandomPitch(snapshot.autoRandomPitch);
    setLyricsEnabled(snapshot.lyricsEnabled);
    setHistory([]);
    updateManualQueue([]);
    resetUpcomingOrder();
    setFutureCleared(false);
    playlistCursorIdRef.current = restoredTrack?.id ?? null;
    resetShuffleBag(restoredQueue, restoredTrack?.id);
    playlistRemainingRef.current = Math.max(0, restoredQueue.length - 1);
    setIsPitchLocked(false);
    setCurrentTime(restoredTime);
    setVisualCurrentTime(restoredTime);
    setDuration(snapshot.duration || restoredTrack?.duration || 0);
    setIsPlaying(false);
    setIsRadioBuffering(false);

    const audio = audioRef.current;
    if (!audio) return;

    audio.pause();
    audio.preservesPitch = false;
    audio.defaultPlaybackRate = restoredPitch;
    audio.playbackRate = restoredPitch;
    audio.volume = restoredVolume;

    if (!restoredTrack?.url) {
      audio.removeAttribute("src");
      audio.load();
      return;
    }

    audio.src = restoredTrack.url;
    audio.load();

    const restorePosition = () => {
      if (audioRef.current !== audio) return;
      try {
        const safeTime = Number.isFinite(audio.duration) && audio.duration > 0
          ? Math.min(restoredTime, Math.max(0, audio.duration - 0.05))
          : restoredTime;
        audio.currentTime = safeTime;
      } catch {
        // A later metadata event/state render can retry the stored position.
      }
    };

    if (audio.readyState >= 1) {
      restorePosition();
    } else {
      audio.addEventListener("loadedmetadata", restorePosition, { once: true });
    }
  };

  const prepareLocalVideoStart = async (
    track: MusicTrack,
    source: MusicPlaylistSource | null,
  ) => {
    const generation = localVideoStartGenerationRef.current + 1;
    localVideoStartGenerationRef.current = generation;
    localVideoStartAbortRef.current?.abort();

    const controller = new AbortController();
    localVideoStartAbortRef.current = controller;
    setIsPlaybackPreparing(false);

    const wantsAdvancedCover = shouldPrepareAdvancedCover(track, source);
    let waitingForBackgroundVideo = false;
    let waitingForAdvancedCover = wantsAdvancedCover;
    const reportWaiting = () => {
      if (
        localVideoStartGenerationRef.current === generation
        && localVideoStartAbortRef.current === controller
        && !controller.signal.aborted
      ) {
        setIsPlaybackPreparing(waitingForBackgroundVideo || waitingForAdvancedCover);
      }
    };
    reportWaiting();
    // Both visual assets are prepared concurrently. Audio is already buffering;
    // neither image requests in the song list nor one optional visual can race
    // ahead and trigger play() before the other finishes its own preparation.
    await Promise.allSettled([
      // The user's "No esperar al videoclip" setting must apply to EVERY
      // local start, not only the preloaded/gapless branch. The background
      // component's own effect attaches the video asynchronously instead.
      getYoutubeVideoWaitForReady() ? prepareYoutubeVideoStart({
        trackId: track.id,
        source,
        signal: controller.signal,
        onWaitingChange: (waiting) => {
          waitingForBackgroundVideo = waiting;
          reportWaiting();
        },
      }) : Promise.resolve(),
      prepareAdvancedCoverBeforeAudio(track, source, controller.signal)
        .finally(() => {
          waitingForAdvancedCover = false;
          reportWaiting();
        }),
    ]);

    const stillCurrent = (
      !controller.signal.aborted
      && localVideoStartGenerationRef.current === generation
      && localVideoStartAbortRef.current === controller
    );

    if (stillCurrent) {
      localVideoStartAbortRef.current = null;
      setIsPlaybackPreparing(false);
    }

    return stillCurrent;
  };

  const startTrack = (track: MusicTrack, source = queueSource, pitchChoice?: PlaybackQueuePitch) => {
    const personalPitchOnRadioExit = playerModeRef.current === "radio"
      ? personalSettingsBeforeRadioRef.current : null;
    localPlaybackIntentRef.current = true;
    // Manual insertions do not advance the underlying playlist cursor, even
    // when the manually selected song also belongs to that playlist.
    if (!pitchChoice && queue.some((entry) => entry.id === track.id)
      && (!source || !queueSource || source.id === queueSource.id)) {
      playlistCursorIdRef.current = track.id;
    }
    if (!track.url) return;
    const bypassVisualPreparation = bypassVisualPreparationOnceRef.current;
    bypassVisualPreparationOnceRef.current = false;
    // Invalidate an earlier start before the first asynchronous album claim.
    // Otherwise its completion could select/play an obsolete song later.
    cancelLocalVideoPreparation();
    startupResumeRef.current = null;
    preloadedAdvanceTrackIdRef.current = null;
    const startGeneration = localVideoStartGenerationRef.current;
    if (playerMode === "radio") {
      disableRadioMode();
    }

    const beginPlayback = async () => {
      let forcePitch = false;
      let nextTrack = track;
      if (track.firstListenPending && track.albumId && track.albumEntryId) {
        try {
          const claim = await claimAlbumFirstPlay(track.albumId, track.albumEntryId);
          if (startGeneration !== localVideoStartGenerationRef.current) return;
          forcePitch = claim.forcePitch;
          if (claim.firstPlay || !claim.forcePitch) {
            nextTrack = { ...track, firstListenPending: false };
            setQueue((current) => current.map((item) => item.albumEntryId === track.albumEntryId ? nextTrack : item));
          }
        } catch {
          if (startGeneration !== localVideoStartGenerationRef.current) return;
          // Conservador: si no podemos confirmar la primera escucha, mantenemos x1
          // y reintentamos guardar el comienzo sin desbloquear esta reproduccion.
          forcePitch = true;
          window.setTimeout(() => {
            void claimAlbumFirstPlay(track.albumId!, track.albumEntryId!).then(() => {
              setQueue((current) => current.map((item) => item.albumEntryId === track.albumEntryId
                ? { ...item, firstListenPending: false }
                : item));
              setCurrentTrack((current) => current && current.albumEntryId === track.albumEntryId
                ? { ...current, firstListenPending: false }
                : current);
            }).catch(() => undefined);
          }, 3000);
        }
      }

      if (startGeneration !== localVideoStartGenerationRef.current) return;

      pitchLockedRef.current = forcePitch;
      setIsPitchLocked(forcePitch);

      if (isShuffle) {
        shuffleRemainingRef.current = shuffleRemainingRef.current.filter((id) => id !== nextTrack.id);
      }

      let pitch = forcePitch ? 1 : personalPitchOnRadioExit?.playbackPitch ?? playbackPitch;
      if (!forcePitch && pitchChoice) {
        pitch = pitchChoice.kind === "random"
          ? Math.random() * (1.2 - 0.8) + 0.8
          : Math.max(0.5, Math.min(1.5, pitchChoice.pitch));
      } else if (!forcePitch && (personalPitchOnRadioExit?.autoRandomPitch ?? autoRandomPitch)) {
        pitch = Math.random() * (1.2 - 0.8) + 0.8;
      }
      setPlaybackPitch(pitch);

      // New local starts own the decision to call play(). Metadata/canplay are
      // allowed to load while a videoclip is being prepared, but they may not
      // start audio early.
      pendingPlayRef.current = false;
      preloadedTrackRef.current = null;
      preloadedUrlRef.current = "";
      preloadedAdvanceTrackIdRef.current = null;
      setCurrentTrack(nextTrack);
      setCurrentSource(source);
      setCurrentTime(0);
      setVisualCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);

      const audio = audioRef.current;
      if (!audio) return;

      // Load immediately so the audio itself can buffer while the optional
      // background prepares. Crucially, there is no play() before the await.
      audio.src = nextTrack.url!;
      audio.load();
      audio.preservesPitch = false;
      audio.defaultPlaybackRate = pitch;
      audio.playbackRate = pitch;
      audio.volume = volumeRef.current;

      const hiddenTab = document.visibilityState !== "visible";
      const mayStart = hiddenTab || bypassVisualPreparation
        ? true
        : await prepareLocalVideoStart(nextTrack, source ?? null);
      if (
        !mayStart
        || audioRef.current !== audio
        || (hiddenTab && startGeneration !== localVideoStartGenerationRef.current)
      ) return;

      pendingPlayRef.current = true;
      void audio.play()
        .then(() => {
          if (audioRef.current === audio) pendingPlayRef.current = false;
        })
        .catch(() => {
          // onLoadedMetadata / onCanPlay can retry while pendingPlayRef is true.
        });
    };

    void beginPlayback();
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
    shuffleSourceRef.current = null;
    shuffleOriginRef.current = null;
    setShuffleSource(null);
    resetShuffleBag(tracks, track.id);
    playlistCursorIdRef.current = track.id;
    playlistRemainingRef.current = Math.max(0, tracks.length - 1);
    updateManualQueue([]);
    setFutureCleared(false);
    setQueue(tracks);
    setQueueSource(source ?? null);
    setHistory([]);
    resetUpcomingOrder();
    startTrack(track, source ?? null);
  };

  const loadQueue = useCallback((tracks: MusicTrack[], source?: MusicPlaylistSource | null) => {
    if (playerMode === "radio") return;
    // Merely opening a different playlist must not silently replace the one
    // that is currently playing or wipe manually inserted queue entries.
    // The ongoing session is owned by queueSource (A), not by currentSource.
    // A manually queued song from B may temporarily be current; loading B's
    // page must NOT overwrite A's candidate pool or strand its two picks.
    if (currentTrack && queueSource && source &&
      (queueSource.id !== source.id || queueSource.type !== source.type)) return;
    if (getQueueSignature(tracks) === getQueueSignature(queue)
      && source?.id === queueSource?.id && source?.type === queueSource?.type) return;
    // Live playlist edits may update metadata/order without wiping history.
    if (currentTrack && currentSource) {
      setQueue(tracks);
      setQueueSource(source ?? null);
      if (!shuffleSourceRef.current && shuffleQueueSignatureRef.current !== getQueueSignature(tracks)) {
        resetUpcomingOrder();
        resetShuffleBag(tracks, currentTrack.id);
        playlistRemainingRef.current = Math.max(0, tracks.length - 1);
      }
      return;
    }
    if (!shuffleSourceRef.current) resetShuffleBag(tracks, currentTrack?.id);
    resetUpcomingOrder();
    playlistRemainingRef.current = currentTrack ? Math.max(0, tracks.length - 1) : tracks.length;
    playlistCursorIdRef.current = tracks.some((entry) => entry.id === currentTrack?.id)
      ? currentTrack?.id ?? null : null;
    setQueue(tracks);
    setQueueSource(source ?? null);
  }, [currentTrack, currentSource, playerMode, queue, queueSource, resetShuffleBag]);

  const toggleTrack = (track: MusicTrack, tracks?: MusicTrack[], source?: MusicPlaylistSource | null) => {
    if (playerMode === "radio") {
      disableRadioMode();
    }
    let keepsCurrentShuffleCycle = true;
    if (tracks) {
      const sameQueue = getQueueSignature(tracks) === getQueueSignature(queue);
      const sameSource = !source || (
        source.id === queueSource?.id && source.type === queueSource?.type
      );
      keepsCurrentShuffleCycle = sameQueue && sameSource;
      if (keepsCurrentShuffleCycle) {
        shuffleRemainingRef.current = shuffleRemainingRef.current.filter((id) => id !== track.id);
      } else {
        shuffleSourceRef.current = null;
        shuffleOriginRef.current = null;
        setShuffleSource(null);
        resetShuffleBag(tracks, track.id);
        resetUpcomingOrder();
      }
      setQueue(tracks);
      setQueueSource(source ?? null);
    }

    if (currentTrack?.id === track.id) {
      if (isPlaybackPreparing) return;
      if (!audioRef.current) return;
      if (isPlaying) {
        localPlaybackIntentRef.current = false;
        pendingPlayRef.current = false;
        audioRef.current.pause();
      } else {
        localPlaybackIntentRef.current = true;
        audioRef.current.play().catch(() => setIsPlaying(false));
      }
      setIsPlaying(!isPlaying);
      return;
    }

    if (!keepsCurrentShuffleCycle) {
      setHistory([]);
      updateManualQueue([]);
    } else {
      addHistory();
    }
    setFutureCleared(false);
    playlistRemainingRef.current = Math.max(0, (tracks ?? queue).length - 1);
    startTrack(track, source ?? queueSource);
  };

  const selectPlaybackShuffleSource = (
    source: MusicPlaylistSource | null, tracks?: MusicTrack[],
    sourceByTrackId?: Map<string, MusicPlaylistSource>,
  ) => {
    if (playerModeRef.current === "radio") return;
    const nextSource = source && tracks?.length ? {source, tracks: tracks.filter((track) => Boolean(track.url))} : null;
    shuffleSourceRef.current = nextSource;
    shuffleOriginRef.current = nextSource && sourceByTrackId ? new Map(sourceByTrackId) : null;
    setShuffleSource(nextSource);
    const newTracks = nextSource?.tracks ?? queue;
    resetUpcomingOrder();
    resetShuffleBag(newTracks, currentTrack?.id);
    setFutureCleared(false);
  };

  const buildAutomaticUpcoming = (): PlaybackQueueEntry[] => {
    if (upcomingClearedRef.current) return [];
    if (isShuffle) return plannedAutomaticRef.current.slice(0, 2);
    if (queue.length <= 1 || playlistRemainingRef.current <= 0) return [];

    const anchor = playlistCursorIdRef.current || currentTrack?.id;
    const cursorIndex = queue.findIndex((entry) => entry.id === anchor);
    const natural: PlaybackQueueEntry[] = [];
    const count = Math.min(2, queue.length - 1, playlistRemainingRef.current);
    for (let step = 1; step <= count; step += 1) {
      const track = queue[(Math.max(-1, cursorIndex) + step) % queue.length];
      if (track && track.id !== currentTrack?.id) natural.push({
        key: `playlist:${track.id}`, track, source: queueSource,
        pitch: { kind: "random" }, manual: false,
      });
    }
    // During a drag the scheduled songs stay committed even if the next play
    // advances the sequential cursor past one of them.
    const pinned = sequentialPinsRef.current.filter((entry) => entry.track.id !== currentTrack?.id);
    const merged = [...pinned, ...natural];
    const seen = new Set<string>();
    return merged.filter((entry) => {
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    }).slice(0, 2);
  };

  const orderVisibleUpcoming = (base: PlaybackQueueEntry[]): PlaybackQueueEntry[] => {
    if (!upcomingOrderRef.current.length) return base;
    const lookup = new Map(base.map((entry) => [entry.key, entry]));
    const existing = upcomingOrderRef.current
      .map((key) => lookup.get(key))
      .filter((entry): entry is PlaybackQueueEntry => Boolean(entry));
    const placed = new Set(existing.map((entry) => entry.key));
    // "Añadir como siguiente" must still go FIRST even after a custom reorder.
    // Reconcile it before appending new automatically chosen tracks.
    const newPriority = base.filter((entry) => entry.manual && entry.placement !== "last" && !placed.has(entry.key));
    for (const entry of newPriority) placed.add(entry.key);
    existing.unshift(...newPriority);
    // New automatic choices enter before the unmodified manual tail. A song
    // explicitly dragged earlier retains its selected position.
    for (const entry of base) {
      if (placed.has(entry.key)) continue;
      const firstTail = existing.findIndex((other) => other.placement === "last");
      if (entry.placement === "last" || firstTail < 0) existing.push(entry);
      else existing.splice(firstTail, 0, entry);
      placed.add(entry.key);
    }
    return existing;
  };

  const getOrderedUpcoming = (): PlaybackQueueEntry[] => {
    if (playerModeRef.current === "radio") return [];
    const priority = manualQueueRef.current.filter((entry) => entry.placement !== "last");
    const tail = manualQueueRef.current.filter((entry) => entry.placement === "last");
    return orderVisibleUpcoming([...priority, ...buildAutomaticUpcoming(), ...tail]);
  };

  const peekNextEntry = (): PlaybackQueueEntry | null => getOrderedUpcoming()[0] || null;

  const reorderPlaybackQueueEntry = (key: string, targetIndex: number) => {
    if (playerModeRef.current === "radio") return;
    const visible = getOrderedUpcoming();
    const from = visible.findIndex((entry) => entry.key === key);
    if (from < 0) return;
    const target = Math.max(0, Math.min(visible.length - 1, Math.trunc(targetIndex)));
    if (from === target) return;
    const moved = [...visible];
    const [entry] = moved.splice(from, 1);
    moved.splice(target, 0, entry);
    upcomingOrderRef.current = moved.map((item) => item.key);
    setUpcomingOrder(upcomingOrderRef.current);
    // Sequential choices normally exist only as an on-demand projection;
    // preserve both while the user reorders them (same as the shuffle plan).
    if (!isShuffle) {
      sequentialPinsRef.current = visible.filter((item) => !item.manual);
      setSequentialPinsVersion((n) => n + 1);
    }
  };

  const clearPlaybackHistory = () => {
    if (playerModeRef.current === "radio") return;
    setHistory([]);
    recentlyPlayedIdsRef.current = [];
    // Clear recent-song memory as well; the next cycle starts fresh.
    resetShuffleBag(activeShufflePlaylist().tracks, currentTrack?.id);
    playlistRemainingRef.current = Math.max(0, queue.length - 1);
  };

  const clearPlaybackUpcoming = () => {
    if (playerModeRef.current === "radio") return;
    updateManualQueue([]);
    resetUpcomingOrder();
    setFutureCleared(true);
    preloadedTrackRef.current = null;
    preloadedUrlRef.current = "";
    const inactive = activeIdRef.current === "a" ? elBRef.current : elARef.current;
    if (inactive) { inactive.pause(); inactive.removeAttribute("src"); inactive.load(); }
  };

  const addToPlaybackQueue = (
    track: MusicTrack,
    position: PlaybackQueuePosition,
    pitch: PlaybackQueuePitch,
    source?: MusicPlaylistSource | null,
  ) => {
    if (playerModeRef.current === "radio" || !track.url) return;
    const resolvedSource = source ?? queueSource ?? currentSource ?? {
      id: "added", name: "Añadidas a cola", type: "song" as const,
    };
    const entry: PlaybackQueueEntry = {
      key: nextKey(), track, source: resolvedSource,
      pitch: pitch.kind === "fixed"
        ? { kind: "fixed", pitch: Math.max(0.5, Math.min(1.5, pitch.pitch)) }
        : { kind: "random" },
      manual: true,
      placement: position === "last" ? "last" : "next",
    };
    if (position === "now") {
      addHistory();
      startTrack(track, resolvedSource, entry.pitch);
      return;
    }
    updateManualQueue(position === "next"
      ? [entry, ...manualQueueRef.current]
      : [...manualQueueRef.current, entry]);
  };

  const removeFromPlaybackQueue = (key: string) => {
    if (playerModeRef.current === "radio") return;
    updateManualQueue(manualQueueRef.current.filter((entry) => entry.key !== key));
  };

  const playPlaybackQueueEntry = (key: string) => {
    if (playerModeRef.current === "radio") return;
    const previous = history.find((entry) => entry.key === key);
    if (previous) {
      addHistory();
      setHistory((all) => all.filter((entry) => entry.key !== key));
      startTrack(previous.track, previous.source, previous.pitch);
      return;
    }
    const manual = manualQueueRef.current.find((entry) => entry.key === key);
    if (manual) {
      addHistory();
      updateManualQueue(manualQueueRef.current.filter((entry) => entry.key !== key));
      startTrack(manual.track, manual.source, manual.pitch);
      return;
    }
    const planned = getOrderedUpcoming().find((entry) => entry.key === key);
    const track = planned?.track;
    if (!track) return;
    addHistory();
    const previousCursor = playlistCursorIdRef.current;
    const previousPosition = queue.findIndex((entry) => entry.id === previousCursor);
    const nextPosition = queue.findIndex((entry) => entry.id === track.id);
    const preserveCursor = !isShuffle && sequentialPinsRef.current.some((entry) => entry.key === key)
      && previousPosition >= 0 && nextPosition >= 0 && nextPosition < previousPosition;
    if (isShuffle) consumePlannedAutomatic(track.id);
    removeSequentialPin(key);
    if (!preserveCursor) playlistCursorIdRef.current = track.id;
    playlistRemainingRef.current = Math.max(0, queue.length - 1);
    startTrack(track, planned?.source ?? queueSource);
    if (preserveCursor) playlistCursorIdRef.current = previousCursor;
  };

  const playNext = () => {
    if (playerMode === "radio") {
      void radioPost<RadioState>("/radio/skip").then(applyRadioSnapshot).catch(() => undefined);
      return;
    }
    const planned = peekNextEntry();
    if (!planned) return;
    addHistory();
    if (planned.manual) {
      updateManualQueue(manualQueueRef.current.filter((entry) => entry.key !== planned.key));
    } else if (isShuffle) {
      // Consume exactly the entry the UI and the preload chose.
      consumePlannedAutomatic(planned.track.id);
    } else {
      playlistRemainingRef.current = Math.max(0, playlistRemainingRef.current - 1);
    }
    const previousCursor = playlistCursorIdRef.current;
    const previousPosition = queue.findIndex((entry) => entry.id === previousCursor);
    const nextPosition = queue.findIndex((entry) => entry.id === planned.track.id);
    const preserveCursor = !isShuffle && !planned.manual
      && sequentialPinsRef.current.some((entry) => entry.key === planned.key)
      && previousPosition >= 0 && nextPosition >= 0 && nextPosition < previousPosition;
    removeSequentialPin(planned.key);
    // At the end of a complete playlist pass, append the manually queued tail
    // before starting a fresh pass. No manual tail => normal infinite autoplay.
    const hasTail = manualQueueRef.current.some((entry) => entry.placement === "last");
    if (!upcomingClearedRef.current && !hasTail) {
      if (!isShuffle && playlistRemainingRef.current === 0) playlistRemainingRef.current = Math.max(0, queue.length - 1);
    }
    startTrack(planned.track, planned.source, planned.manual ? planned.pitch : undefined);
    if (preserveCursor) playlistCursorIdRef.current = previousCursor;
  };

  // An automatic change of song is never allowed to strand the audio on a
  // visual asset that the user did not ask to wait for. The current preference
  // only affects manual song starts and explicit wait-for-video transitions.
  const advanceWithoutReadyPreload = () => {
    if (!getYoutubeVideoWaitForReady()) bypassVisualPreparationOnceRef.current = true;
    playNext();
    // A missing next track must not affect a future manual song start.
    bypassVisualPreparationOnceRef.current = false;
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
  const pickNextTrack = (): MusicTrack | null => peekNextEntry()?.track ?? null;

  // Precarga (bufferiza) la siguiente pista en el elemento inactivo.
  const preloadNext = () => {
    if (playerModeRef.current === "radio") return;
    const preEl = getPreloadAudio();
    const next = pickNextTrack();
    if (!preEl || !next || !next.url || needsDirectAudioStart(next)) {
      // Do not open a second long-lived YouTube stream before playback.
      // The Linux backend can still prewarm its extractor URL cache.
      preloadedTrackRef.current = null;
      preloadedUrlRef.current = "";
      if (preEl?.getAttribute("src")) {
        preEl.pause(); preEl.removeAttribute("src"); preEl.load();
      }
      return;
    }
    preloadedTrackRef.current = next;
    const upcoming = peekNextEntry();
    const forced = upcoming?.manual ? upcoming.pitch : null;
    preloadedPitchRef.current = forced?.kind === "fixed" ? forced.pitch
      : forced?.kind === "random" || autoRandomPitch
        ? Math.random() * (1.2 - 0.8) + 0.8 : playbackPitch;
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
    const planned = peekNextEntry();
    if (!planned) { finishSingleTrackQueue(); return; }
    // Use the SAME active-audio startup path as a manual Play for YouTube and
    // custom video covers. Their hidden buffer may have been prepared long
    // before the transition and is not a reliable playback source.
    if (needsDirectAudioStart(planned.track)) {
      advanceWithoutReadyPreload();
      return;
    }

    const next = preloadedTrackRef.current;
    const preEl = getPreloadAudio();
    const oldActive = getActiveAudio();
    if (!next || !preEl || !isPreloadReady() || next.id !== planned.track.id) {
      advanceWithoutReadyPreload();
      return;
    }

    if (next.firstListenPending && next.albumId && next.albumEntryId) {
      advanceWithoutReadyPreload();
      return;
    }

    // onTimeUpdate (~0.3s early) and onEnded can both arrive while the video is
    // preparing. One track gets one transition attempt.
    if (preloadedAdvanceTrackIdRef.current === next.id) return;
    preloadedAdvanceTrackIdRef.current = next.id;

    const beginAdvance = async () => {
      pendingPlayRef.current = false;
      const hiddenTab = document.visibilityState !== "visible";
      if (hiddenTab) cancelLocalVideoPreparation();
      // Audio continuity first: with the default "do not wait" preference,
      // commit the buffered audio immediately. The background loader will
      // attach/sync the videoclip after React commits the new current track.
      const mayStart = hiddenTab || !getYoutubeVideoWaitForReady()
        ? true
        : await prepareLocalVideoStart(next, planned.source);

      if (
        !mayStart
        || peekNextEntry()?.key !== planned.key
        || preloadedAdvanceTrackIdRef.current !== next.id
        || preloadedTrackRef.current?.id !== next.id
        || getPreloadAudio() !== preEl
      ) {
        if (preloadedAdvanceTrackIdRef.current === next.id) {
          preloadedAdvanceTrackIdRef.current = null;
          // A playlist switch, background-prep cancellation or slow metadata
          // can invalidate the preloaded transition after the outgoing track
          // has already ended. Never leave playback stranded on the old audio.
          const outgoingFinished = Boolean(oldActive && (
            oldActive.ended || oldActive.paused && Number.isFinite(oldActive.duration)
              && oldActive.duration - oldActive.currentTime < 0.65
          ));
          if (outgoingFinished && playerModeRef.current === "local") {
            const replacement = peekNextEntry();
            if (replacement) advanceWithoutReadyPreload();
          }
        }
        return;
      }

      pitchLockedRef.current = false;
      setIsPitchLocked(false);
      addHistory();
      if (planned.manual) {
        updateManualQueue(manualQueueRef.current.filter((entry) => entry.key !== planned.key));
      } else if (isShuffle) {
        consumePlannedAutomatic(next.id);
      } else {
        playlistRemainingRef.current = Math.max(0, playlistRemainingRef.current - 1);
      }
      const oldPlaylistCursor = playlistCursorIdRef.current;
      const oldCursorIndex = queue.findIndex((entry) => entry.id === oldPlaylistCursor);
      const nextCursorIndex = queue.findIndex((entry) => entry.id === next.id);
      const preserveCursor = !isShuffle && !planned.manual
        && sequentialPinsRef.current.some((entry) => entry.key === planned.key)
        && oldCursorIndex >= 0 && nextCursorIndex >= 0 && nextCursorIndex < oldCursorIndex;
      removeSequentialPin(planned.key);
      if (!planned.manual && !preserveCursor) playlistCursorIdRef.current = next.id;
      const hasTail = manualQueueRef.current.some((entry) => entry.placement === "last");
      if (!upcomingClearedRef.current && !hasTail) {
        if (!isShuffle && playlistRemainingRef.current === 0) playlistRemainingRef.current = Math.max(0, queue.length - 1);
      }

      // Swap only after the optional video is ready (or has failed open). Until
      // here the outgoing track remains the active player.
      localPlaybackIntentRef.current = true;
      activeIdRef.current = activeIdRef.current === "a" ? "b" : "a";
      audioRef.current = preEl;
      const pitch = preloadedPitchRef.current;
      preEl.preservesPitch = false;
      preEl.playbackRate = pitch;
      preEl.volume = volumeRef.current;
      try { preEl.currentTime = 0; } catch { /* puede fallar antes de tener datos */ }
      preloadedTrackRef.current = null;
      preloadedAdvanceTrackIdRef.current = null;
      setPlaybackPitch(pitch);
      setCurrentTrack(next);
      setCurrentSource(planned.source);
      setCurrentTime(0);
      setVisualCurrentTime(0);
      setDuration(preEl.duration || 0);
      setIsPlaying(false);
      // A previous preparation's spinner must never disable the controls for
      // a new automatic track, including when preparation was bypassed.
      setIsPlaybackPreparing(false);

      pendingPlayRef.current = true;
      void preEl.play().catch((error: unknown) => {
        if (audioRef.current !== preEl) return;
        // A preloaded media element has often ALREADY emitted canplay before
        // becoming active. That event will not necessarily occur a second
        // time. Keep the intent and allow a direct user Play retry.
        pendingPlayRef.current = true;
        setIsPlaying(false);
        setIsPlaybackPreparing(false);
        console.warn("FARREO: no se pudo iniciar la pista precargada", error);
      });

      if (oldActive && !opts?.letOldFinish) {
        try { oldActive.pause(); } catch { /* no-op */ }
      }
    };

    void beginAdvance();
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
        if (remaining <= 0.3 && peekNextEntry() && isPreloadReady()) {
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
      // Local track start/gapless swap already assigned its chosen pitch.
      // Reapplying an older render's playbackPitch during loadedmetadata can
      // overwrite the incoming song's fixed/custom pitch.
      if (playerModeRef.current === "radio" && radioStateRef.current) {
        el.playbackRate = radioStateRef.current.currentItem?.pitch ?? playbackPitch;
        const livePosition = getLiveRadioPosition(radioStateRef.current);
        if (Math.abs(el.currentTime - livePosition) > 0.5) {
          el.currentTime = livePosition;
        }
        setCurrentTime(livePosition);
        setVisualCurrentTime(livePosition);
      }
      // Do NOT seek local audio to React's currentTime here. During an A->B
      // gapless swap the closure may still hold A's last timestamp. Seek only
      // if this exact URL is being reloaded from persistent startup state.
      if (playerModeRef.current !== "radio") {
        const restore = startupResumeRef.current;
        if (restore && el.getAttribute("src") === restore.url) {
          startupResumeRef.current = null;
          try {
            el.currentTime = Number.isFinite(el.duration) && el.duration > 0
              ? Math.min(restore.position, Math.max(0, el.duration - 0.05))
              : restore.position;
          } catch { /* A later manual seek can still recover. */ }
        }
      }
      if (playerModeRef.current !== "radio" && pendingPlayRef.current) {
        void el.play().catch(() => {
          // A transient stream stall must not consume the pending play intent.
          setIsPlaying(false);
        });
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
        const liveState = radioStateRef.current;
        syncAudioToLiveRadio(pendingRadioJoinSyncRef.current ? 0.5 : 0.75);

        // The scheduled transition may have fired before the new media source
        // became playable. canplay is the reliable recovery point, but we keep
        // respecting the shared server start grace so no client starts early.
        const startsInFuture = (
          liveState.anchorUpdatedAt > getRadioServerNow()
          && getLiveRadioPosition(liveState) <= 0.05
        );
        if (
          !startsInFuture
          && e.currentTarget.paused
          && !radioAwaitingUserGestureRef.current
        ) {
          void joinLiveRadioAudio();
        }
        return;
      }
      if (playerModeRef.current !== "radio" && pendingPlayRef.current) {
        void e.currentTarget.play().catch(() => {
          // Keep the request until actual playback (onPlaying), not just one
          // "canplay" notification that may arrive before enough data.
          setIsPlaying(false);
        });
      }
    },
    onPlaying: (e: SyntheticEvent<HTMLAudioElement>) => {
      if (e.currentTarget !== audioRef.current) return;
      if (playerModeRef.current !== "radio") {
        pendingPlayRef.current = false;
        // Media events can arrive in a different order after replacing the
        // outgoing source; `playing` is authoritative for the new track.
        setIsPlaying(true);
      } else if (radioStateRef.current?.status === "playing") {
        setIsPlaying(true);
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

    if (history.length > 0) {
      const previous = history[history.length - 1];
      setHistory((prev) => prev.slice(0, -1));
      if (currentTrack) {
        const forward: PlaybackQueueEntry = {
          key: nextKey(), track: currentTrack, source: currentSource,
          pitch: { kind: "fixed", pitch: playbackPitch }, manual: true,
        };
        updateManualQueue([forward, ...manualQueueRef.current]);
      }
      startTrack(previous.track, previous.source, previous.pitch);
      return;
    }

    // With no history there is no previous song to return to. This also makes
    // the "Limpiar anteriores" action genuinely clear backwards navigation.
    return;
  };

  const togglePlayPause = () => {
    // Never let a stale waiting-for-video state disable the local Play button.
    // A deliberate click overrides optional visual preparation.
    if (playerMode === "radio") {
      if (radioState?.status === "playing" && !isPlaying && audioRef.current) {
        void joinLiveRadioAudio(true);
        return;
      }
      const action = radioState?.status === "playing" ? "/radio/pause" : "/radio/play";
      void radioPost<RadioState>(action).then(applyRadioSnapshot).catch(() => undefined);
      return;
    }

    if (!currentTrack && (queue.length > 0 || manualQueueRef.current.length > 0)) {
      const next = peekNextEntry();
      if (next) {
        if (next.manual) updateManualQueue(manualQueueRef.current.filter((entry) => entry.key !== next.key));
        else if (isShuffle) consumePlannedAutomatic(next.track.id);
        else playlistRemainingRef.current = Math.max(0, playlistRemainingRef.current - 1);
        startTrack(next.track, next.source, next.manual ? next.pitch : undefined);
      }
      return;
    }

    if (isPlaybackPreparing) {
      const pendingNext = preloadedAdvanceTrackIdRef.current;
      const outgoing = audioRef.current;
      cancelLocalVideoPreparation();
      preloadedAdvanceTrackIdRef.current = null;
      // If the old song has already ended, advance rather than retrying it.
      if (pendingNext && outgoing?.ended && peekNextEntry()) {
        advanceWithoutReadyPreload();
        return;
      }
    }
    const audio = audioRef.current;
    if (!audio) return;
    // React's isPlaying can lag behind actual HTMLMediaElement state when a
    // double-buffer transition fails. Trust the media element, not stale UI.
    if (!audio.paused) {
      localPlaybackIntentRef.current = false;
      pendingPlayRef.current = false;
      audio.pause();
    } else {
      localPlaybackIntentRef.current = true;
      pendingPlayRef.current = true;
      // A failed on-demand stream can leave the <audio> permanently in a
      // MEDIA_ERR state. Pressing Play must create a NEW request instead of
      // retrying play() against the same unusable media resource.
      if (audio.error || audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
        const original = currentTrack?.url || audio.getAttribute("src") || "";
        if (original) {
          const separator = original.includes("?") ? "&" : "?";
          const retry = isYoutubeProxyTrack(currentTrack)
            ? `${original}${separator}fresh=1&manualRetry=${Date.now()}` : original;
          audio.src = retry;
          audio.load();
        }
      }
      void audio.play().then(() => {
        if (audioRef.current === audio) pendingPlayRef.current = false;
      }).catch((error: unknown) => {
        if (audioRef.current === audio) {
          setIsPlaying(false);
          setIsPlaybackPreparing(false);
          console.warn("FARREO: la reproduccion requiere un nuevo intento", error);
        }
      });
    }
  };

  const handleVolumeChange = (val: number) => {
    const nextVolume = clampVolume(val);
    volumeRef.current = nextVolume;
    // Set BOTH elements to the same chosen volume; never let the inactive
    // preloader retain an old gain when it becomes the active player.
    if (elARef.current) elARef.current.volume = nextVolume;
    if (elBRef.current) elBRef.current.volume = nextVolume;
    setVolume(nextVolume);
    if (nextVolume > 0.01) {
      lastNonZeroVolumeRef.current = nextVolume;
      setLastNonZeroVolume(nextVolume);
    }
    if (audioRef.current) audioRef.current.volume = nextVolume;
  };

  const handlePitchChange = (val: number) => {
    if (pitchLockedRef.current && playerMode !== "radio") return;
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
      // Seek the background in the same interaction, before React's time
      // update. This includes an explicit jump to 0 while audio is playing.
      if (currentTrack?.id) notifyYoutubeVideoSeek(currentTrack.id, val);
    }
  };

  const updateShuffle = (val: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof val === "function" ? val(isShuffle) : val;
    setIsShuffle(next);
    if (playerMode !== "radio" && !next) resetUpcomingOrder();
    if (next && playerMode !== "radio") {
      resetUpcomingOrder();
      resetShuffleBag(activeShufflePlaylist().tracks, currentTrack?.id);
    }
    if (playerMode === "radio") {
      void radioPatch<RadioState>("/radio/settings", { shuffle: next }).then(applyRadioSnapshot).catch(() => undefined);
    }
  };

  const stop = () => {
    localPlaybackIntentRef.current = false;
    cancelLocalVideoPreparation();
    pendingPlayRef.current = false;
    preloadedAdvanceTrackIdRef.current = null;
    if (playerMode === "radio") {
      disableRadioMode();
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setCurrentTrack(null);
    setCurrentSource(null);
    setQueue([]);
    setQueueSource(null);
    shuffleSourceRef.current = null;
    shuffleOriginRef.current = null;
    setShuffleSource(null);
    shuffleRemainingRef.current = [];
    shuffleQueueSignatureRef.current = "";
    resetUpcomingOrder();
    playlistCursorIdRef.current = null;
    playlistRemainingRef.current = 0;
    updateAutomaticPlan([]);
    setHistory([]);
    updateManualQueue([]);
    resetUpcomingOrder();
    setFutureCleared(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setVisualCurrentTime(0);
    setDuration(0);
  };

  useLayoutEffect(() => {
    // Apply saved settings before the browser paints the default 80% volume.
    if (typeof window === "undefined" || hasRestoredRef.current) return;
    hasRestoredRef.current = true;

    try {
      const rawState = window.localStorage.getItem(playerStorageKey);
      if (!rawState) {
        setStorageReady(true);
        return;
      }
      const state = JSON.parse(rawState) as Partial<StoredPlayerState>;

      const restoredTracks = Array.isArray(state.queue) ? state.queue : [];
      shuffleSourceRef.current = null;
      shuffleOriginRef.current = null;
      setShuffleSource(null);
      setQueue(restoredTracks);
      resetShuffleBag(restoredTracks, state.currentTrack?.id);
      playlistRemainingRef.current = Math.max(0, restoredTracks.length - 1);
      playlistCursorIdRef.current = state.currentTrack?.id ?? null;
      setQueueSource(state.queueSource ?? null);
      setCurrentTrack(state.currentTrack ?? null);
      setCurrentSource(state.currentSource ?? null);
      const restoredTime = typeof state.currentTime === "number" ? Math.max(0, state.currentTime) : 0;
      startupResumeRef.current = state.currentTrack?.url && restoredTime > 0
        ? {url: state.currentTrack.url, position: restoredTime} : null;
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
      localVideoStartGenerationRef.current += 1;
      const pendingVideoStart = localVideoStartAbortRef.current;
      localVideoStartAbortRef.current = null;
      pendingVideoStart?.abort();
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
    if (playerMode !== "local" || playerModeRef.current !== "local") return;

    const keepOnlyMobilePlaylistReference = isMobileRoute && (
      currentSource?.type === "global" || currentSource?.type === "private" || currentSource?.type === "album"
    );
    const state: StoredPlayerState = {
      currentTrack,
      // En movil la lista se recarga desde Farreo al volver a abrirla: asi no
      // persistimos una copia larga y potencialmente desactualizada.
      queue: keepOnlyMobilePlaylistReference ? [] : queue.map(compactQueuedTrack),
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

    writeStoredPlayerState(window.localStorage, playerStorageKey, state);
  }, [autoRandomPitch, currentSource, isMobileRoute, persistedTime, currentTrack, isShuffle, lastNonZeroVolume, lyricsEnabled, playbackPitch, playerMode, playerStorageKey, queue, queueSource, storageReady, volume]);

  useEffect(() => {
    // This second volume-only write was leaking Radio's volume into the local
    // session despite the main persistence effect correctly skipping Radio.
    if (typeof window === "undefined" || !storageReady ||
      playerMode !== "local" || playerModeRef.current !== "local") return;

    try {
      const rawState = window.localStorage.getItem(playerStorageKey);
      const state = rawState ? JSON.parse(rawState) as Partial<StoredPlayerState> : {};
      writeStoredPlayerState(window.localStorage, playerStorageKey, {
        ...state,
        volume,
        lastNonZeroVolume,
      });
    } catch {
      writeStoredPlayerState(window.localStorage, playerStorageKey, {
        volume,
        lastNonZeroVolume,
      });
    }
  }, [lastNonZeroVolume, playerMode, playerStorageKey, storageReady, volume]);

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
      // getAttribute retains the original URL; .src may be normalized and
      // comparing it directly can trigger an unwanted reload during gapless.
      if (audio.getAttribute("src") !== url) {
        audio.src = url;
        audio.load();
      }
    } else if (audio.getAttribute("src")) {
      audio.removeAttribute("src");
      audio.load();
    }
  }, [currentTrack?.url]);

  // The two upcoming automatic choices are committed only as needed. The
  // selection is updated AFTER render, never as a side effect of useMemo.
  useEffect(() => {
    if (playerMode !== "local" || !isShuffle || upcomingCleared) return;
    const active = shuffleSourceRef.current ?? {source: queueSource, tracks: queue};
    if (!active.tracks.length) return;
    if (shuffleQueueSignatureRef.current !== getQueueSignature(active.tracks)) {
      resetShuffleBag(active.tracks, currentTrack?.id);
      return;
    }
    refillAutomaticWindow(active.tracks, active.source, currentTrack?.id,
      manualQueue.some((entry) => entry.placement === "last"));
    // Refill is stable after two reservations; it never rerolls existing slots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, queueSource, currentTrack?.id, isShuffle, playerMode, manualQueue,
      upcomingCleared, shuffleSource, shuffleVersion, plannedAutomatic.length]);

  // Precargar la siguiente cancion en el elemento inactivo (doble buffer) para
  // poder encadenar sin hueco en segundo plano. Solo en modo local.
  useEffect(() => {
    if (playerMode === "radio") return;
    if (!currentTrack || queue.length === 0) return;
    preloadNext();
    // preloadNext lee el estado actual via closure; no es una dependencia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, queue, isShuffle, autoRandomPitch, playerMode, manualQueue, upcomingCleared, shuffleVersion, upcomingOrder, sequentialPinsVersion, plannedAutomatic]);

  // YouTube audio is an on-demand proxy. A transient extractor/upstream
  // failure can leave its <audio> at 0 without another canplay event, while
  // native MP3s continue normally. Keep a bounded, per-track recovery path.
  useEffect(() => {
    if (playerMode !== "local" || !currentTrack?.url ||
      !/\/youtube-tracks\/[a-zA-Z0-9_-]{11}\/audio(?:[?#]|$)/.test(currentTrack.url)) return;

    const songId = currentTrack.id;
    const canonicalUrl = currentTrack.url;
    let retries = 0;
    let lastAttemptAt = Date.now();
    let inFlight = false;
    const check = () => {
      const audio = audioRef.current;
      if (!audio || playerModeRef.current !== "local" ||
        !localPlaybackIntentRef.current || !audio.getAttribute("src") ||
        !audio.src.includes("/youtube-tracks/") ||
        // Never intervene while the user intentionally waits for visuals.
        localVideoStartAbortRef.current !== null) return;
      if (audio.currentTime >= 0.35) {
        window.clearInterval(timer);
        return;
      }
      if (inFlight || retries >= 2) return;
      const age = Date.now() - lastAttemptAt;
      const minWaitMs = audio.error ? 1000 : retries ? 11000 : 8500;
      if (age < minWaitMs) return;
      retries += 1;
      lastAttemptAt = Date.now();
      inFlight = true;
      const errorCode = audio.error?.code ?? 0;
      console.warn("FARREO: recuperando audio YouTube bloqueado en 0", {
        songId, attempt: retries, errorCode,
        paused: audio.paused, readyState: audio.readyState,
        networkState: audio.networkState,
      });
      const separator = canonicalUrl.includes("?") ? "&" : "?";
      // fresh=1 asks the existing Linux proxy to resolve a new signed URL.
      // retry makes the browser fetch a new resource rather than the failed one.
      const retryUrl = `${canonicalUrl}${separator}fresh=1&retry=${retries}`;
      pendingPlayRef.current = true;
      try {
        audio.pause();
        audio.src = retryUrl;
        audio.load();
        void audio.play().catch((err) => {
          console.warn("FARREO: reintento de stream YouTube pendiente", err);
        }).finally(() => { inFlight = false; });
      } catch (err) {
        inFlight = false;
        console.warn("FARREO: fallo en recuperación de stream YouTube", err);
      }
    };
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
  }, [currentTrack?.id, currentTrack?.url, playerMode]);

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
    if (isMobileRoute || pathname.startsWith("/admin/lyrics")) return;

    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return target.isContentEditable || Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
    };
    const isSpace = (event: KeyboardEvent) => event.code === "Space" || event.key === " ";

    const handleSpaceDown = (event: KeyboardEvent) => {
      if (!isSpace(event) || event.repeat || isEditableTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (currentTrack) togglePlayPauseRef.current();
    };
    const handleSpaceUp = (event: KeyboardEvent) => {
      if (!isSpace(event) || isEditableTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", handleSpaceDown, true);
    window.addEventListener("keyup", handleSpaceUp, true);
    return () => {
      window.removeEventListener("keydown", handleSpaceDown, true);
      window.removeEventListener("keyup", handleSpaceUp, true);
    };
  }, [currentTrack, isMobileRoute, pathname]);

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
    addToPlaybackQueue,
    removeFromPlaybackQueue,
    clearPlaybackHistory,
    clearPlaybackUpcoming,
    playPlaybackQueueEntry,
    reorderPlaybackQueueEntry,
    selectPlaybackShuffleSource,
    playNext,
    playPrev,
    togglePlayPause,
    handleVolumeChange,
    handlePitchChange,
    handleSeek,
    updateShuffle,
    enableRadioMode,
    disableRadioMode,
    restoreLocalPlayer,
    stop,
  });
  useEffect(() => {
    apiRef.current = {
      loadQueue,
      playQueue,
      toggleTrack,
      addToPlaybackQueue,
      removeFromPlaybackQueue,
      clearPlaybackHistory,
      clearPlaybackUpcoming,
      playPlaybackQueueEntry,
      reorderPlaybackQueueEntry,
      selectPlaybackShuffleSource,
      playNext,
      playPrev,
      togglePlayPause,
      handleVolumeChange,
      handlePitchChange,
      handleSeek,
      updateShuffle,
      enableRadioMode,
      disableRadioMode,
      restoreLocalPlayer,
      stop,
    };
  });

  const stableApi = useMemo(() => ({
    loadQueue: (tracks: MusicTrack[], source?: MusicPlaylistSource | null) => apiRef.current.loadQueue(tracks, source),
    playQueue: (tracks: MusicTrack[], index: number, source?: MusicPlaylistSource | null) => apiRef.current.playQueue(tracks, index, source),
    toggleTrack: (track: MusicTrack, tracks?: MusicTrack[], source?: MusicPlaylistSource | null) => apiRef.current.toggleTrack(track, tracks, source),
    addToPlaybackQueue: (track: MusicTrack, position: PlaybackQueuePosition, pitch: PlaybackQueuePitch, source?: MusicPlaylistSource | null) => apiRef.current.addToPlaybackQueue(track, position, pitch, source),
    removeFromPlaybackQueue: (key: string) => apiRef.current.removeFromPlaybackQueue(key),
    clearPlaybackHistory: () => apiRef.current.clearPlaybackHistory(),
    clearPlaybackUpcoming: () => apiRef.current.clearPlaybackUpcoming(),
    playPlaybackQueueEntry: (key: string) => apiRef.current.playPlaybackQueueEntry(key),
    reorderPlaybackQueueEntry: (key: string, targetIndex: number) => apiRef.current.reorderPlaybackQueueEntry(key, targetIndex),
    selectPlaybackShuffleSource: (
      source: MusicPlaylistSource | null, tracks?: MusicTrack[],
      sourceByTrackId?: Map<string, MusicPlaylistSource>,
    ) => apiRef.current.selectPlaybackShuffleSource(source, tracks, sourceByTrackId),
    playNext: () => apiRef.current.playNext(),
    playPrev: () => apiRef.current.playPrev(),
    togglePlayPause: () => apiRef.current.togglePlayPause(),
    handleVolumeChange: (val: number) => apiRef.current.handleVolumeChange(val),
    handlePitchChange: (val: number) => apiRef.current.handlePitchChange(val),
    handleSeek: (val: number) => apiRef.current.handleSeek(val),
    setIsShuffle: (val: boolean | ((prev: boolean) => boolean)) => apiRef.current.updateShuffle(val),
    enableRadioMode: () => apiRef.current.enableRadioMode(),
    disableRadioMode: () => apiRef.current.disableRadioMode(),
    restoreLocalPlayer: (snapshot: LocalPlayerRestoreState) => apiRef.current.restoreLocalPlayer(snapshot),
    stop: () => apiRef.current.stop(),
  }), []);

  // The visible future contains manually inserted songs plus ONLY two
  // automatic candidates. Other playlist songs remain uncommitted candidates.
  const playbackUpcoming = useMemo<PlaybackQueueEntry[]>(() => getOrderedUpcoming(), [
    queue, queueSource, currentTrack?.id, isShuffle, playerMode, manualQueue,
    upcomingCleared, plannedAutomatic, shuffleVersion, upcomingOrder, sequentialPinsVersion,
  ]);
  const playbackShuffleSources = useMemo<PlaybackShuffleSource[]>(() => {
    const sources = new Map<string, PlaybackShuffleSource>();
    const consider = (source: MusicPlaylistSource | null | undefined, count = 1) => {
      if (!source || source.type === "radio"
        || (source.type === "song" && !source.id.startsWith("recommendation:"))) return;
      const key = getSourceKey(source);
      const previous = sources.get(key);
      if (!previous || previous.count < count) sources.set(key, {source, count});
    };
    consider(queueSource, queue.length);
    consider(currentSource);
    manualQueue.forEach((entry) => consider(entry.source));
    history.forEach((entry) => consider(entry.source));
    // "Todas" is a synthetic union, not a real playlist option.
    if (shuffleSource?.source.id !== "__farreo_all__") {
      consider(shuffleSource?.source, shuffleSource?.tracks.length);
    }
    return [...sources.values()];
  }, [currentSource, history, manualQueue, queue.length, queueSource, shuffleSource]);
  const playbackShuffleSourceKey = shuffleSource?.source
    ? getSourceKey(shuffleSource.source)
    : queueSource ? getSourceKey(queueSource)
    : currentSource ? getSourceKey(currentSource) : null;
  const nextTrackId = playbackUpcoming[0]?.track.id ?? null;
  const canPlayNext = playerMode === "radio" ? Boolean(radioState?.currentItem) : playbackUpcoming.length > 0;
  const canPlayPrev = playerMode === "radio" ? Boolean(radioState?.currentItem) : history.length > 0;

  const contextValue = useMemo<MusicPlayerContextValue>(() => ({
    currentTrack,
    currentSource,
    nextTrackId,
    playbackHistory: history,
    playbackUpcoming,
    playbackQueueCleared: upcomingCleared,
    playbackShuffleSources,
    playbackShuffleSourceKey,
    hasCurrentLyrics,
    isPlaying,
    playbackPitch,
    volume,
    duration,
    isShuffle,
    canPlayNext,
    canPlayPrev,
    autoRandomPitch,
    isPitchLocked,
    lyricsEnabled,
    playerMode,
    isRadioBuffering,
    isRadioAwaitingUserGesture,
    radioState,
    getAudioFrequencyData,
    setAutoRandomPitch,
    setLyricsEnabled,
    ...stableApi,
  }), [autoRandomPitch, canPlayNext, canPlayPrev, currentSource, currentTrack, duration, getAudioFrequencyData, hasCurrentLyrics, isPitchLocked, isPlaying, nextTrackId, history, playbackUpcoming, playbackShuffleSources, playbackShuffleSourceKey, upcomingCleared, isRadioAwaitingUserGesture, isRadioBuffering, isShuffle, lyricsEnabled, playbackPitch, playerMode, radioState, stableApi, volume]);

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

      {showDesktopPlayer && storageReady && (
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
                {playerMode === "local" && isPlaybackPreparing && (
                  <span className="playlist-admin__now-playing-sync">Preparando videoclip...</span>
                )}
                <span className="playlist-admin__now-playing-pitch-row">
                  <span className="playlist-admin__now-playing-pitch">Pitch: {playbackPitch.toFixed(2)}x</span>
                  <button
                    className="playlist-admin__pitch-reset"
                    onClick={() => handlePitchChange(1)}
                    disabled={isPitchLocked}
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
            <button
              className="playlist-admin__control-btn playlist-admin__control-btn--play"
              onClick={togglePlayPause}
              title={isPlaybackPreparing ? "Forzar reproducción sin esperar al vídeo" : isPlaying ? "Pausar" : "Reproducir"}
            >
              {isPlaybackPreparing
                ? <LoaderCircleIcon className="farreo-video-start-spinner" size={16} />
                : isPlaying
                  ? <PauseIcon size={16} />
                  : <PlayIcon size={16} />}
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
              disabled={isPitchLocked}
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
              disabled={isPitchLocked}
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
