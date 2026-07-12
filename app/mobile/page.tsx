"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signInWithPopup, signOut, updateProfile, type User } from "firebase/auth";
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  AudioLinesIcon,
  DicesIcon,
  Globe2Icon,
  GripVerticalIcon,
  HeartIcon,
  HomeIcon,
  ImageIcon,
  ListMusicIcon,
  LoaderCircleIcon,
  LockIcon,
  LogInIcon,
  LogOutIcon,
  Mic2Icon,
  Music2Icon,
  MoreHorizontalIcon,
  MoreVerticalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RadioIcon,
  RotateCcwIcon,
  SearchIcon,
  Share2Icon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  TrashIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import SongArtwork from "@/components/SongArtwork";
import {
  useMusicPlayer,
  useMusicPlayerTime,
  type MusicPlaylistSource,
  type MusicTrack,
} from "@/components/MusicPlayerProvider";
import { auth } from "@/lib/firebase";
import {
  addSongToPrivatePlaylist,
  createPrivatePlaylist,
  deletePrivatePlaylist,
  getPrivatePlaylist,
  listOwnPrivatePlaylists,
  removeSongFromPrivatePlaylist,
  reorderPrivatePlaylistSongs,
  updatePrivatePlaylist,
  type PrivatePlaylist,
} from "@/lib/privatePlaylists";
import { followGlobalPlaylist, listFollowedGlobalPlaylistIds, unfollowGlobalPlaylist } from "@/lib/globalPlaylistFollows";
import { useHiddenSongs } from "@/lib/useHiddenSongs";
import { computeCurrentLyric, parseSrt, type CurrentLyric, type LyricCue } from "@/lib/lyrics";
import {
  calibrateRadioClock,
  getLiveRadioPosition,
  getMediaUrl,
  MUSIC_API_URL,
  radioGet,
  radioPost,
  type ApiPlaylistInfo,
  type ApiSong,
  type RadioState,
} from "@/lib/radioApi";
import {
  addFarreoNativeListener,
  getFarreoNativeAudio,
  type FarreoNativeState,
} from "@/lib/nativeAudio";
import { getFarreoNativeGoogleAuth } from "@/lib/nativeGoogleAuth";

type MobileTab = "home" | "radio" | "playlist" | "search" | "account";
type MobilePlaylist =
  | { kind: "private"; id: string; name: string; iconUrl?: string | null; count: number; visibility?: "private" | "public" }
  | { kind: "global"; id: string; name: string; iconUrl?: string | null; count: number; followed?: boolean };

interface ApiPlaylist {
  id?: string;
  nombre?: string;
  iconUrl?: string | null;
  canciones: ApiSong[];
}

interface MobileActionItem {
  label: string;
  detail?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
}

interface MobileActionSheet {
  title: string;
  subtitle?: string;
  items: MobileActionItem[];
}

type PlaylistEditorState = {
  mode: "create" | "edit";
  playlist?: MobilePlaylist;
  name: string;
  iconUrl: string;
  visibility: "private" | "public";
};

const toMobilePrivatePlaylist = (playlist: PrivatePlaylist): MobilePlaylist => ({
  kind: "private",
  id: playlist.id,
  name: playlist.nombre,
  iconUrl: playlist.iconUrl,
  count: playlist.songIds.length,
  visibility: playlist.visibility,
});

const formatTime = (seconds?: number | null) => {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
};

const formatDate = (value: MusicTrack["createdAt"] | string | null | undefined) => {
  if (!value) return "Desconocida";
  const date = typeof value === "string"
    ? new Date(value)
    : value instanceof Date
      ? value
      : typeof value === "object" && "seconds" in value
        ? new Date(value.seconds * 1000)
        : null;
  if (!date || Number.isNaN(date.getTime())) return "Desconocida";
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "2-digit" });
};

const normalizeSearch = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const songMatchesQuery = (song: ApiSong, query: string) => {
  const q = normalizeSearch(query);
  if (!q) return false;
  return [song.name, ...(song.variantes || [])]
    .map(normalizeSearch)
    .some((value) => value.includes(q));
};

const mapSongToTrack = (song: ApiSong, addedAt?: string | null): MusicTrack => ({
  id: song.id,
  name: song.name,
  url: getMediaUrl(song.url),
  variantes: song.variantes,
  lyricsSrt: song.lyricsSrt,
  lyricsUrl: song.lyricsUrl,
  lyricsFileName: song.lyricsFileName,
  staticLyrics: song.staticLyrics,
  duration: song.duration,
  iconUrl: song.iconUrl,
  advancedCoverUrl: song.advancedCoverUrl,
  advancedCoverType: song.advancedCoverType,
  addedAt: addedAt ?? song.addedAt ?? null,
  createdAt: song.createdAt,
});

const getPlaybackOrder = (tracks: MusicTrack[]) => [...tracks].reverse();

interface MobileMiniPlayerProps {
  track: MusicTrack;
  source: MusicPlaylistSource | null;
  nativeAvailable: boolean;
  initialPosition: number;
  duration: number;
  webPosition: number;
  webLyric: CurrentLyric | null;
  lyricCues: LyricCue[];
  isPlaying: boolean;
  isBuffering: boolean;
  canPlayPrev: boolean;
  canPlayNext: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

function MobileMiniPlayer({
  track,
  source,
  nativeAvailable,
  initialPosition,
  duration,
  webPosition,
  webLyric,
  lyricCues,
  isPlaying,
  isBuffering,
  canPlayPrev,
  canPlayNext,
  onOpen,
  onToggle,
  onPrevious,
  onNext,
}: MobileMiniPlayerProps) {
  const [nativeProgress, setNativeProgress] = useState({
    position: initialPosition,
    duration,
  });

  useEffect(() => {
    if (!nativeAvailable) return undefined;
    let disposed = false;
    const handle = addFarreoNativeListener("progress", (payload) => {
      if (disposed || document.visibilityState === "hidden" || !payload || typeof payload !== "object") return;
      const progress = payload as { position?: number; duration?: number };
      setNativeProgress((current) => ({
        position: typeof progress.position === "number" ? progress.position : current.position,
        duration: typeof progress.duration === "number" ? progress.duration : current.duration,
      }));
    });

    return () => {
      disposed = true;
      void handle.then((listener) => listener?.remove()).catch(() => undefined);
    };
  }, [nativeAvailable]);

  const displayPosition = nativeAvailable ? nativeProgress.position : webPosition;
  const displayDuration = nativeAvailable ? nativeProgress.duration || duration : duration;
  const displayLyric = nativeAvailable
    ? computeCurrentLyric(lyricCues, displayPosition, displayDuration)
    : webLyric;
  const progressPercent = displayDuration > 0
    ? Math.min(100, Math.max(0, (displayPosition / displayDuration) * 100))
    : 0;

  return (
    <div className="mobile-farreo__mini-player">
      <button type="button" className="mobile-farreo__mini-skip" disabled={!canPlayPrev} onClick={onPrevious}>
        <SkipBackIcon size={18} />
      </button>
      <button type="button" className="mobile-farreo__mini-main" onClick={onOpen}>
        <SongArtwork src={track.iconUrl} alt={track.name} className="mobile-farreo__mini-art" />
        <span>
          <strong>{track.name}</strong>
          <small className={displayLyric && !isBuffering ? "mobile-farreo__mini-lyric" : undefined}>
            {isBuffering ? "Preparando audio..." : displayLyric?.text || source?.name || "Farreo"}
          </small>
        </span>
      </button>
      <button type="button" className="mobile-farreo__mini-play" onClick={onToggle}>
        {isBuffering ? (
          <LoaderCircleIcon size={21} className="mobile-farreo__spinner" />
        ) : isPlaying ? (
          <PauseIcon size={20} fill="currentColor" />
        ) : (
          <PlayIcon size={20} fill="currentColor" />
        )}
      </button>
      <button type="button" className="mobile-farreo__mini-skip" disabled={!canPlayNext} onClick={onNext}>
        <SkipForwardIcon size={18} />
      </button>
      <span className="mobile-farreo__mini-progress" aria-hidden="true">
        <span style={{ width: `${progressPercent}%` }} />
      </span>
    </div>
  );
}

export default function MobilePage() {
  const {
    autoRandomPitch,
    canPlayNext,
    canPlayPrev,
    currentSource,
    currentTrack,
    duration,
    enableRadioMode,
    handlePitchChange,
    handleSeek,
    isPlaying,
    isShuffle,
    loadQueue,
    playbackPitch,
    playNext,
    playPrev,
    playQueue,
    playerMode,
    radioState,
    setAutoRandomPitch,
    setIsShuffle,
    toggleTrack,
    togglePlayPause,
    volume,
  } = useMusicPlayer();
  const { currentLyric, currentTime } = useMusicPlayerTime();
  const { isVisible, loading: hiddenLoading } = useHiddenSongs();
  const [tab, setTab] = useState<MobileTab>("home");
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [songs, setSongs] = useState<ApiSong[]>([]);
  const [globalPlaylists, setGlobalPlaylists] = useState<ApiPlaylistInfo[]>([]);
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [privatePlaylists, setPrivatePlaylists] = useState<PrivatePlaylist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<MobilePlaylist | null>(null);
  const [selectedTracks, setSelectedTracks] = useState<MusicTrack[]>([]);
  const [loadingPlaylist, setLoadingPlaylist] = useState(false);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [nativeState, setNativeState] = useState<FarreoNativeState | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [playerClosing, setPlayerClosing] = useState(false);
  const [playbackStarting, setPlaybackStarting] = useState(false);
  const [followLyrics, setFollowLyrics] = useState(true);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsText, setLyricsText] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [actionSheet, setActionSheet] = useState<MobileActionSheet | null>(null);
  const [playlistEditor, setPlaylistEditor] = useState<PlaylistEditorState | null>(null);
  const [playlistSaving, setPlaylistSaving] = useState(false);
  const [radioPreviewState, setRadioPreviewState] = useState<RadioState | null>(null);
  const [showPlaylistReturn, setShowPlaylistReturn] = useState(false);
  const activeLyricRef = useRef<HTMLButtonElement | null>(null);
  const playlistHeroRef = useRef<HTMLElement | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressFiredRef = useRef(false);
  const selectedTracksRef = useRef<MusicTrack[]>([]);
  const playlistDragRef = useRef<{ pointerId: number; fromIndex: number; overIndex: number } | null>(null);
  const [draggedPlaylistIndex, setDraggedPlaylistIndex] = useState<number | null>(null);
  const [mobileDeepLink, setMobileDeepLink] = useState({
    tab: null as string | null,
    playlistId: null as string | null,
    playlistKind: null as string | null,
    songId: null as string | null,
  });
  const handledDeepLinkRef = useRef<string | null>(null);
  const requestedTab = mobileDeepLink.tab;
  const requestedPlaylistId = mobileDeepLink.playlistId;
  const requestedPlaylistKind = mobileDeepLink.playlistKind;
  const requestedSongId = mobileDeepLink.songId;
  const [playlistDropIndex, setPlaylistDropIndex] = useState<number | null>(null);
  const globalCarouselRef = useRef<HTMLDivElement | null>(null);
  const globalCarouselDragRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number; moved: boolean; captured: boolean } | null>(null);
  const globalCarouselMovedRef = useRef(false);
  const globalCarouselRecenterFrameRef = useRef<number | null>(null);
  const sheetDismissDragRef = useRef<{ pointerId: number; startY: number; moved: boolean } | null>(null);
  const timelineGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    vertical: boolean;
    pendingPosition: number | null;
  } | null>(null);
  const timelineSuppressSeekUntilRef = useRef(0);
  const playerCloseTimerRef = useRef<number | null>(null);
  const playbackFeedbackTimerRef = useRef<number | null>(null);

  const visibleSongs = useMemo(
    () => songs.filter((song) => isVisible(song.id)),
    [isVisible, songs],
  );

  const searchedSongs = useMemo(
    () => visibleSongs.filter((song) => songMatchesQuery(song, query)).slice(0, 35),
    [query, visibleSongs],
  );

  const libraryPlaylists = useMemo<MobilePlaylist[]>(() => [
    ...privatePlaylists.map((playlist) => ({
      kind: "private" as const,
      id: playlist.id,
      name: playlist.nombre,
      iconUrl: playlist.iconUrl,
      count: playlist.songIds.length,
      visibility: playlist.visibility,
    })),
    ...globalPlaylists
      .filter((playlist) => followedIds.has(playlist.id))
      .map((playlist) => ({
        kind: "global" as const,
        id: playlist.id,
        name: playlist.nombre,
        iconUrl: playlist.iconUrl,
        count: playlist.numCanciones,
        followed: true,
      })),
  ], [followedIds, globalPlaylists, privatePlaylists]);

  const allGlobalCards = useMemo<MobilePlaylist[]>(
    () => globalPlaylists.map((playlist) => ({
      kind: "global",
      id: playlist.id,
      name: playlist.nombre,
      iconUrl: playlist.iconUrl,
      count: playlist.numCanciones,
      followed: followedIds.has(playlist.id),
    })),
    [followedIds, globalPlaylists],
  );

  const activeTrack = nativeAvailable ? nativeState?.currentTrack ?? null : currentTrack;
  const activeSource = nativeAvailable ? nativeState?.currentSource ?? null : currentSource;
  const activeIsPlaying = nativeAvailable ? Boolean(nativeState?.isPlaying) : isPlaying;
  const activeIsBuffering = nativeAvailable ? Boolean(nativeState?.isBuffering) : false;
  const showPlaybackLoading = playbackStarting || activeIsBuffering;
  const activeCurrentTime = nativeAvailable ? nativeState?.position ?? 0 : currentTime;
  const activePitch = nativeAvailable ? nativeState?.pitch ?? playbackPitch : playbackPitch;
  const activeVolume = nativeAvailable ? nativeState?.volume ?? volume : volume;
  const activeShuffle = nativeAvailable ? nativeState?.shuffle ?? isShuffle : isShuffle;
  const activeCanPlayNext = nativeAvailable ? Boolean(nativeState?.canPlayNext) : canPlayNext;
  const activeCanPlayPrev = nativeAvailable ? Boolean(nativeState?.canPlayPrev) : canPlayPrev;
  const displayedRadioState = radioState ?? radioPreviewState;
  const currentDuration = nativeAvailable
    ? nativeState?.duration || activeTrack?.duration || 0
    : playerMode === "radio"
      ? duration || displayedRadioState?.currentItem?.song.duration || 0
      : duration || currentTrack?.duration || 0;
  const liveRadioPosition = displayedRadioState ? getLiveRadioPosition(displayedRadioState) : 0;
  const loopGlobalCards = allGlobalCards.length > 1
    ? [...allGlobalCards, ...allGlobalCards, ...allGlobalCards]
    : allGlobalCards;
  const lyricCues = useMemo<LyricCue[]>(() => parseSrt(lyricsText || activeTrack?.lyricsSrt || ""), [activeTrack?.lyricsSrt, lyricsText]);
  const activeLyric = useMemo(
    () => nativeAvailable
      ? computeCurrentLyric(lyricCues, activeCurrentTime, currentDuration)
      : currentLyric,
    [activeCurrentTime, currentDuration, currentLyric, lyricCues, nativeAvailable],
  );
  const selectedPlaylistIsActive = Boolean(
    selectedPlaylist &&
    activeSource?.id === selectedPlaylist.id &&
    activeSource.type === selectedPlaylist.kind &&
    activeTrack,
  );

  useEffect(() => {
    selectedTracksRef.current = selectedTracks;
  }, [selectedTracks]);

  useEffect(() => () => {
    if (playerCloseTimerRef.current !== null) window.clearTimeout(playerCloseTimerRef.current);
    if (playbackFeedbackTimerRef.current !== null) window.clearTimeout(playbackFeedbackTimerRef.current);
  }, []);

  useEffect(() => {
    if (!activeIsPlaying || activeIsBuffering) return;
    setPlaybackStarting(false);
    if (playbackFeedbackTimerRef.current !== null) {
      window.clearTimeout(playbackFeedbackTimerRef.current);
      playbackFeedbackTimerRef.current = null;
    }
  }, [activeIsBuffering, activeIsPlaying]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
      setMobileDeepLink({
        tab: params.get("tab"),
        playlistId: params.get("playlist"),
        playlistKind: params.get("kind"),
        songId: params.get("song"),
      });
  }, []);

  useEffect(() => {
    if (tab !== "playlist" || !selectedPlaylist) {
      setShowPlaylistReturn(false);
      return undefined;
    }

    const updateReturnButton = () => {
      const heroBottom = playlistHeroRef.current?.getBoundingClientRect().bottom ?? Infinity;
      const nextValue = heroBottom <= 4;
      setShowPlaylistReturn((current) => current === nextValue ? current : nextValue);
    };

    updateReturnButton();
    window.addEventListener("scroll", updateReturnButton, { passive: true });
    return () => window.removeEventListener("scroll", updateReturnButton);
  }, [selectedPlaylist, tab]);

  useEffect(() => {
    if (tab !== "radio") return undefined;

    let cancelled = false;
    const applyPreview = (state: RadioState) => {
      calibrateRadioClock(state, Date.now());
      if (!cancelled) setRadioPreviewState(state);
    };
    const refresh = () => {
      void radioGet<RadioState>("/radio").then(applyPreview).catch(() => undefined);
    };

    refresh();
    if (typeof EventSource === "undefined") return () => {
      cancelled = true;
    };

    const events = new EventSource(`${MUSIC_API_URL}/radio/events`);
    const handleRadioEvent = (event: Event) => {
      try {
        applyPreview(JSON.parse((event as MessageEvent).data) as RadioState);
      } catch {
        // The next event or a manual visit will provide a full snapshot.
      }
    };
    ["state", "play", "pause", "seek", "skip", "queue", "settings", "clear", "advance"].forEach((eventName) => {
      events.addEventListener(eventName, handleRadioEvent);
    });

    return () => {
      cancelled = true;
      events.close();
    };
  }, [tab]);

  useEffect(() => {
    if (allGlobalCards.length < 2) return undefined;
    const carousel = globalCarouselRef.current;
    if (!carousel) return undefined;

    const frame = window.requestAnimationFrame(() => {
      carousel.scrollLeft = carousel.scrollWidth / 3;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [allGlobalCards.length]);

  const privatePlaylistTracks = useCallback((playlist: PrivatePlaylist) => {
    const byId = new Map(visibleSongs.map((song) => [song.id, song]));
    const entries = playlist.songEntries.length > 0
      ? playlist.songEntries
      : playlist.songIds.map((songId) => ({ songId, addedAt: null }));

    return entries
      .map((entry) => {
        const song = byId.get(entry.songId);
        return song ? mapSongToTrack(song, entry.addedAt) : null;
      })
      .filter((track): track is MusicTrack => Boolean(track));
  }, [visibleSongs]);

  const showMessage = useCallback((text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2300);
  }, []);

  const reloadUserLibrary = useCallback(async (targetUser = user) => {
    if (!targetUser) {
      setPrivatePlaylists([]);
      setFollowedIds(new Set());
      return;
    }

    const [own, followed] = await Promise.all([
      listOwnPrivatePlaylists(targetUser.uid),
      listFollowedGlobalPlaylistIds(targetUser.uid),
    ]);
    setPrivatePlaylists(own);
    setFollowedIds(new Set(followed));
  }, [user]);

  const closeActionSheet = () => setActionSheet(null);

  const runActionItem = (item: MobileActionItem) => {
    if (item.disabled) return;
    setActionSheet(null);
    void item.onSelect();
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const longPressProps = (open: () => void) => ({
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      clearLongPress();
      longPressFiredRef.current = false;
      longPressTimerRef.current = window.setTimeout(() => {
        longPressFiredRef.current = true;
        open();
      }, 520);
    },
    onPointerUp: clearLongPress,
    onPointerCancel: clearLongPress,
    onPointerLeave: clearLongPress,
    onContextMenu: (event: ReactMouseEvent) => {
      event.preventDefault();
      clearLongPress();
      open();
    },
  });

  const consumeLongPressClick = () => {
    if (!longPressFiredRef.current) return false;
    longPressFiredRef.current = false;
    return true;
  };

  const beginGlobalCarouselDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Touch devices already provide inertial horizontal scrolling. Keep the
    // pointer implementation only for the desktop mobile preview.
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const carousel = globalCarouselRef.current;
    if (!carousel) return;

    globalCarouselDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: carousel.scrollLeft,
      moved: false,
      captured: false,
    };
    globalCarouselMovedRef.current = false;
  };

  const moveGlobalCarouselDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = globalCarouselDragRef.current;
    const carousel = globalCarouselRef.current;
    if (!drag || !carousel || drag.pointerId !== event.pointerId) return;

    const distance = event.clientX - drag.startX;
    if (Math.abs(distance) > 14) {
      drag.moved = true;
      if (!drag.captured) {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.captured = true;
      }
      clearLongPress();
      event.preventDefault();
      carousel.scrollLeft = drag.startScrollLeft - distance;
    }
  };

  const finishGlobalCarouselDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = globalCarouselDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    globalCarouselMovedRef.current = drag.moved;
    globalCarouselDragRef.current = null;
    if (drag.moved) {
      // Consume only the click created by this drag, never the user's next tap.
      window.setTimeout(() => {
        globalCarouselMovedRef.current = false;
      }, 0);
    }
    if (!drag.moved || allGlobalCards.length < 2) return;

    window.requestAnimationFrame(() => {
      const carousel = globalCarouselRef.current;
      if (!carousel) return;
      const segmentWidth = carousel.scrollWidth / 3;
      if (segmentWidth <= 0) return;
      if (carousel.scrollLeft < segmentWidth * 0.08) {
        carousel.scrollLeft += segmentWidth;
      } else if (carousel.scrollLeft > segmentWidth * 1.92) {
        carousel.scrollLeft -= segmentWidth;
      }
    });
  };

  const recenterGlobalCarousel = () => {
    if (allGlobalCards.length < 2 || globalCarouselRecenterFrameRef.current !== null) return;

    globalCarouselRecenterFrameRef.current = window.requestAnimationFrame(() => {
      globalCarouselRecenterFrameRef.current = null;
      const carousel = globalCarouselRef.current;
      if (!carousel) return;

      const segmentWidth = carousel.scrollWidth / 3;
      if (segmentWidth <= 0) return;

      // El contenido se triplica: cuando el desplazamiento entra en uno de los
      // extremos, saltamos una copia completa sin cambiar lo que se ve.
      if (carousel.scrollLeft < segmentWidth * 0.08) {
        carousel.scrollLeft += segmentWidth;
      } else if (carousel.scrollLeft > segmentWidth * 1.92) {
        carousel.scrollLeft -= segmentWidth;
      }
    });
  };

  const beginPlaybackFeedback = useCallback(() => {
    setPlaybackStarting(true);
    if (playbackFeedbackTimerRef.current !== null) {
      window.clearTimeout(playbackFeedbackTimerRef.current);
    }
    playbackFeedbackTimerRef.current = window.setTimeout(() => {
      setPlaybackStarting(false);
      playbackFeedbackTimerRef.current = null;
    }, 10000);
  }, []);

  const openAdvancedPlayer = useCallback(() => {
    if (playerCloseTimerRef.current !== null) {
      window.clearTimeout(playerCloseTimerRef.current);
      playerCloseTimerRef.current = null;
    }
    setPlayerClosing(false);
    setPlayerOpen(true);
  }, []);

  const closeAdvancedPlayer = useCallback(() => {
    setPlayerOpen(false);
    setPlayerClosing(true);
    if (playerCloseTimerRef.current !== null) window.clearTimeout(playerCloseTimerRef.current);
    playerCloseTimerRef.current = window.setTimeout(() => {
      setPlayerClosing(false);
      playerCloseTimerRef.current = null;
    }, 300);
  }, []);

  const beginSheetDismiss = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    sheetDismissDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      moved: false,
    };
  };

  const moveSheetDismiss = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sheetDismissDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.clientY - drag.startY > 10) drag.moved = true;
  };

  const finishSheetDismiss = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sheetDismissDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    sheetDismissDragRef.current = null;

    // El asa y toda la portada cierran con un toque. Arrastrar hacia abajo
    // desde arriba permite ocultar el panel sin tener que alcanzar el asa.
    if (!drag.moved || event.clientY - drag.startY > 64) closeAdvancedPlayer();
  };

  const beginTimelineGesture = (event: ReactPointerEvent<HTMLInputElement>) => {
    timelineGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      vertical: false,
      pendingPosition: null,
    };
  };

  const moveTimelineGesture = (event: ReactPointerEvent<HTMLInputElement>) => {
    const gesture = timelineGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const horizontalDistance = Math.abs(event.clientX - gesture.startX);
    const verticalDistance = Math.abs(event.clientY - gesture.startY);
    if (verticalDistance > horizontalDistance + 6) gesture.vertical = true;
  };

  const finishTimelineGesture = (event: ReactPointerEvent<HTMLInputElement>) => {
    const gesture = timelineGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    timelineGestureRef.current = null;
    if (gesture.vertical) {
      timelineSuppressSeekUntilRef.current = Date.now() + 300;
      return;
    }
    if (!gesture.vertical && gesture.pendingPosition !== null) {
      void seekMobileTrack(gesture.pendingPosition);
    }
  };

  const activateNativeAudio = useCallback(async () => {
    const native = getFarreoNativeAudio();
    if (!native) return null;

    try {
      const state = await native.getState();
      setNativeState(state);
      setNativeAvailable(true);
      return native;
    } catch {
      setNativeState(null);
      setNativeAvailable(false);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!nativeAvailable) return undefined;

    let disposed = false;
    const syncState = (payload: unknown) => {
      if (disposed || !payload || typeof payload !== "object") return;
      setNativeState((prev) => ({
        ...((prev ?? { isAvailable: true }) as FarreoNativeState),
        ...(payload as FarreoNativeState),
      }));
    };
    const handles = [
      addFarreoNativeListener("state", syncState),
      addFarreoNativeListener("trackChanged", syncState),
      addFarreoNativeListener("ended", syncState),
      addFarreoNativeListener("error", (payload) => {
        if (!payload || typeof payload !== "object") return;
        const text = (payload as { message?: string }).message;
        setPlaybackStarting(false);
        if (text) showMessage(text);
      }),
    ];

    return () => {
      disposed = true;
      handles.forEach((promise) => {
        void promise.then((handle) => handle?.remove()).catch(() => undefined);
      });
    };
  }, [nativeAvailable, showMessage]);

  useEffect(() => {
    if (!nativeAvailable || !playerOpen) return undefined;
    const native = getFarreoNativeAudio();
    if (!native) return undefined;
    let disposed = false;

    const syncProgress = (payload: unknown) => {
      if (disposed || document.visibilityState === "hidden" || !payload || typeof payload !== "object") return;
      const data = payload as { position?: number; duration?: number };
      setNativeState((prev) => prev ? {
        ...prev,
        position: typeof data.position === "number" ? data.position : prev.position,
        duration: typeof data.duration === "number" ? data.duration : prev.duration,
      } : prev);
    };

    void native.getState().then((state) => {
      if (!disposed) setNativeState(state);
    }).catch(() => undefined);
    const handle = addFarreoNativeListener("progress", syncProgress);
    return () => {
      disposed = true;
      void handle.then((listener) => listener?.remove()).catch(() => undefined);
    };
  }, [nativeAvailable, playerOpen]);

  useEffect(() => {
    if (!auth) {
      setAuthReady(true);
      return;
    }

    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setProfileName(nextUser?.displayName || "");
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    setLyricsText(activeTrack?.lyricsSrt || "");
    setLyricsOpen(false);
    if (!activeTrack?.lyricsUrl) return;

    let cancelled = false;
    fetch(getMediaUrl(activeTrack.lyricsUrl))
      .then((res) => res.ok ? res.text() : "")
      .then((text) => {
        if (!cancelled && text) setLyricsText(text);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [activeTrack?.id, activeTrack?.lyricsSrt, activeTrack?.lyricsUrl]);

  useEffect(() => {
    if (!playerOpen || !followLyrics) return;
    activeLyricRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeLyric?.id, followLyrics, playerOpen]);

  useEffect(() => {
    if (!authReady) return;

    const load = async () => {
      try {
        const [songData, playlistData] = await Promise.all([
          radioGet<ApiSong[]>("/canciones"),
          radioGet<ApiPlaylistInfo[]>("/playlists"),
        ]);
        setSongs(songData);
        setGlobalPlaylists(playlistData);

        if (user) {
          const [own, followed] = await Promise.all([
            listOwnPrivatePlaylists(user.uid),
            listFollowedGlobalPlaylistIds(user.uid),
          ]);
          setPrivatePlaylists(own);
          setFollowedIds(new Set(followed));
        } else {
          setPrivatePlaylists([]);
          setFollowedIds(new Set());
        }
      } catch {
        showMessage("No se pudo cargar Farreo.");
      }
    };

    void load();
  }, [authReady, showMessage, user]);

  const playTracks = useCallback(async (
    tracks: MusicTrack[],
    source: MusicPlaylistSource | null,
    index = 0,
    options?: { shuffle?: boolean },
  ) => {
    beginPlaybackFeedback();
    const shuffleForThisPlay = options?.shuffle ?? activeShuffle;
    try {
      const native = await activateNativeAudio();
      if (native) {
        const loaded = await native.loadQueue({
          tracks,
          startIndex: index,
          source,
          shuffle: shuffleForThisPlay,
          pitch: activePitch,
          volume: activeVolume,
        });
        setNativeState(loaded);
        setNativeState(await native.play());
        return;
      }

      if (options?.shuffle === false && activeShuffle) {
        const requestedTrack = tracks[index];
        if (requestedTrack) toggleTrack(requestedTrack, tracks, source);
        return;
      }

      playQueue(tracks, index, source);
    } catch (error) {
      setPlaybackStarting(false);
      throw error;
    }
  }, [activateNativeAudio, activePitch, activeShuffle, activeVolume, beginPlaybackFeedback, playQueue, toggleTrack]);

  const loadPlaylist = useCallback(async (
    playlist: MobilePlaylist,
    shouldPlay = false,
    openPlaylistTab = true,
  ) => {
    try {
      setLoadingPlaylist(true);
      if (openPlaylistTab) {
        setSelectedPlaylist(playlist);
        setSelectedTracks([]);
        setTab("playlist");
      }

      let tracks: MusicTrack[] = [];
      let source: MusicPlaylistSource;
      let resolvedPlaylist = playlist;
      if (playlist.kind === "global") {
        const data = await radioGet<ApiPlaylist>(`/playlist/${encodeURIComponent(playlist.id)}`);
        tracks = (data.canciones || [])
          .filter((song) => isVisible(song.id))
          .map((song) => mapSongToTrack(song));
        resolvedPlaylist = {
          ...playlist,
          name: data.nombre || playlist.name,
          iconUrl: data.iconUrl || playlist.iconUrl,
          count: tracks.length,
        };
        source = { id: playlist.id, name: resolvedPlaylist.name, type: "global" };
      } else {
        const fullPlaylist = await getPrivatePlaylist(playlist.id);
        if (!fullPlaylist) throw new Error("Playlist no encontrada.");
        tracks = privatePlaylistTracks(fullPlaylist);
        resolvedPlaylist = toMobilePrivatePlaylist(fullPlaylist);
        source = { id: playlist.id, name: resolvedPlaylist.name, type: "private" };
      }

      const playbackTracks = getPlaybackOrder(tracks);
      setSelectedPlaylist(resolvedPlaylist);
      setSelectedTracks(tracks);
      if (shouldPlay && playbackTracks.length > 0) {
        await playTracks(playbackTracks, source, 0);
      } else if (activeSource?.id === source.id && activeSource.type === source.type) {
        loadQueue(playbackTracks, source);
      }
    } catch {
      showMessage("No se pudo abrir la playlist.");
      setSelectedTracks([]);
    } finally {
      setLoadingPlaylist(false);
    }
  }, [activeSource, isVisible, loadQueue, playTracks, privatePlaylistTracks, showMessage]);

  useEffect(() => {
    if (
      selectedPlaylist ||
      !activeSource ||
      (activeSource.type !== "private" && activeSource.type !== "global")
    ) {
      return;
    }

    const match = [...libraryPlaylists, ...allGlobalCards].find((playlist) =>
      playlist.id === activeSource.id && playlist.kind === activeSource.type
    );
    if (match) void loadPlaylist(match, false, false);
  }, [activeSource, allGlobalCards, libraryPlaylists, loadPlaylist, selectedPlaylist]);

  useEffect(() => {
    if (requestedTab === "radio") setTab("radio");
    if (requestedTab === "account") setTab("account");
  }, [requestedTab]);

  useEffect(() => {
    if (!requestedPlaylistId || (requestedPlaylistKind !== "global" && requestedPlaylistKind !== "private")) return;
    const key = `${requestedPlaylistKind}:${requestedPlaylistId}`;
    if (handledDeepLinkRef.current === key) return;

    const candidates = requestedPlaylistKind === "global" ? allGlobalCards : libraryPlaylists;
    const playlist = candidates.find((item) => item.id === requestedPlaylistId && item.kind === requestedPlaylistKind);
    if (!playlist) return;

    handledDeepLinkRef.current = key;
    void loadPlaylist(playlist, false, true);
  }, [allGlobalCards, libraryPlaylists, loadPlaylist, requestedPlaylistId, requestedPlaylistKind]);

  const playSong = useCallback(async (song: ApiSong) => {
    const track = mapSongToTrack(song);
    await playTracks([track], { id: song.id, name: "Cancion suelta", type: "song" }, 0, { shuffle: false });
  }, [playTracks]);

  useEffect(() => {
    if (!requestedSongId || songs.length === 0) return;
    const key = `song:${requestedSongId}`;
    if (handledDeepLinkRef.current === key) return;

    handledDeepLinkRef.current = key;
    const song = songs.find((entry) => entry.id === requestedSongId);
    if (!song) {
      showMessage("No se encontro la cancion compartida.");
      return;
    }

    setTab("home");
    openAdvancedPlayer();
    void playSong(song);
  }, [openAdvancedPlayer, playSong, requestedSongId, showMessage, songs]);

  const shareUrl = async (url: string, title: string) => {
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
      } else {
        await navigator.clipboard.writeText(url);
        showMessage("Enlace copiado.");
      }
    } catch {
      await navigator.clipboard.writeText(url).catch(() => undefined);
      showMessage("Enlace copiado.");
    }
  };

  const sharePlaylist = (playlist: MobilePlaylist) => {
    const path = playlist.kind === "global" ? "playlist" : "user-playlist";
    void shareUrl(`${window.location.origin}/${path}/${encodeURIComponent(playlist.id)}`, playlist.name);
  };

  const copyShareLink = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showMessage(successMessage);
    } catch {
      showMessage("No se pudo copiar el enlace.");
    }
  };

  const openSongShareSheet = (song: Pick<ApiSong, "id" | "name"> & { url?: string }) => {
    const farreoUrl = `${window.location.origin}/play?song=${encodeURIComponent(song.id)}`;
    const mediaUrl = getMediaUrl(song.url);
    setActionSheet({
      title: "Compartir cancion",
      subtitle: song.name,
      items: [
        {
          label: "Copiar enlace de Farreo",
          detail: "Abre esta cancion en Farreo",
          icon: <Share2Icon size={18} />,
          onSelect: () => copyShareLink(farreoUrl, "Enlace de Farreo copiado."),
        },
        {
          label: "Copiar enlace del MP3",
          detail: "Archivo de audio directo",
          icon: <Music2Icon size={18} />,
          disabled: !mediaUrl,
          onSelect: () => copyShareLink(mediaUrl, "Enlace del MP3 copiado."),
        },
      ],
    });
  };

  const addSongToPlaylist = async (playlist: PrivatePlaylist, songId: string) => {
    try {
      await addSongToPrivatePlaylist(playlist.id, songId);
      await reloadUserLibrary();
      if (selectedPlaylist?.kind === "private" && selectedPlaylist.id === playlist.id) {
        const refreshedPlaylist = await getPrivatePlaylist(playlist.id);
        if (refreshedPlaylist) {
          setSelectedPlaylist(toMobilePrivatePlaylist(refreshedPlaylist));
          setSelectedTracks(privatePlaylistTracks(refreshedPlaylist));
        }
      }
      showMessage(`Anadida a ${playlist.nombre}.`);
    } catch {
      showMessage("No se pudo anadir la cancion.");
    }
  };

  const openAddToPlaylistSheet = (song: Pick<ApiSong, "id" | "name">) => {
    setActionSheet({
      title: "Anadir a playlist",
      subtitle: song.name,
      items: privatePlaylists.length > 0
        ? privatePlaylists.map((playlist) => ({
          label: playlist.nombre,
          detail: `${playlist.songIds.length} canciones`,
          icon: <SongArtwork src={playlist.iconUrl} alt="" className="mobile-farreo__action-icon" />,
          onSelect: () => addSongToPlaylist(playlist, song.id),
        }))
        : [{
          label: "No tienes playlists propias",
          detail: "Crea una playlist desde Home.",
          icon: <ListMusicIcon size={18} />,
          disabled: true,
          onSelect: () => undefined,
        }],
    });
  };

  const openPlaylistEditor = (mode: "create" | "edit", playlist?: MobilePlaylist) => {
    if (!user) {
      setTab("account");
      showMessage("Inicia sesion para crear playlists.");
      return;
    }

    if (mode === "edit" && playlist?.kind !== "private") return;
    setPlaylistEditor({
      mode,
      playlist,
      name: mode === "edit" && playlist ? playlist.name : "",
      iconUrl: mode === "edit" && playlist?.iconUrl ? playlist.iconUrl : "",
      visibility: mode === "edit" && playlist?.kind === "private" ? playlist.visibility || "private" : "private",
    });
  };

  const handlePlaylistEditorIconChange = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showMessage("El icono debe ser una imagen.");
      return;
    }
    if (file.size > 750 * 1024) {
      showMessage("El icono debe pesar menos de 750 KB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const iconUrl = String(reader.result || "");
      setPlaylistEditor((current) => current ? { ...current, iconUrl } : current);
    };
    reader.readAsDataURL(file);
  };

  const savePlaylistEditor = async () => {
    if (!user || !playlistEditor) return;
    const name = playlistEditor.name.trim();
    if (!name) {
      showMessage("Ponle un nombre a la playlist.");
      return;
    }

    setPlaylistSaving(true);
    try {
      let nextId = playlistEditor.playlist?.id;
      if (playlistEditor.mode === "create") {
        nextId = await createPrivatePlaylist({
          ownerId: user.uid,
          ownerEmail: user.email,
          nombre: name,
          iconUrl: playlistEditor.iconUrl.trim() || null,
          visibility: playlistEditor.visibility,
        });
      } else if (playlistEditor.playlist?.kind === "private") {
        await updatePrivatePlaylist(playlistEditor.playlist.id, {
          nombre: name,
          iconUrl: playlistEditor.iconUrl.trim() || null,
          visibility: playlistEditor.visibility,
        });
      }

      await reloadUserLibrary();
      if (nextId) {
        const fullPlaylist = await getPrivatePlaylist(nextId);
        if (fullPlaylist) {
          setSelectedPlaylist({
            kind: "private",
            id: fullPlaylist.id,
            name: fullPlaylist.nombre,
            iconUrl: fullPlaylist.iconUrl,
            count: fullPlaylist.songIds.length,
            visibility: fullPlaylist.visibility,
          });
          await loadPlaylist({
            kind: "private",
            id: fullPlaylist.id,
            name: fullPlaylist.nombre,
            iconUrl: fullPlaylist.iconUrl,
            count: fullPlaylist.songIds.length,
            visibility: fullPlaylist.visibility,
          });
        }
      }
      setPlaylistEditor(null);
      showMessage(playlistEditor.mode === "create" ? "Playlist creada." : "Playlist actualizada.");
    } catch {
      showMessage("No se pudo guardar la playlist.");
    } finally {
      setPlaylistSaving(false);
    }
  };

  const deleteMobilePlaylist = async (playlist: MobilePlaylist) => {
    if (playlist.kind !== "private") return;
    try {
      await deletePrivatePlaylist(playlist.id);
      await reloadUserLibrary();
      if (selectedPlaylist?.id === playlist.id && selectedPlaylist.kind === "private") {
        setSelectedPlaylist(null);
        setSelectedTracks([]);
        setTab("home");
      }
      showMessage("Playlist eliminada.");
    } catch {
      showMessage("No se pudo borrar la playlist.");
    }
  };

  const toggleFollowPlaylist = async (playlist: MobilePlaylist) => {
    if (playlist.kind !== "global") return;
    if (!user) {
      setTab("account");
      showMessage("Inicia sesion para seguir playlists.");
      return;
    }

    try {
      if (followedIds.has(playlist.id)) {
        await unfollowGlobalPlaylist(user.uid, playlist.id);
      } else {
        await followGlobalPlaylist({ userId: user.uid, userEmail: user.email, playlistId: playlist.id });
      }
      await reloadUserLibrary();
    } catch {
      showMessage("No se pudo actualizar el seguimiento.");
    }
  };

  const removeTrackFromCurrentPlaylist = async (track: MusicTrack) => {
    if (!selectedPlaylist || selectedPlaylist.kind !== "private") return;
    try {
      await removeSongFromPrivatePlaylist(selectedPlaylist.id, track.id);
      setSelectedTracks((prev) => prev.filter((item) => item.id !== track.id));
      setSelectedPlaylist((current) => current && current.kind === "private"
        ? { ...current, count: Math.max(0, current.count - 1) }
        : current);
      await reloadUserLibrary();
      showMessage("Cancion quitada.");
    } catch {
      showMessage("No se pudo quitar la cancion.");
    }
  };

  const clearPlaylistDrag = () => {
    playlistDragRef.current = null;
    setDraggedPlaylistIndex(null);
    setPlaylistDropIndex(null);
  };

  const startPlaylistDrag = (event: ReactPointerEvent<HTMLButtonElement>, fromIndex: number) => {
    if (!selectedPlaylist || selectedPlaylist.kind !== "private") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    playlistDragRef.current = { pointerId: event.pointerId, fromIndex, overIndex: fromIndex };
    setDraggedPlaylistIndex(fromIndex);
    setPlaylistDropIndex(fromIndex);
  };

  const updatePlaylistDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = playlistDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.preventDefault();
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-mobile-playlist-index]");
    const targetIndex = Number(target?.dataset.mobilePlaylistIndex);
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex === drag.overIndex) return;

    drag.overIndex = targetIndex;
    setPlaylistDropIndex(targetIndex);
  };

  const finishPlaylistDrag = async (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = playlistDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const playlist = selectedPlaylist;
    clearPlaylistDrag();
    if (!playlist || playlist.kind !== "private" || drag.fromIndex === drag.overIndex) return;

    const previousTracks = selectedTracksRef.current;
    const displayTracks = [...previousTracks].reverse();
    const [moved] = displayTracks.splice(drag.fromIndex, 1);
    if (!moved) return;
    displayTracks.splice(drag.overIndex, 0, moved);
    const nextTracks = [...displayTracks].reverse();
    setSelectedTracks(nextTracks);

    try {
      await reorderPrivatePlaylistSongs(playlist.id, nextTracks.map((track) => track.id));
      await reloadUserLibrary();
    } catch {
      setSelectedTracks(previousTracks);
      showMessage("No se pudo guardar el nuevo orden.");
    }
  };

  const addSongToRadio = async (song: ApiSong) => {
    try {
      const nextState = await radioPost<RadioState>("/radio/queue/songs", {
        songIds: [song.id],
        insertAt: "last",
        randomPitch: autoRandomPitch,
        pitch: activePitch,
      });
      calibrateRadioClock(nextState, Date.now());
      setRadioPreviewState(nextState);
      showMessage("Anadida a la radio.");
    } catch {
      showMessage("No se pudo anadir a la radio.");
    }
  };

  const enterRadio = async () => {
    const native = nativeAvailable ? getFarreoNativeAudio() : await activateNativeAudio();
    if (native) {
      setNativeState(await native.enterRadio({ apiUrl: MUSIC_API_URL }));
      return;
    }
    await enableRadioMode();
  };

  const toggleRadioPlayback = async () => {
    if (!displayedRadioState?.currentItem) {
      await enterRadio();
      return;
    }

    try {
      const shouldPause = displayedRadioState.status === "playing";
      const nextState = await radioPost<RadioState>(shouldPause ? "/radio/pause" : "/radio/play");
      calibrateRadioClock(nextState, Date.now());
      setRadioPreviewState(nextState);
      if (!shouldPause) await enterRadio();
    } catch {
      showMessage("No se pudo controlar la radio.");
    }
  };

  const toggleMobilePlayback = async () => {
    const native = nativeAvailable ? getFarreoNativeAudio() : null;
    if (native) {
      if (!activeIsPlaying) beginPlaybackFeedback();
      setNativeState(activeIsPlaying ? await native.pause() : await native.play());
      return;
    }
    if (!activeIsPlaying) beginPlaybackFeedback();
    togglePlayPause();
  };

  const nextMobileTrack = async () => {
    beginPlaybackFeedback();
    const native = nativeAvailable ? getFarreoNativeAudio() : null;
    if (native) {
      setNativeState(await native.next());
      return;
    }
    playNext();
  };

  const previousMobileTrack = async () => {
    beginPlaybackFeedback();
    const native = nativeAvailable ? getFarreoNativeAudio() : null;
    if (native) {
      setNativeState(await native.previous());
      return;
    }
    playPrev();
  };

  const seekMobileTrack = async (position: number) => {
    const native = nativeAvailable ? getFarreoNativeAudio() : null;
    if (native) {
      setNativeState(await native.seek({ position }));
      return;
    }
    handleSeek(position);
  };

  const setMobilePitch = async (pitch: number) => {
    const native = nativeAvailable ? getFarreoNativeAudio() : null;
    if (native) {
      setNativeState(await native.setPitch({ pitch }));
      return;
    }
    handlePitchChange(pitch);
  };

  const randomizeMobilePitch = async () => {
    setAutoRandomPitch(true);
    await setMobilePitch(Math.random() * (1.2 - 0.8) + 0.8);
  };

  const resetMobilePitch = async () => {
    setAutoRandomPitch(false);
    await setMobilePitch(1);
  };

  const setMobileShuffle = async () => {
    const native = nativeAvailable ? getFarreoNativeAudio() : null;
    if (native) {
      setNativeState(await native.setShuffle({ shuffle: !activeShuffle }));
      return;
    }
    setIsShuffle((prev) => !prev);
  };

  const openPlaylistActions = (playlist: MobilePlaylist) => {
    const commonItems: MobileActionItem[] = [
      { label: "Compartir", icon: <Share2Icon size={18} />, onSelect: () => sharePlaylist(playlist) },
    ];

    if (playlist.kind === "private") {
      setActionSheet({
        title: playlist.name,
        subtitle: "Playlist propia",
        items: [
          {
            label: "Anadir canciones",
            detail: "Buscar en tu biblioteca",
            icon: <PlusIcon size={18} />,
            onSelect: () => {
              setQuery("");
              setTab("search");
              showMessage("Busca una cancion para anadirla.");
            },
          },
          ...commonItems,
          { label: "Editar", icon: <PencilIcon size={18} />, onSelect: () => openPlaylistEditor("edit", playlist) },
          { label: "Borrar", icon: <TrashIcon size={18} />, danger: true, onSelect: () => deleteMobilePlaylist(playlist) },
        ],
      });
      return;
    }

    setActionSheet({
      title: playlist.name,
      subtitle: "Playlist global",
      items: [
        ...commonItems,
        {
          label: followedIds.has(playlist.id) ? "Dejar de seguir" : "Seguir",
          icon: <HeartIcon size={18} fill={followedIds.has(playlist.id) ? "currentColor" : "none"} />,
          onSelect: () => toggleFollowPlaylist(playlist),
        },
      ],
    });
  };

  const openSongActions = (song: Pick<ApiSong, "id" | "name"> & { url?: string }, options?: { fromPlaylist?: boolean; track?: MusicTrack }) => {
    const items: MobileActionItem[] = [
      { label: "Reproducir", icon: <PlayIcon size={18} />, onSelect: () => {
        if (options?.track && selectedPlaylist) {
          const playbackTracks = getPlaybackOrder(selectedTracks);
          const playbackIndex = playbackTracks.findIndex((item) => item.id === options.track?.id);
          void playTracks(playbackTracks, {
            id: selectedPlaylist.id,
            name: selectedPlaylist.name,
            type: selectedPlaylist.kind,
          }, Math.max(0, playbackIndex), { shuffle: false });
        } else {
          const apiSong = songs.find((entry) => entry.id === song.id);
          if (apiSong) void playSong(apiSong);
        }
      } },
      { label: "Anadir a playlist", icon: <PlusIcon size={18} />, onSelect: () => openAddToPlaylistSheet(song) },
      { label: "Compartir", icon: <Share2Icon size={18} />, onSelect: () => openSongShareSheet({ ...song, url: song.url || options?.track?.url || "" }) },
    ];

    if (!options?.fromPlaylist) {
      items.splice(2, 0, { label: "Anadir a radio", icon: <RadioIcon size={18} />, onSelect: () => {
        const apiSong = songs.find((entry) => entry.id === song.id);
        if (apiSong) void addSongToRadio(apiSong);
      } });
    }

    if (options?.track && selectedPlaylist?.kind === "private") {
      items.push({ label: "Quitar de la playlist", icon: <TrashIcon size={18} />, danger: true, onSelect: () => options.track && removeTrackFromCurrentPlaylist(options.track) });
    }

    setActionSheet({
      title: song.name,
      subtitle: options?.fromPlaylist ? "Cancion en playlist" : "Cancion",
      items,
    });
  };

  const renderPlaylistCard = (playlist: MobilePlaylist, compact = false) => (
    <button
      type="button"
      key={`${playlist.kind}-${playlist.id}`}
      className={`mobile-farreo__playlist-card ${compact ? "mobile-farreo__playlist-card--compact" : ""}`}
      onClick={() => {
        if (globalCarouselMovedRef.current) {
          return;
        }
        if (consumeLongPressClick()) return;
        void loadPlaylist(playlist);
      }}
      {...longPressProps(() => openPlaylistActions(playlist))}
    >
      <SongArtwork src={playlist.iconUrl} alt={playlist.name} className="mobile-farreo__playlist-art" />
      <span className="mobile-farreo__playlist-title">{playlist.name}</span>
      <span className="mobile-farreo__playlist-meta">
        {playlist.count} canciones
        {playlist.kind === "private" && playlist.visibility === "private" ? " · Privada" : ""}
        {playlist.kind === "global" && playlist.followed ? " · Siguiendo" : ""}
      </span>
    </button>
  );

  const renderCreatePlaylistCard = () => (
    <button
      type="button"
      key="create-private-playlist"
      className="mobile-farreo__playlist-card mobile-farreo__playlist-card--compact mobile-farreo__playlist-card--create"
      onClick={() => openPlaylistEditor("create")}
    >
      <span className="mobile-farreo__playlist-art mobile-farreo__playlist-art--create">
        <ListMusicIcon size={22} />
        <PlusIcon size={16} />
      </span>
      <span className="mobile-farreo__playlist-title">Nueva Playlist</span>
      <span className="mobile-farreo__playlist-meta">Crear privada</span>
    </button>
  );

  const renderPlaylistDetail = () => {
    if (!selectedPlaylist) {
      return (
        <section className="mobile-farreo__section">
          <div className="mobile-farreo__empty">
            <ListMusicIcon size={20} />
            <span>Elige una playlist desde Home para abrirla aqui.</span>
          </div>
        </section>
      );
    }

    const playbackTracks = getPlaybackOrder(selectedTracks);
    const displayTracks = [...selectedTracks].reverse();
    const source: MusicPlaylistSource = {
      id: selectedPlaylist.id,
      name: selectedPlaylist.name,
      type: selectedPlaylist.kind,
    };

    return (
      <section className="mobile-farreo__section">
        <article className="mobile-farreo__playlist-detail mobile-farreo__playlist-detail--standalone">
          <header ref={playlistHeroRef} className="mobile-farreo__playlist-hero">
            <div className="mobile-farreo__playlist-hero-backdrop" aria-hidden="true">
              <SongArtwork src={selectedPlaylist.iconUrl} alt="" />
            </div>
            <button type="button" className="mobile-farreo__playlist-back" onClick={() => setTab("home")} aria-label="Volver a Home">
              <ArrowLeftIcon size={24} />
            </button>
            <div className="mobile-farreo__playlist-hero-content">
              <SongArtwork src={selectedPlaylist.iconUrl} alt={selectedPlaylist.name} className="mobile-farreo__playlist-hero-art" />
              <div className="mobile-farreo__playlist-hero-copy">
                <span className="mobile-farreo__eyebrow">{selectedPlaylist.kind === "private" ? "Playlist propia" : "Playlist global"}</span>
                <h1>{selectedPlaylist.name}</h1>
                <p>{selectedTracks.length} canciones{selectedPlaylist.kind === "private" && selectedPlaylist.visibility === "private" ? " · Privada" : ""}</p>
              </div>
            </div>
          </header>
          <div className="mobile-farreo__detail-actions">
            <div className="mobile-farreo__detail-utilities">
              {showPlaylistReturn && (
                <button
                  type="button"
                  className="mobile-farreo__detail-utility"
                  onClick={() => playlistHeroRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  title="Volver a la portada"
                  aria-label="Volver a la portada"
                >
                  <ArrowUpIcon size={21} />
                </button>
              )}
              {selectedPlaylist.kind === "private" && (
                <button
                  type="button"
                  className="mobile-farreo__detail-utility mobile-farreo__detail-utility--label"
                  onClick={() => {
                    setQuery("");
                    setTab("search");
                    showMessage("Busca una cancion para anadirla.");
                  }}
                >
                  <PlusIcon size={20} />
                  <span>Anadir</span>
                </button>
              )}
              <button
                type="button"
                className={activeShuffle ? "mobile-farreo__detail-utility mobile-farreo__detail-utility--active" : "mobile-farreo__detail-utility"}
                onClick={() => void setMobileShuffle()}
                title="Alternar aleatorio"
              >
                <ShuffleIcon size={22} />
              </button>
              {selectedPlaylist.kind === "global" && (
                <button
                  type="button"
                  className={followedIds.has(selectedPlaylist.id) ? "mobile-farreo__detail-utility mobile-farreo__detail-utility--followed" : "mobile-farreo__detail-utility"}
                  onClick={() => void toggleFollowPlaylist(selectedPlaylist)}
                  title={followedIds.has(selectedPlaylist.id) ? "Dejar de seguir" : "Seguir"}
                >
                  <HeartIcon size={20} fill={followedIds.has(selectedPlaylist.id) ? "currentColor" : "none"} />
                </button>
              )}
              <button type="button" className="mobile-farreo__detail-utility" onClick={() => openPlaylistActions(selectedPlaylist)} aria-label="Opciones de playlist">
                <MoreVerticalIcon size={22} />
              </button>
            </div>
            <button
              type="button"
              className="mobile-farreo__round-button mobile-farreo__round-button--playlist-play"
              disabled={selectedTracks.length === 0}
              onClick={() => {
                if (selectedPlaylistIsActive) {
                  void toggleMobilePlayback();
                  return;
                }
                void playTracks(playbackTracks, source, 0, { shuffle: activeShuffle });
              }}
              aria-label={selectedPlaylistIsActive && activeIsPlaying ? "Pausar playlist" : "Reproducir playlist"}
            >
              {selectedPlaylistIsActive && activeIsPlaying ? (
                <PauseIcon size={26} fill="currentColor" />
              ) : (
                <PlayIcon size={26} fill="currentColor" />
              )}
            </button>
          </div>
          {loadingPlaylist ? (
            <div className="mobile-farreo__playlist-loader" role="status" aria-live="polite">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/farreo-f.png" alt="" />
              <div className="mobile-farreo__loader-bars" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <strong>Cargando canciones</strong>
              <small>Preparando tu playlist...</small>
            </div>
          ) : (
            <div className="mobile-farreo__song-list">
              {displayTracks.map((track, index) => {
                const playbackIndex = playbackTracks.findIndex((item) => item.id === track.id);
                const isDragging = draggedPlaylistIndex === index;
                const isDropTarget = playlistDropIndex === index && draggedPlaylistIndex !== index;
                const isCurrentTrack = selectedPlaylistIsActive && activeIsPlaying && activeTrack?.id === track.id;
                return (
                  <article
                    key={`${track.id}-${index}`}
                    data-mobile-playlist-index={index}
                    className={`mobile-farreo__playlist-song ${selectedPlaylist.kind === "private" ? "mobile-farreo__playlist-song--editable" : ""} ${isDragging ? "mobile-farreo__playlist-song--dragging" : ""} ${isDropTarget ? "mobile-farreo__playlist-song--drop-target" : ""}`}
                    {...longPressProps(() => openSongActions({ id: track.id, name: track.name, url: track.url }, { fromPlaylist: true, track }))}
                  >
                    {selectedPlaylist.kind === "private" && (
                      <button
                        type="button"
                        className="mobile-farreo__drag-handle"
                        onPointerDown={(event) => startPlaylistDrag(event, index)}
                        onPointerMove={updatePlaylistDrag}
                        onPointerUp={(event) => void finishPlaylistDrag(event)}
                        onPointerCancel={clearPlaylistDrag}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`Mover ${track.name}`}
                      >
                        <GripVerticalIcon size={19} />
                      </button>
                    )}
                    <button
                      type="button"
                      className={`mobile-farreo__song-row mobile-farreo__song-row--playlist ${isCurrentTrack ? "mobile-farreo__song-row--current" : ""}`}
                      onClick={() => {
                        if (consumeLongPressClick()) return;
                        void playTracks(playbackTracks, source, Math.max(0, playbackIndex), { shuffle: false });
                      }}
                    >
                      <SongArtwork src={track.iconUrl} alt={track.name} className="mobile-farreo__song-art" />
                      <span>
                        <strong>{isCurrentTrack && <AudioLinesIcon size={18} />} {track.name}</strong>
                        <small>{formatTime(track.duration)}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="mobile-farreo__row-menu"
                      onClick={() => openSongActions({ id: track.id, name: track.name, url: track.url }, { fromPlaylist: true, track })}
                      aria-label="Opciones de cancion"
                    >
                      <MoreVerticalIcon size={22} />
                    </button>
                  </article>
                );
              })}
              {selectedTracks.length === 0 && <div className="mobile-farreo__empty">Esta playlist esta vacia.</div>}
            </div>
          )}
        </article>
      </section>
    );
  };

  const saveProfileName = async () => {
    const current = auth?.currentUser;
    if (!current) return;
    const nextName = profileName.trim();
    if (!nextName) {
      showMessage("El nombre no puede estar vacio.");
      return;
    }

    setProfileSaving(true);
    try {
      await updateProfile(current, { displayName: nextName });
      setProfileName(nextName);
      setUser(auth?.currentUser ?? current);
      showMessage("Perfil actualizado.");
    } catch {
      showMessage("No se pudo guardar el perfil.");
    } finally {
      setProfileSaving(false);
    }
  };

  const loginWithGoogle = async () => {
    if (!auth) {
      showMessage("Firebase no esta configurado.");
      return;
    }

    setLoginLoading(true);
    try {
      const nativeGoogle = getFarreoNativeGoogleAuth();
      if (nativeGoogle) {
        const webClientId = process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID || "";
        if (!webClientId) throw new Error("Falta configurar Google para la APK.");
        const { idToken } = await nativeGoogle.signIn({ webClientId });
        await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
      } else {
        await signInWithPopup(auth, new GoogleAuthProvider());
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "No se pudo iniciar sesion con Google.");
    } finally {
      setLoginLoading(false);
    }
  };

  const renderAdvancedArtwork = () => {
    if (!activeTrack) return null;
    const advancedUrl = getMediaUrl(activeTrack.advancedCoverUrl);
    const isAdvancedVideo = Boolean(advancedUrl) && (
      activeTrack.advancedCoverType?.startsWith("video") ||
      /\.(mp4|webm|mov)(\?|#|$)/i.test(advancedUrl)
    );

    if (advancedUrl) {
      return (
        <div className="mobile-farreo__sheet-advanced-cover">
          {isAdvancedVideo ? (
            <video src={advancedUrl} muted autoPlay loop playsInline />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={advancedUrl} alt="" />
          )}
          <div className="mobile-farreo__sheet-advanced-info">
            <SongArtwork src={activeTrack.iconUrl} alt={activeTrack.name} className="mobile-farreo__sheet-cover-thumb" />
            <h2>{activeTrack.name}</h2>
          </div>
        </div>
      );
    }

    return (
      <SongArtwork src={activeTrack.iconUrl} alt={activeTrack.name} className="mobile-farreo__sheet-art" />
    );
  };

  return (
    <div
      className={`mobile-farreo ${activeTrack ? "mobile-farreo--with-player" : ""}`}
      onDragStart={(event) => event.preventDefault()}
    >
      {message && <div className="mobile-farreo__toast">{message}</div>}

      {tab === "home" && (
        <section className="mobile-farreo__section">
          <div className="mobile-farreo__section-title">
            <HomeIcon size={18} />
            <h2>Para ti</h2>
          </div>
          {!user && (
            <div className="mobile-farreo__empty">
              <UserIcon size={20} />
              <span>Entra con tu cuenta para ver tus playlists propias.</span>
            </div>
          )}
          <div className="mobile-farreo__own-grid">
            {libraryPlaylists.map((playlist) => renderPlaylistCard(playlist, true))}
            {renderCreatePlaylistCard()}
          </div>

          <div className="mobile-farreo__section-title mobile-farreo__section-title--spaced">
            <Globe2Icon size={18} />
            <h2>Playlists globales</h2>
          </div>
          <div
            ref={globalCarouselRef}
            className="mobile-farreo__global-carousel"
            aria-label="Playlists globales deslizables"
            onPointerDown={beginGlobalCarouselDrag}
            onPointerMove={moveGlobalCarouselDrag}
            onPointerUp={finishGlobalCarouselDrag}
            onPointerCancel={finishGlobalCarouselDrag}
            onScroll={recenterGlobalCarousel}
          >
            {loopGlobalCards.map((playlist, index) => (
              <div key={`${playlist.kind}-${playlist.id}-${index}`} className="mobile-farreo__global-slide">
                {renderPlaylistCard(playlist)}
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === "playlist" && renderPlaylistDetail()}

      {tab === "search" && (
        <section className="mobile-farreo__section">
          <label className="mobile-farreo__search">
            <SearchIcon size={19} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar canciones..."
            />
          </label>
          {hiddenLoading ? (
            <div className="mobile-farreo__empty">Preparando busqueda...</div>
          ) : query.trim() ? (
            <div className="mobile-farreo__song-list">
              {searchedSongs.map((song) => {
                const isCurrentSong = activeIsPlaying && activeTrack?.id === song.id;
                return (
                  <article
                    key={song.id}
                    className="mobile-farreo__search-result"
                    {...longPressProps(() => openSongActions(song))}
                  >
                    <button
                      type="button"
                      className={`mobile-farreo__song-row mobile-farreo__song-row--catalog ${isCurrentSong ? "mobile-farreo__song-row--current" : ""}`}
                      onClick={() => {
                        if (consumeLongPressClick()) return;
                        void playSong(song);
                      }}
                    >
                      <span className="mobile-farreo__song-art-wrap">
                        <SongArtwork src={song.iconUrl} alt={song.name} className="mobile-farreo__song-art" />
                        {isCurrentSong ? <AudioLinesIcon size={17} /> : <PlayIcon size={17} fill="currentColor" />}
                      </span>
                      <span>
                        <strong>{isCurrentSong && <AudioLinesIcon size={18} />} {song.name}</strong>
                        <small>{song.variantes?.slice(0, 2).join(", ") || formatTime(song.duration)}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="mobile-farreo__row-menu"
                      onClick={() => openSongActions(song)}
                      aria-label="Opciones de cancion"
                    >
                      <MoreHorizontalIcon size={20} />
                    </button>
                  </article>
                );
              })}
              {searchedSongs.length === 0 && <div className="mobile-farreo__empty">No hay resultados.</div>}
            </div>
          ) : (
            <div className="mobile-farreo__empty">Busca por titulo o nombres alternativos.</div>
          )}
        </section>
      )}

      {tab === "radio" && (
        <section className="mobile-farreo__section">
          <article className="mobile-farreo__radio-card">
            <span className="mobile-farreo__eyebrow">Estacion sincronizada</span>
            <h2>{displayedRadioState?.currentItem?.song.name || "Radio vacia"}</h2>
            <p>{displayedRadioState?.currentItem?.source.name || "Cualquiera puede anadir canciones a la cola."}</p>
            <div className="mobile-farreo__radio-progress">
              <span>{formatTime(liveRadioPosition)}</span>
              <div><span style={{ width: `${displayedRadioState?.currentItem?.song.duration ? (liveRadioPosition / displayedRadioState.currentItem.song.duration) * 100 : 0}%` }} /></div>
              <span>{formatTime(displayedRadioState?.currentItem?.song.duration)}</span>
            </div>
            <div className="mobile-farreo__controls">
              <button type="button" onClick={() => void enterRadio()}>
                Unirse al directo
              </button>
              <button type="button" onClick={() => void toggleRadioPlayback()}>
                {displayedRadioState?.status === "playing" ? <PauseIcon size={23} fill="currentColor" /> : <PlayIcon size={23} fill="currentColor" />}
              </button>
              <button type="button" onClick={() => void nextMobileTrack()} disabled={!activeCanPlayNext}>
                <SkipForwardIcon size={22} />
              </button>
            </div>
          </article>
          <button type="button" className="mobile-farreo__radio-search-link" onClick={() => setTab("search")}>
            <SearchIcon size={18} />
            Buscar canciones para anadir
          </button>
          <div className="mobile-farreo__section-title">
            <ListMusicIcon size={18} />
            <h2>Cola</h2>
          </div>
          <div className="mobile-farreo__song-list">
            {(displayedRadioState?.queue || []).map((item, index) => {
              const isCurrentSong = activeIsPlaying && activeTrack?.id === item.song.id;
              return (
                <div key={item.itemId} className={`mobile-farreo__song-row mobile-farreo__song-row--catalog mobile-farreo__song-row--static ${isCurrentSong ? "mobile-farreo__song-row--current" : ""}`}>
                  <SongArtwork src={item.song.iconUrl} alt={item.song.name} className="mobile-farreo__song-art" />
                  <span>
                    <strong>{isCurrentSong && <AudioLinesIcon size={18} />} {index === 0 ? "Ahora: " : ""}{item.song.name}</strong>
                    <small>{item.source.name} - Pitch {item.pitch.toFixed(2)}x</small>
                  </span>
                </div>
              );
            })}
            {(!displayedRadioState?.queue || displayedRadioState.queue.length === 0) && <div className="mobile-farreo__empty">La cola esta vacia.</div>}
          </div>
        </section>
      )}

      {tab === "account" && (
        <section className="mobile-farreo__section">
          <article className="mobile-farreo__account-card">
            {user?.photoURL ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.photoURL} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span><UserIcon size={28} /></span>
            )}
            <div>
              <h2>{user?.displayName || user?.email || "Sin sesion"}</h2>
              <p>{user?.email || "Correo no disponible"}</p>
            </div>
          </article>
          {user ? (
            <>
              <article className="mobile-farreo__profile-card">
                <label>
                  <span>Nombre visible</span>
                  <input
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                    placeholder="Tu nombre"
                  />
                </label>
                <button type="button" onClick={() => void saveProfileName()} disabled={profileSaving}>
                  {profileSaving ? "Guardando..." : "Guardar cambios"}
                </button>
              </article>
              <button type="button" className="mobile-farreo__account-action" onClick={() => auth && void signOut(auth)}>
                <LogOutIcon size={18} />
                Cerrar sesion
              </button>
            </>
          ) : (
            <button type="button" className="mobile-farreo__account-action" onClick={() => void loginWithGoogle()} disabled={loginLoading}>
              <LogInIcon size={18} />
              {loginLoading ? "Abriendo Google..." : "Iniciar sesion con Google"}
            </button>
          )}
        </section>
      )}

      {activeTrack && (
        <MobileMiniPlayer
          key={`${nativeAvailable ? "native" : "web"}-${activeTrack.id}`}
          track={activeTrack}
          source={activeSource}
          nativeAvailable={nativeAvailable}
          initialPosition={activeCurrentTime}
          duration={currentDuration}
          webPosition={currentTime}
          webLyric={currentLyric}
          lyricCues={lyricCues}
          isPlaying={activeIsPlaying}
          isBuffering={showPlaybackLoading}
          canPlayPrev={activeCanPlayPrev}
          canPlayNext={activeCanPlayNext}
          onOpen={openAdvancedPlayer}
          onToggle={() => void toggleMobilePlayback()}
          onPrevious={() => void previousMobileTrack()}
          onNext={() => void nextMobileTrack()}
        />
      )}

      {activeTrack && (
        <div className={`mobile-farreo__sheet-layer ${playerOpen ? "mobile-farreo__sheet-layer--open" : ""} ${playerClosing ? "mobile-farreo__sheet-layer--closing" : ""}`} aria-hidden={!playerOpen}>
          <button type="button" className="mobile-farreo__sheet-backdrop" onClick={closeAdvancedPlayer} />
          <section className="mobile-farreo__player-sheet" aria-label="Reproductor">
            <div
              className="mobile-farreo__sheet-dismiss-zone"
              onPointerDown={beginSheetDismiss}
              onPointerMove={moveSheetDismiss}
              onPointerUp={finishSheetDismiss}
              onPointerCancel={(event) => {
                event.preventDefault();
                event.stopPropagation();
                sheetDismissDragRef.current = null;
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <button type="button" className="mobile-farreo__sheet-handle" aria-label="Cerrar reproductor" />
              {renderAdvancedArtwork()}
            </div>
            <div className="mobile-farreo__sheet-title-row">
              <div>
                <h2>{activeTrack.name}</h2>
                <p>{activeSource?.name || "Cancion suelta"}</p>
              </div>
              <button type="button" onClick={() => openSongShareSheet({ id: activeTrack.id, name: activeTrack.name, url: activeTrack.url })} title="Compartir">
                <Share2Icon size={20} />
              </button>
            </div>
            <div className="mobile-farreo__timeline">
              <span>{formatTime(activeCurrentTime)}</span>
              <input
                type="range"
                min={0}
                max={currentDuration || 0}
                value={Math.min(activeCurrentTime, currentDuration || activeCurrentTime)}
                onPointerDown={beginTimelineGesture}
                onPointerMove={moveTimelineGesture}
                onPointerUp={finishTimelineGesture}
                onPointerCancel={() => {
                  timelineGestureRef.current = null;
                  timelineSuppressSeekUntilRef.current = Date.now() + 300;
                }}
                onChange={(event) => {
                  const position = Number(event.target.value);
                  if (timelineGestureRef.current) {
                    timelineGestureRef.current.pendingPosition = position;
                    return;
                  }
                  if (Date.now() < timelineSuppressSeekUntilRef.current) return;
                  void seekMobileTrack(position);
                }}
              />
              <span>{formatTime(currentDuration)}</span>
            </div>
            <div className="mobile-farreo__controls mobile-farreo__controls--wide">
              <button type="button" onClick={() => void setMobileShuffle()} className={activeShuffle ? "mobile-farreo__control-active" : ""}>
                <ShuffleIcon size={20} />
              </button>
              <button type="button" onClick={() => void previousMobileTrack()} disabled={!activeCanPlayPrev}><SkipBackIcon size={21} /></button>
              <button type="button" className="mobile-farreo__play-main" onClick={() => void toggleMobilePlayback()}>
                {showPlaybackLoading ? (
                  <LoaderCircleIcon size={26} className="mobile-farreo__spinner" />
                ) : activeIsPlaying ? (
                  <PauseIcon size={25} fill="currentColor" />
                ) : (
                  <PlayIcon size={25} fill="currentColor" />
                )}
              </button>
              <button type="button" onClick={() => void nextMobileTrack()} disabled={!activeCanPlayNext}><SkipForwardIcon size={21} /></button>
              <button type="button" onClick={() => setFollowLyrics((value) => !value)} className={followLyrics ? "mobile-farreo__control-active" : ""}>
                <Mic2Icon size={20} />
              </button>
            </div>
            <div className="mobile-farreo__sliders">
              <div className="mobile-farreo__pitch-panel">
                <div className="mobile-farreo__pitch-head">
                  <span>Pitch {activePitch.toFixed(2)}x</span>
                  <div>
                    <button
                      type="button"
                      className={autoRandomPitch ? "mobile-farreo__pitch-chip mobile-farreo__pitch-chip--active" : "mobile-farreo__pitch-chip"}
                      onClick={() => void randomizeMobilePitch()}
                      title="Pitch aleatorio"
                    >
                      <DicesIcon size={17} />
                    </button>
                    <button type="button" className="mobile-farreo__pitch-chip" onClick={() => void resetMobilePitch()} title="Volver a x1">
                      <RotateCcwIcon size={16} />
                      x1
                    </button>
                  </div>
                </div>
                <input type="range" min={0.5} max={1.5} step={0.01} value={activePitch} onChange={(event) => void setMobilePitch(Number(event.target.value))} />
              </div>
            </div>
            <article className="mobile-farreo__lyrics-card">
              <div className="mobile-farreo__section-title">
                <Mic2Icon size={18} />
                <h2>Lyrics</h2>
                <button type="button" className="mobile-farreo__lyrics-toggle" onClick={() => setLyricsOpen((value) => !value)}>
                  {lyricsOpen ? "Ocultar" : "Ver"}
                </button>
              </div>
              {lyricsOpen && lyricCues.length > 0 ? (
                <div className="mobile-farreo__lyrics-list">
                  {lyricCues.map((cue) => {
                    const active = activeLyric?.id === cue.id;
                    return (
                      <button
                        key={cue.id}
                        ref={active ? activeLyricRef : undefined}
                        type="button"
                        className={active ? "mobile-farreo__lyric-line mobile-farreo__lyric-line--active" : "mobile-farreo__lyric-line"}
                        onClick={() => void seekMobileTrack(cue.start)}
                      >
                        <span>{formatTime(cue.start)}</span>
                        <strong>{cue.text}</strong>
                      </button>
                    );
                  })}
                </div>
              ) : lyricsOpen && activeTrack.staticLyrics ? (
                <pre>{activeTrack.staticLyrics}</pre>
              ) : lyricsOpen ? (
                <div className="mobile-farreo__empty">
                  <LockIcon size={18} />
                  <span>Esta cancion no tiene lyrics disponibles.</span>
                </div>
              ) : (
                <p className="mobile-farreo__lyrics-preview">
                  {activeLyric?.text || (lyricCues.length > 0 || activeTrack.staticLyrics ? "Lyrics disponibles" : "Sin lyrics disponibles")}
                </p>
              )}
            </article>
            <div className="mobile-farreo__info-grid">
              <div>
                <span>Duracion</span>
                <strong>{formatTime(currentDuration)}</strong>
              </div>
              <div>
                <span>Anadida a Farreo</span>
                <strong>{formatDate(activeTrack.createdAt || activeTrack.addedAt)}</strong>
              </div>
            </div>
          </section>
        </div>
      )}

      {playlistEditor && (
        <div className="mobile-farreo__modal-layer">
          <button type="button" className="mobile-farreo__modal-backdrop" onClick={() => setPlaylistEditor(null)} />
          <form
            className="mobile-farreo__modal-card"
            onSubmit={(event) => {
              event.preventDefault();
              void savePlaylistEditor();
            }}
          >
            <div className="mobile-farreo__modal-header">
              <h2>{playlistEditor.mode === "create" ? "Nueva playlist" : "Editar playlist"}</h2>
              <button type="button" onClick={() => setPlaylistEditor(null)} aria-label="Cerrar">x</button>
            </div>
            <label className="mobile-farreo__field">
              <span>Nombre</span>
              <input
                value={playlistEditor.name}
                onChange={(event) => setPlaylistEditor((current) => current ? { ...current, name: event.target.value } : current)}
                placeholder="Nombre de la playlist"
                autoFocus
              />
            </label>
            <label className="mobile-farreo__file-field">
              <input
                type="file"
                accept="image/*"
                onChange={(event) => handlePlaylistEditorIconChange(event.target.files?.[0] ?? null)}
              />
              <span>
                <ImageIcon size={18} />
                {playlistEditor.iconUrl ? "Cambiar icono" : "Subir icono"}
              </span>
              <small>Imagen JPG, PNG o WebP. Maximo 750 KB.</small>
            </label>
            {playlistEditor.iconUrl && (
              <div className="mobile-farreo__file-preview">
                <SongArtwork src={playlistEditor.iconUrl} alt="Vista previa del icono" />
                <button
                  type="button"
                  onClick={() => setPlaylistEditor((current) => current ? { ...current, iconUrl: "" } : current)}
                >
                  <XIcon size={16} /> Quitar
                </button>
              </div>
            )}
            <div className="mobile-farreo__segmented">
              <button
                type="button"
                className={playlistEditor.visibility === "private" ? "mobile-farreo__segment mobile-farreo__segment--active" : "mobile-farreo__segment"}
                onClick={() => setPlaylistEditor((current) => current ? { ...current, visibility: "private" } : current)}
              >
                Privada
              </button>
              <button
                type="button"
                className={playlistEditor.visibility === "public" ? "mobile-farreo__segment mobile-farreo__segment--active" : "mobile-farreo__segment"}
                onClick={() => setPlaylistEditor((current) => current ? { ...current, visibility: "public" } : current)}
              >
                Publica
              </button>
            </div>
            <button type="submit" className="mobile-farreo__submit" disabled={playlistSaving}>
              {playlistSaving ? "Guardando..." : playlistEditor.mode === "create" ? "Crear playlist" : "Guardar cambios"}
            </button>
          </form>
        </div>
      )}

      {actionSheet && (
        <div className="mobile-farreo__modal-layer">
          <button type="button" className="mobile-farreo__modal-backdrop" onClick={closeActionSheet} />
          <section className="mobile-farreo__action-sheet" aria-label="Acciones">
            <div className="mobile-farreo__sheet-handle" />
            <div className="mobile-farreo__action-head">
              <h2>{actionSheet.title}</h2>
              {actionSheet.subtitle && <p>{actionSheet.subtitle}</p>}
            </div>
            <div className="mobile-farreo__action-list">
              {actionSheet.items.map((item) => (
                <button
                  key={`${actionSheet.title}-${item.label}`}
                  type="button"
                  className={`mobile-farreo__action-item ${item.danger ? "mobile-farreo__action-item--danger" : ""}`}
                  disabled={item.disabled}
                  onClick={() => runActionItem(item)}
                >
                  <span>{item.icon}</span>
                  <strong>{item.label}</strong>
                  {item.detail && <small>{item.detail}</small>}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      <nav className={`mobile-farreo__tabs ${selectedPlaylist ? "" : "mobile-farreo__tabs--no-playlist"}`} aria-label="Navegacion movil">
        <button type="button" className={tab === "radio" ? "mobile-farreo__tab mobile-farreo__tab--radio mobile-farreo__tab--active" : "mobile-farreo__tab mobile-farreo__tab--radio"} onClick={() => setTab("radio")}>
          <RadioIcon size={20} />
          <span>Radio</span>
        </button>
        {selectedPlaylist && (
          <button type="button" className={tab === "playlist" ? "mobile-farreo__tab mobile-farreo__tab--playlist mobile-farreo__tab--active" : "mobile-farreo__tab mobile-farreo__tab--playlist"} onClick={() => void loadPlaylist(selectedPlaylist, false)}>
            <ListMusicIcon size={20} />
            <span>Playlist</span>
          </button>
        )}
        <button type="button" className={tab === "home" ? "mobile-farreo__home-tab mobile-farreo__home-tab--active" : "mobile-farreo__home-tab"} onClick={() => setTab("home")}>
          <HomeIcon size={25} />
          <span>Home</span>
        </button>
        <button type="button" className={tab === "search" ? "mobile-farreo__tab mobile-farreo__tab--search mobile-farreo__tab--active" : "mobile-farreo__tab mobile-farreo__tab--search"} onClick={() => setTab("search")}>
          <SearchIcon size={20} />
          <span>Buscar</span>
        </button>
        <button type="button" className={tab === "account" ? "mobile-farreo__tab mobile-farreo__tab--account mobile-farreo__tab--active" : "mobile-farreo__tab mobile-farreo__tab--account"} onClick={() => setTab("account")}>
          <UserIcon size={20} />
          <span>Cuenta</span>
        </button>
      </nav>
    </div>
  );
}
