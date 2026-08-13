"use client";
/* eslint-disable @next/next/no-img-element */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import Link from "next/link";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckIcon,
  DicesIcon,
  Disc3Icon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ImageIcon,
  Layers3Icon,
  Mic2Icon,
  Music2Icon,
  PaletteIcon,
  PauseIcon,
  PencilLineIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  Settings2Icon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SparklesIcon,
  TagsIcon,
  Trash2Icon,
  TypeIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import SongArtwork from "@/components/SongArtwork";
import AlbumDiscBackdrop from "@/components/AlbumDiscBackdrop";
import {
  LyricsDisplay,
  PlayerProgressBar,
  useMusicPlayer,
  useMusicPlayerTime,
  type MusicTrack,
} from "@/components/MusicPlayerProvider";
import { getMediaUrl } from "@/lib/radioApi";
import { computeCurrentLyric, parseSrt } from "@/lib/lyrics";
import {
  claimAdminShort,
  getAdminShortSong,
  getAdminShortsSessionId,
  getAdminShortsState,
  getAlternativeNameMap,
  heartbeatAdminShortClaim,
  isAdminShortClaimConflict,
  markAdminShortPassed,
  releaseAdminShortClaim,
  releaseAdminShortSessionClaims,
  saveAdminShortSong,
  setAdminShortsVersion,
  type AdminShortLyricsMode,
  type AdminShortSong,
} from "@/lib/adminShorts";
import {
  createSongTheme,
  listSongThemes,
  type SongTheme,
} from "@/lib/songThemes";
import styles from "@/components/AdminShorts.module.scss";

type EditorKind = "name" | "aliases" | "themes" | "lyrics" | "artwork" | "advanced" | null;

type SongDraft = {
  name: string;
  aliases: string[];
  themeIds: string[];
  iconFile: File | null;
  advancedCoverFile: File | null;
  lyricsMode: AdminShortLyricsMode;
  staticLyrics: string;
  dynamicLyricsFile: File | null;
  iconPreview: string;
  advancedPreview: string;
  advancedPreviewType: string | null;
};

type PendingNavigation = {
  targetIndex: number;
  reason: "scroll" | "player" | "button" | "keyboard";
};

const disposeDraftBlobUrls = (value: SongDraft | null) => {
  if (!value) return;
  if (value.iconPreview.startsWith("blob:")) URL.revokeObjectURL(value.iconPreview);
  if (value.advancedPreview.startsWith("blob:")) URL.revokeObjectURL(value.advancedPreview);
};

const normalizeAlias = (value: string) => value
  .trim()
  .replace(/\s+/g, " ")
  .toLowerCase();

const shuffleSongs = <T,>(values: T[]) => {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
};

const lyricsModeForSong = (song: AdminShortSong | null): AdminShortLyricsMode => {
  if (song?.lyricsSrt?.trim()) return "dynamic";
  if (song?.staticLyrics?.trim()) return "static";
  return "none";
};

const songToTrack = (song: AdminShortSong): MusicTrack => ({
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
  createdAt: song.createdAt,
});

const makeDraft = (song: AdminShortSong): SongDraft => ({
  name: song.name,
  aliases: [...(song.variantes || [])],
  themeIds: [...(song.themeIds || [])],
  iconFile: null,
  advancedCoverFile: null,
  lyricsMode: lyricsModeForSong(song),
  staticLyrics: song.staticLyrics || "",
  dynamicLyricsFile: null,
  iconPreview: song.iconUrl ? getMediaUrl(song.iconUrl) : "",
  advancedPreview: song.advancedCoverUrl ? getMediaUrl(song.advancedCoverUrl) : "",
  advancedPreviewType: song.advancedCoverType || null,
});

const draftIsDirtyForSong = (draft: SongDraft | null, song: AdminShortSong | null) => Boolean(draft && song && (
  draft.name.trim() !== song.name ||
  JSON.stringify(draft.aliases) !== JSON.stringify(song.variantes || []) ||
  JSON.stringify([...draft.themeIds].sort()) !== JSON.stringify([...(song.themeIds || [])].sort()) ||
  draft.lyricsMode !== lyricsModeForSong(song) ||
  (draft.lyricsMode === "static" && draft.staticLyrics !== (song.staticLyrics || "")) ||
  Boolean(draft.dynamicLyricsFile) ||
  Boolean(draft.iconFile) ||
  Boolean(draft.advancedCoverFile)
));




function AdminShortsLyricsBar({ song }: { song: AdminShortSong | null }) {
  const { lyricsEnabled } = useMusicPlayer();
  const { currentTime } = useMusicPlayerTime();
  const cues = useMemo(() => parseSrt(song?.lyricsSrt), [song?.lyricsSrt]);
  const lyric = useMemo(
    () => computeCurrentLyric(cues, currentTime, song?.duration || 0),
    [cues, currentTime, song?.duration],
  );
  return <LyricsDisplay lyric={lyric} visible={lyricsEnabled && cues.length > 0} />;
}

function AdminShortsPlayer({
  song,
  canGoPrev,
  canGoNext,
  onPrev,
  onNext,
}: {
  song: AdminShortSong | null;
  canGoPrev: boolean;
  canGoNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const {
    currentTrack,
    currentSource,
    isPlaying,
    playbackPitch,
    volume,
    isShuffle,
    autoRandomPitch,
    isPitchLocked,
    lyricsEnabled,
    togglePlayPause,
    handleVolumeChange,
    handlePitchChange,
    setAutoRandomPitch,
    setIsShuffle,
    setLyricsEnabled,
  } = useMusicPlayer();

  const displayTrack = song ? songToTrack(song) : currentTrack;

  return (
    <>
      <AdminShortsLyricsBar song={song} />
      <div className="playlist-admin__player" data-admin-shorts-interactive="true">
        <div className="playlist-admin__now-playing">
          {displayTrack ? (
            <div className="playlist-admin__now-playing-inner">
              <SongArtwork src={displayTrack.iconUrl} alt={displayTrack.name} className="playlist-admin__now-playing-artwork" />
              <div className="playlist-admin__now-playing-text">
                <span className="playlist-admin__now-playing-title">{displayTrack.name}</span>
                <span className="playlist-admin__now-playing-source">{currentSource?.name || "Admin Shorts"}</span>
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
              onClick={() => setIsShuffle((value) => !value)}
              title={isShuffle ? "Aleatorio activado · ignorado en Admin Shorts" : "En orden · Admin Shorts siempre avanza secuencialmente"}
            >
              {isShuffle ? <ShuffleIcon size={16} /> : <ArrowRightIcon size={16} />}
            </button>
            <button className="playlist-admin__control-btn" onClick={onPrev} disabled={!canGoPrev} title="Anterior"><SkipBackIcon size={16} /></button>
            <button className="playlist-admin__control-btn playlist-admin__control-btn--play" onClick={togglePlayPause} title={isPlaying ? "Pausar" : "Reproducir"}>
              {isPlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
            </button>
            <button className="playlist-admin__control-btn" onClick={onNext} disabled={!canGoNext} title="Siguiente"><SkipForwardIcon size={16} /></button>
            <button
              className={`playlist-admin__control-btn playlist-admin__control-btn--lyrics ${lyricsEnabled ? "playlist-admin__control-btn--active" : ""}`}
              onClick={() => setLyricsEnabled((value) => !value)}
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
              onClick={() => setAutoRandomPitch((value) => !value)}
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
              onChange={(event) => handlePitchChange(Number(event.target.value))}
              disabled={isPitchLocked}
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
              onChange={(event) => handleVolumeChange(Number(event.target.value))}
              className="playlist-admin__mini-slider"
              title={`Volumen: ${Math.round(volume * 100)}%`}
            />
          </div>
        </div>
      </div>
    </>
  );
}

export default function AdminShorts() {
  const {
    currentTrack,
    currentSource,
    isPlaying,
    loadQueue,
    togglePlayPause,
    toggleTrack,
  } = useMusicPlayer();
  const [songs, setSongs] = useState<AdminShortSong[]>([]);
  const [themes, setThemes] = useState<SongTheme[]>([]);
  const [alternativeNames, setAlternativeNames] = useState<Record<string, string>>({});
  const [versionGlobal, setVersionGlobal] = useState(1);
  const [versionDraft, setVersionDraft] = useState("1");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [draft, setDraft] = useState<SongDraft | null>(null);
  const [activeEditor, setActiveEditor] = useState<EditorKind>(null);
  const [aliasInput, setAliasInput] = useState("");
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [newThemeName, setNewThemeName] = useState("");
  const [creatingTheme, setCreatingTheme] = useState(false);
  const [passedIds, setPassedIds] = useState<Set<string>>(new Set());
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingSong, setRefreshingSong] = useState(false);
  const [downloadingAudio, setDownloadingAudio] = useState(false);
  const [dynamicFileLineCount, setDynamicFileLineCount] = useState<number | null>(null);
  const [totalEligible, setTotalEligible] = useState(0);
  const [lockedCount, setLockedCount] = useState(0);
  const [changingVersion, setChangingVersion] = useState(false);
  const [versionPanelOpen, setVersionPanelOpen] = useState(false);
  const [discPreview, setDiscPreview] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [direction, setDirection] = useState<"up" | "down">("up");
  const wheelAmountRef = useRef(0);
  const lastWheelMoveRef = useRef(0);
  const touchStartRef = useRef<number | null>(null);
  const iconInputRef = useRef<HTMLInputElement | null>(null);
  const advancedInputRef = useRef<HTMLInputElement | null>(null);
  const lyricsInputRef = useRef<HTMLInputElement | null>(null);
  const sessionIdRef = useRef(getAdminShortsSessionId());
  const claimedSongIdsRef = useRef<Set<string>>(new Set());
  const currentIndexRef = useRef(0);
  const songsRef = useRef<AdminShortSong[]>([]);
  const passedIdsRef = useRef<Set<string>>(new Set());
  const dirtyRef = useRef(false);
  const restoringPlayerRef = useRef(false);
  const versionRef = useRef(1);
  const draftRef = useRef<SongDraft | null>(null);

  const currentSong = currentIndex >= 0 && currentIndex < songs.length ? songs[currentIndex] : null;
  const finished = songs.length > 0 && currentIndex >= songs.length;
  const dirty = draftIsDirtyForSong(draft, currentSong);

  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { songsRef.current = songs; }, [songs]);
  useEffect(() => { passedIdsRef.current = passedIds; }, [passedIds]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { versionRef.current = versionGlobal; }, [versionGlobal]);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const resetDraft = useCallback((song: AdminShortSong | null) => {
    setDraft((previous) => {
      disposeDraftBlobUrls(previous);
      return song ? makeDraft(song) : null;
    });
    setAliasInput("");
    setAliasError(null);
    setNewThemeName("");
    setDynamicFileLineCount(null);
    setActiveEditor(null);
  }, []);

  useEffect(() => () => {
    disposeDraftBlobUrls(draftRef.current);
  }, []);

  const shortSource = useCallback(() => ({
    id: `admin-shorts-${versionRef.current}`,
    name: `Admin Shorts · ronda ${versionRef.current}`,
    type: "admin" as const,
  }), []);

  const shortQueueAt = useCallback((index: number, queue = songsRef.current) => (
    queue
      .slice(Math.max(0, index), Math.max(0, index) + 2)
      .map(songToTrack)
  ), []);

  const syncShortQueue = useCallback((index: number, queue = songsRef.current) => {
    const tracks = shortQueueAt(index, queue);
    if (tracks.length === 0) return;
    loadQueue(tracks, shortSource());
  }, [loadQueue, shortQueueAt, shortSource]);

  const playExactSong = useCallback((song: AdminShortSong, queue = songsRef.current) => {
    const index = queue.findIndex((item) => item.id === song.id);
    if (index < 0) return;
    const tracks = shortQueueAt(index, queue);
    const track = tracks[0];
    if (!track) return;
    toggleTrack(track, tracks, shortSource());
  }, [shortQueueAt, shortSource, toggleTrack]);

  const commitSongs = useCallback((nextSongs: AdminShortSong[]) => {
    songsRef.current = nextSongs;
    setSongs(nextSongs);
  }, []);

  const claimSongForSession = useCallback(async (song: AdminShortSong) => {
    if (passedIdsRef.current.has(song.id)) return true;
    if (claimedSongIdsRef.current.has(song.id)) return true;
    try {
      await claimAdminShort(song.id, sessionIdRef.current);
      const nextClaims = new Set(claimedSongIdsRef.current);
      nextClaims.add(song.id);
      claimedSongIdsRef.current = nextClaims;
      return true;
    } catch (error) {
      if (isAdminShortClaimConflict(error)) return false;
      throw error;
    }
  }, []);

  const releaseClaimsExcept = useCallback((keep: Set<string>) => {
    for (const songId of [...claimedSongIdsRef.current]) {
      if (keep.has(songId)) continue;
      claimedSongIdsRef.current.delete(songId);
      void releaseAdminShortClaim(songId, sessionIdRef.current).catch(() => undefined);
    }
  }, []);

  // Before a song is allowed to become visible, claim it on the Linux server.
  // We also claim one look-ahead song so the existing gapless player may
  // auto-advance without ever playing an item that another admin could receive.
  const prepareIndex = useCallback(async (
    requestedIndex: number,
    initialList = songsRef.current,
  ) => {
    let list = [...initialList];
    let index = Math.max(0, Math.min(requestedIndex, list.length));

    while (index < list.length) {
      const candidate = list[index];
      const claimed = await claimSongForSession(candidate);
      if (claimed) break;

      // It was claimed or already passed by the other admin after our session
      // list was loaded. Remove it locally before it can ever be rendered.
      list.splice(index, 1);
      setLockedCount((value) => value + 1);
    }

    if (index >= list.length) {
      releaseClaimsExcept(new Set());
      if (list !== initialList) commitSongs(list);
      return { list, index: list.length, song: null as AdminShortSong | null };
    }

    // Reserve the next pending item as well, skipping races. Historical items
    // that this session already passed do not need a lease.
    let nextIndex = index + 1;
    while (nextIndex < list.length) {
      const candidate = list[nextIndex];
      const claimed = await claimSongForSession(candidate);
      if (claimed) break;
      list.splice(nextIndex, 1);
      setLockedCount((value) => value + 1);
    }

    const keep = new Set<string>();
    const current = list[index];
    const lookahead = list[index + 1];
    if (current && claimedSongIdsRef.current.has(current.id)) keep.add(current.id);
    if (lookahead && claimedSongIdsRef.current.has(lookahead.id)) keep.add(lookahead.id);
    releaseClaimsExcept(keep);

    commitSongs(list);
    return { list, index, song: current || null };
  }, [claimSongForSession, commitSongs, releaseClaimsExcept]);

  const loadSession = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      // A reload of the same tab keeps the same session id. Drop any old
      // leases first so a stale look-ahead cannot remain reserved.
      await releaseAdminShortSessionClaims(sessionIdRef.current).catch(() => undefined);
      claimedSongIdsRef.current = new Set();

      const [state, nextThemes, nextAliases] = await Promise.all([
        getAdminShortsState(sessionIdRef.current),
        listSongThemes(),
        getAlternativeNameMap(),
      ]);
      const shuffled = shuffleSongs(state.songs);
      setThemes(nextThemes);
      setAlternativeNames(nextAliases);
      versionRef.current = state.versionGlobal;
      setVersionGlobal(state.versionGlobal);
      setVersionDraft(String(state.versionGlobal));
      setTotalEligible(state.totalEligible);
      setLockedCount(state.lockedCount);
      setPassedIds(new Set());
      passedIdsRef.current = new Set();
      setCurrentIndex(0);
      currentIndexRef.current = 0;

      const prepared = await prepareIndex(0, shuffled);
      setCurrentIndex(prepared.index);
      currentIndexRef.current = prepared.index;
      resetDraft(prepared.song);
      if (prepared.song) {
        window.setTimeout(() => playExactSong(prepared.song!, prepared.list), 0);
      }
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo abrir Admin Shorts." });
    } finally {
      setLoading(false);
    }
  }, [playExactSong, prepareIndex, resetDraft]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Keep both the current item and the one-item player look-ahead alive.
  useEffect(() => {
    const heartbeat = () => {
      for (const songId of claimedSongIdsRef.current) {
        void heartbeatAdminShortClaim(songId, sessionIdRef.current).catch((error) => {
          if (isAdminShortClaimConflict(error)) {
            setNotice({ type: "error", text: "Se perdió una reserva de Admin Shorts. La canción se comprobará al avanzar." });
          }
        });
      }
    };
    const timer = window.setInterval(heartbeat, 30_000);
    const pageHide = () => {
      void releaseAdminShortSessionClaims(sessionIdRef.current, true).catch(() => undefined);
    };
    window.addEventListener("pagehide", pageHide);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", pageHide);
    };
  }, []);

  const ensurePassed = useCallback(async (song: AdminShortSong) => {
    if (passedIdsRef.current.has(song.id)) return;
    await markAdminShortPassed(song.id, sessionIdRef.current);
    claimedSongIdsRef.current.delete(song.id);
    const next = new Set(passedIdsRef.current);
    next.add(song.id);
    passedIdsRef.current = next;
    setPassedIds(next);
  }, []);

  const moveTo = useCallback(async (
    targetIndex: number,
    options?: { skipDirty?: boolean; playerAlreadyOnTarget?: boolean; reason?: PendingNavigation["reason"] },
  ) => {
    const listBefore = songsRef.current;
    const fromIndex = currentIndexRef.current;
    if (targetIndex < 0 || targetIndex > listBefore.length || targetIndex === fromIndex) return;

    const fromSong = fromIndex >= 0 && fromIndex < listBefore.length ? listBefore[fromIndex] : null;
    if (fromSong && dirtyRef.current && !options?.skipDirty) {
      setPendingNavigation({ targetIndex, reason: options?.reason || "scroll" });
      return;
    }

    try {
      if (fromSong) await ensurePassed(fromSong);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo marcar la canción como revisada." });
      if (options?.playerAlreadyOnTarget && fromSong) {
        restoringPlayerRef.current = true;
        playExactSong(fromSong, listBefore);
      }
      return;
    }

    try {
      const prepared = await prepareIndex(targetIndex, songsRef.current);
      setDirection(prepared.index > fromIndex ? "up" : "down");
      setCurrentIndex(prepared.index);
      currentIndexRef.current = prepared.index;
      resetDraft(prepared.song);

      if (prepared.song && !options?.playerAlreadyOnTarget) {
        playExactSong(prepared.song, prepared.list);
      } else if (prepared.song && options?.playerAlreadyOnTarget) {
        syncShortQueue(prepared.index, prepared.list);
      }
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo reservar la siguiente canción." });
    }
  }, [ensurePassed, playExactSong, prepareIndex, resetDraft, syncShortQueue]);

  useEffect(() => {
    if (restoringPlayerRef.current) {
      const expected = songsRef.current[currentIndexRef.current];
      if (expected?.id === currentTrack?.id) restoringPlayerRef.current = false;
      return;
    }
    if (!currentTrack || currentSource?.type !== "admin" || !currentSource.id.startsWith("admin-shorts-")) return;
    const targetIndex = songsRef.current.findIndex((song) => song.id === currentTrack.id);
    if (targetIndex < 0 || targetIndex === currentIndexRef.current) return;

    const fromSong = songsRef.current[currentIndexRef.current];
    if (fromSong && dirtyRef.current) {
      setPendingNavigation({ targetIndex, reason: "player" });
      restoringPlayerRef.current = true;
      playExactSong(fromSong, songsRef.current);
      return;
    }

    void moveTo(targetIndex, { playerAlreadyOnTarget: true, reason: "player" });
  }, [currentSource, currentTrack?.id, moveTo, playExactSong]);

  const publishSongMetadata = useCallback((song: AdminShortSong) => {
    window.dispatchEvent(new CustomEvent<MusicTrack>("farreo:song-metadata-updated", {
      detail: songToTrack(song),
    }));
  }, []);

  const integrateFreshSong = useCallback((updated: AdminShortSong) => {
    const nextSongs = songsRef.current.map((item) => item.id === updated.id ? updated : item);
    commitSongs(nextSongs);
    if (songsRef.current[currentIndexRef.current]?.id === updated.id) {
      resetDraft(updated);
      syncShortQueue(currentIndexRef.current, nextSongs);
    }
    publishSongMetadata(updated);
  }, [commitSongs, publishSongMetadata, resetDraft, syncShortQueue]);

  const saveCurrent = useCallback(async () => {
    const index = currentIndexRef.current;
    const song = songsRef.current[index];
    if (!song || !draft) return null;
    const name = draft.name.trim();
    if (!name) {
      setNotice({ type: "error", text: "La canción necesita un nombre." });
      return null;
    }

    const originalLyricsMode = lyricsModeForSong(song);
    const lyricsChanged = (
      draft.lyricsMode !== originalLyricsMode
      || (draft.lyricsMode === "static" && draft.staticLyrics !== (song.staticLyrics || ""))
      || Boolean(draft.dynamicLyricsFile)
    );

    if (
      lyricsChanged
      && draft.lyricsMode === "dynamic"
      && !draft.dynamicLyricsFile
      && !song.lyricsSrt?.trim()
    ) {
      setNotice({
        type: "error",
        text: "Para aplicar lyrics dinámicas, sube un SRT/VTT o créalas primero en el editor.",
      });
      return null;
    }

    setSaving(true);
    try {
      const updated = await saveAdminShortSong(song.id, {
        nombre: name,
        variantes: draft.aliases,
        themeIds: draft.themeIds,
        iconFile: draft.iconFile,
        advancedCoverFile: draft.advancedCoverFile,
        lyrics: {
          changed: lyricsChanged,
          mode: draft.lyricsMode,
          staticLyrics: draft.staticLyrics,
          dynamicFile: draft.dynamicLyricsFile,
        },
      });

      integrateFreshSong(updated);
      setAlternativeNames(await getAlternativeNameMap().catch(() => alternativeNames));
      setNotice({ type: "success", text: "Cambios aplicados ✨" });
      return updated;
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudieron guardar los cambios." });
      return null;
    } finally {
      setSaving(false);
    }
  }, [alternativeNames, draft, integrateFreshSong]);

  const applyAndContinue = async () => {
    if (!pendingNavigation) return;
    const target = pendingNavigation.targetIndex;
    const saved = await saveCurrent();
    if (!saved) return;
    setPendingNavigation(null);
    dirtyRef.current = false;
    await moveTo(target, { skipDirty: true, reason: pendingNavigation.reason });
  };

  const discardAndContinue = async () => {
    if (!pendingNavigation) return;
    const target = pendingNavigation.targetIndex;
    const current = songsRef.current[currentIndexRef.current] || null;
    resetDraft(current);
    dirtyRef.current = false;
    setPendingNavigation(null);
    await moveTo(target, { skipDirty: true, reason: pendingNavigation.reason });
  };

  const requestRelativeMove = (delta: number, reason: PendingNavigation["reason"]) => {
    const index = currentIndexRef.current;
    if (songsRef.current.length === 0) return;
    const target = Math.max(0, Math.min(songsRef.current.length, index + delta));
    if (target === index) return;
    void moveTo(target, { reason });
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-admin-shorts-interactive='true']")) return;
    event.preventDefault();
    const now = Date.now();
    if (now - lastWheelMoveRef.current < 520) return;
    wheelAmountRef.current += event.deltaY;
    if (Math.abs(wheelAmountRef.current) < 70) return;
    const delta = wheelAmountRef.current > 0 ? 1 : -1;
    wheelAmountRef.current = 0;
    lastWheelMoveRef.current = now;
    requestRelativeMove(delta, "scroll");
  };

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        requestRelativeMove(1, "keyboard");
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        requestRelativeMove(-1, "keyboard");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onTouchStart = (event: ReactTouchEvent) => {
    touchStartRef.current = event.touches[0]?.clientY ?? null;
  };

  const onTouchEnd = (event: ReactTouchEvent) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (start === null) return;
    const end = event.changedTouches[0]?.clientY ?? start;
    const delta = start - end;
    if (Math.abs(delta) < 55) return;
    requestRelativeMove(delta > 0 ? 1 : -1, "scroll");
  };

  const addAlias = () => {
    if (!draft || !currentSong) return;
    const value = aliasInput.trim().replace(/\s+/g, " ");
    if (!value) return;
    const normalized = normalizeAlias(value);
    if (draft.aliases.some((alias) => normalizeAlias(alias) === normalized)) {
      setAliasError("Ese nombre alternativo ya está puesto.");
      return;
    }
    const owner = alternativeNames[normalized];
    if (owner && owner !== currentSong.name && owner !== draft.name.trim()) {
      setAliasError(`Ya se usa en “${owner}”.`);
      return;
    }
    setDraft({ ...draft, aliases: [...draft.aliases, value] });
    setAliasInput("");
    setAliasError(null);
  };

  const toggleTheme = (themeId: string) => {
    if (!draft) return;
    const selected = draft.themeIds.includes(themeId);
    setDraft({
      ...draft,
      themeIds: selected ? draft.themeIds.filter((id) => id !== themeId) : [...draft.themeIds, themeId],
    });
  };

  const createThemeInline = async () => {
    const name = newThemeName.trim();
    if (!name || !draft) return;
    setCreatingTheme(true);
    try {
      const result = await createSongTheme(name);
      setThemes((current) => {
        const next = current.some((theme) => theme.id === result.theme.id)
          ? current
          : [...current, result.theme];
        return next.sort((left, right) => left.name.localeCompare(right.name, "es", { sensitivity: "base" }));
      });
      if (!draft.themeIds.includes(result.theme.id)) {
        setDraft({ ...draft, themeIds: [...draft.themeIds, result.theme.id] });
      }
      setNewThemeName("");
      setNotice({ type: "success", text: result.created ? "Tema creado y marcado ⚡" : "Tema existente marcado." });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo crear el tema." });
    } finally {
      setCreatingTheme(false);
    }
  };

  const chooseIcon = (file: File | null) => {
    if (!file || !draft) return;
    if (!file.type.startsWith("image/")) {
      setNotice({ type: "error", text: "La portada debe ser una imagen." });
      return;
    }
    const preview = URL.createObjectURL(file);
    if (draft.iconPreview.startsWith("blob:")) URL.revokeObjectURL(draft.iconPreview);
    setDraft({ ...draft, iconFile: file, iconPreview: preview });
  };

  const chooseAdvancedCover = (file: File | null) => {
    if (!file || !draft) return;
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      setNotice({ type: "error", text: "La portada avanzada debe ser imagen o vídeo." });
      return;
    }
    const preview = URL.createObjectURL(file);
    if (draft.advancedPreview.startsWith("blob:")) URL.revokeObjectURL(draft.advancedPreview);
    setDraft({
      ...draft,
      advancedCoverFile: file,
      advancedPreview: preview,
      advancedPreviewType: file.type,
    });
  };

  const chooseDynamicLyricsFile = async (file: File | null) => {
    if (!file || !draft) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".srt") && !lower.endsWith(".vtt")) {
      setNotice({ type: "error", text: "Las lyrics dinámicas deben ser un .srt o .vtt." });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setNotice({ type: "error", text: "El archivo de lyrics no puede superar 2 MB." });
      return;
    }
    const text = await file.text().catch(() => "");
    const lineCount = parseSrt(text).length;
    setDynamicFileLineCount(lineCount);
    setDraft({
      ...draft,
      lyricsMode: "dynamic",
      dynamicLyricsFile: file,
    });
  };

  const refreshCurrentSong = async () => {
    const song = songsRef.current[currentIndexRef.current];
    if (!song) return;

    setRefreshingSong(true);
    try {
      const fresh = await getAdminShortSong(song.id);
      // Typical editor workflow: switching "Dinámicas" locally makes the
      // draft dirty, then the other tab saves exactly that state. Compare the
      // draft against the FRESH server song before warning, so Reload stays a
      // one-click action when there is no real local conflict.
      if (draftIsDirtyForSong(draftRef.current, fresh)
        && !window.confirm("Recargar descartará los cambios locales sin aplicar. ¿Continuar?")) {
        return;
      }
      integrateFreshSong(fresh);
      setActiveEditor("lyrics");
      setNotice({ type: "success", text: "Canción recargada desde el servidor ↻" });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo recargar la canción." });
    } finally {
      setRefreshingSong(false);
    }
  };

  const downloadCurrentSong = async () => {
    const song = songsRef.current[currentIndexRef.current];
    if (!song?.url) return;
    setDownloadingAudio(true);
    try {
      const response = await fetch(getMediaUrl(song.url));
      if (!response.ok) throw new Error("No se pudo descargar el audio.");
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const extension = song.id.match(/\.[a-z0-9]{2,5}$/i)?.[0] || ".mp3";
      const safeName = (draft?.name || song.name || "cancion").replace(/[\\/:*?"<>|]+/g, "_").trim() || "cancion";
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${safeName}${extension}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo descargar el MP3." });
    } finally {
      setDownloadingAudio(false);
    }
  };

  const openLyricsEditor = async () => {
    const song = songsRef.current[currentIndexRef.current];
    if (!song || !draft) return;

    // Open immediately so browsers do not treat the new tab as a popup after
    // an awaited save.
    const editorTab = window.open("about:blank", "_blank");
    if (!editorTab) {
      setNotice({ type: "error", text: "El navegador bloqueó la pestaña del editor de lyrics." });
      return;
    }

    let targetSong: AdminShortSong | null = song;
    if (draft.dynamicLyricsFile) {
      targetSong = await saveCurrent();
      if (!targetSong) {
        editorTab.close();
        return;
      }
    }

    if (currentTrack?.id === song.id && isPlaying) {
      togglePlayPause();
    }
    editorTab.location.href = `/admin/lyrics?song=${encodeURIComponent(targetSong.id)}&session=${encodeURIComponent(sessionIdRef.current)}`;
  };

  const changeVersion = async () => {
    if (dirty) {
      setNotice({ type: "error", text: "Aplica o descarta los cambios de esta canción antes de cambiar de ronda." });
      return;
    }
    const parsed = Number(versionDraft);
    if (!Number.isInteger(parsed) || parsed < 1) {
      setNotice({ type: "error", text: "La ronda debe ser un entero mayor o igual que 1." });
      return;
    }
    setChangingVersion(true);
    try {
      const result = await setAdminShortsVersion(parsed, sessionIdRef.current);
      setVersionGlobal(result.versionGlobal);
      setVersionDraft(String(result.versionGlobal));
      setVersionPanelOpen(false);
      await loadSession();
      setNotice({ type: "success", text: `Ronda global cambiada a ${result.versionGlobal}.` });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo cambiar la ronda." });
    } finally {
      setChangingVersion(false);
    }
  };

  const themeNames = useMemo(() => new Map(themes.map((theme) => [theme.id, theme.name])), [themes]);
  const selectedThemeNames = currentSong
    ? (draft?.themeIds || []).map((id) => themeNames.get(id)).filter((value): value is string => Boolean(value))
    : [];
  const currentDynamicLineCount = useMemo(
    () => parseSrt(currentSong?.lyricsSrt).length,
    [currentSong?.lyricsSrt],
  );
  const hasDynamicLyrics = draft?.lyricsMode === "dynamic";
  const hasStaticLyrics = draft?.lyricsMode === "static";
  const progress = songs.length > 0 ? Math.min(100, (passedIds.size / songs.length) * 100) : 100;

  const renderAdvancedBackground = () => {
    if (!draft?.advancedPreview) return null;
    const video = draft.advancedPreviewType?.startsWith("video/") || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(draft.advancedPreview);
    return video
      ? <video className={styles.advancedMedia} src={draft.advancedPreview} autoPlay muted loop playsInline />
      : <img className={styles.advancedMedia} src={draft.advancedPreview} alt="" />;
  };

  const propertyButtons: Array<{ kind: Exclude<EditorKind, null>; label: string; icon: ReactNode; badge?: string }> = [
    { kind: "name", label: "Nombre", icon: <TypeIcon size={20} /> },
    { kind: "aliases", label: "Alternativos", icon: <TagsIcon size={20} />, badge: String(draft?.aliases.length || 0) },
    { kind: "themes", label: "Temas", icon: <PaletteIcon size={20} />, badge: String(draft?.themeIds.length || 0) },
    { kind: "lyrics", label: "Lyrics", icon: <Mic2Icon size={20} />, badge: draft?.lyricsMode === "dynamic" ? "D" : draft?.lyricsMode === "static" ? "E" : "—" },
    { kind: "artwork", label: "Portada", icon: <ImageIcon size={20} /> },
    { kind: "advanced", label: "Avanzada", icon: <Layers3Icon size={20} /> },
  ];

  return (
    <div
      className={styles.root}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className={styles.ambient} aria-hidden="true" />
      <header className={styles.topbar} data-admin-shorts-interactive="true">
        <div className={styles.topbarLeft}>
          <Link href="/admin" className={styles.backLink} onClick={() => void releaseAdminShortSessionClaims(sessionIdRef.current).catch(() => undefined)}><ArrowLeftIcon size={17} /> Admin</Link>
          <div className={styles.brandBlock}>
            <span className={styles.brandIcon}><ZapIcon size={18} fill="currentColor" /></span>
            <div>
              <strong>Admin Shorts</strong>
              <small>review mode</small>
            </div>
          </div>
        </div>

        <div className={styles.progressBlock}>
          <div className={styles.progressMeta}>
            <span>{passedIds.size} revisadas</span>
            <span>{songs.length} en esta sesión{lockedCount > 0 ? ` · ${lockedCount} ocupadas` : ""}</span>
          </div>
          <div className={styles.progressTrack}><span style={{ width: `${progress}%` }} /></div>
        </div>

        <div className={styles.roundWrap}>
          <button className={styles.roundButton} onClick={() => setVersionPanelOpen((value) => !value)}>
            <SparklesIcon size={16} /> Ronda {versionGlobal} <Settings2Icon size={15} />
          </button>
          {versionPanelOpen && (
            <div className={styles.roundPanel}>
              <span>Versión global</span>
              <div className={styles.roundInputRow}>
                <button onClick={() => setVersionDraft(String(Math.max(1, Number(versionDraft || 1) - 1)))}>-</button>
                <input value={versionDraft} inputMode="numeric" onChange={(event) => setVersionDraft(event.target.value.replace(/\D/g, ""))} />
                <button onClick={() => setVersionDraft(String(Math.max(1, Number(versionDraft || 1) + 1)))}>+</button>
              </div>
              <button className={styles.roundApply} onClick={() => void changeVersion()} disabled={changingVersion}>
                {changingVersion ? <RefreshCwIcon size={15} className={styles.spin} /> : <CheckIcon size={15} />}
                Aplicar ronda
              </button>
            </div>
          )}
        </div>
      </header>

      {notice && <div className={`${styles.toast} ${notice.type === "error" ? styles.toastError : ""}`}>{notice.text}</div>}

      <main className={styles.viewport}>
        {loading ? (
          <div className={styles.loadingCard}>
            <span className={styles.pulseDisc}><Disc3Icon size={40} /></span>
            <strong>Preparando la ronda...</strong>
            <small>Barajando canciones y cargando temas</small>
          </div>
        ) : songs.length === 0 && totalEligible > 0 ? (
          <div className={styles.finishedCard}>
            <span><RefreshCwIcon size={44} /></span>
            <h1>Ahora mismo están ocupadas</h1>
            <p>{lockedCount || totalEligible} canciones pendientes están reservadas por otro administrador. Cuando quede alguna libre, podrás cogerla sin duplicar trabajo.</p>
            <button onClick={() => void loadSession()}><RefreshCwIcon size={17} /> Buscar canciones libres</button>
          </div>
        ) : songs.length === 0 ? (
          <div className={styles.finishedCard}>
            <span><SparklesIcon size={44} /></span>
            <h1>Nada pendiente</h1>
            <p>Todas las canciones están pasadas para la ronda {versionGlobal}.</p>
            <button onClick={() => setVersionPanelOpen(true)}><Settings2Icon size={17} /> Cambiar ronda</button>
          </div>
        ) : finished ? (
          <div className={`${styles.finishedCard} ${styles.cardEnterUp}`}>
            <span><SparklesIcon size={44} /></span>
            <h1>Ronda limpia</h1>
            <p>Has llegado al final de esta sesión. Puedes volver hacia arriba sin perder el historial.</p>
            <div className={styles.finishedActions}>
              <button onClick={() => requestRelativeMove(-1, "button")}><ArrowUpIcon size={18} /> Volver a la última</button>
              <Link href="/admin" onClick={() => void releaseAdminShortSessionClaims(sessionIdRef.current).catch(() => undefined)}>Salir al Admin</Link>
            </div>
          </div>
        ) : currentSong && draft ? (
          <section key={currentSong.id} className={`${styles.shortShell} ${direction === "up" ? styles.cardEnterUp : styles.cardEnterDown}`}>
            <div className={`${styles.stage} ${discPreview ? styles.stageDiscMode : ""}`}>
              <div className={styles.backdrop} aria-hidden="true">
                {!discPreview && (draft.advancedPreview ? renderAdvancedBackground() : draft.iconPreview ? <img className={styles.fallbackBackdrop} src={draft.iconPreview} alt="" /> : null)}
                <span className={styles.backdropShade} />
              </div>

              {discPreview && (
                <div className={styles.discPreview} aria-hidden="true">
                  <AlbumDiscBackdrop
                    artworkUrl={draft.iconPreview || currentSong.iconUrl}
                    isPlaying={Boolean(currentTrack?.id === currentSong.id && isPlaying)}
                    mobile
                    visible
                  />
                </div>
              )}

              <div className={styles.stageTop}>
                <div className={styles.positionPill}>{currentIndex + 1}<span>/</span>{songs.length}</div>
                <label className={`${styles.discToggle} ${discPreview ? styles.discToggleActive : ""}`} data-admin-shorts-interactive="true">
                  <input
                    type="checkbox"
                    checked={discPreview}
                    onChange={(event) => setDiscPreview(event.target.checked)}
                  />
                  <span className={styles.discToggleBox}>{discPreview && <CheckIcon size={12} />}</span>
                  <Disc3Icon size={15} />
                  <span>Modo disco</span>
                </label>
                <div className={styles.reviewState}>
                  {passedIds.has(currentSong.id) ? <><CheckIcon size={14} /> revisada en sesión</> : <><SparklesIcon size={14} /> pendiente</>}
                </div>
              </div>

              {!discPreview && (
                <div className={`${styles.coverZone} ${draft.advancedPreview ? styles.coverZoneHasAdvanced : ""}`}>
                  {draft.iconPreview ? (
                    <img className={styles.heroIcon} src={draft.iconPreview} alt={draft.name || currentSong.name} />
                  ) : (
                    <div className={styles.heroFallback}><Music2Icon size={82} /></div>
                  )}
                  {draft.advancedPreview && <span className={styles.revealHint}>hover para revelar avanzada</span>}
                </div>
              )}

              <div className={styles.songIdentity}>
                <div className={styles.identityTitleRow}>
                  <h1>{draft.name || "Sin nombre"}</h1>
                  {dirty && <span className={styles.unsavedDot}>sin aplicar</span>}
                </div>
                <div className={styles.identityMeta}>
                  <span className={hasDynamicLyrics ? styles.goodMeta : hasStaticLyrics ? styles.staticMeta : styles.badMeta}>
                    <Mic2Icon size={14} /> {hasDynamicLyrics ? "Lyrics dinámicas" : hasStaticLyrics ? "Lyrics estáticas" : "Sin lyrics"}
                  </span>
                  <span><TagsIcon size={14} /> {draft.aliases.length} alternativos</span>
                  <span><PaletteIcon size={14} /> {draft.themeIds.length} temas</span>
                </div>
                {selectedThemeNames.length > 0 && (
                  <div className={styles.themeTicker}>
                    {selectedThemeNames.slice(0, 6).map((name) => <span key={name}>{name}</span>)}
                    {selectedThemeNames.length > 6 && <span>+{selectedThemeNames.length - 6}</span>}
                  </div>
                )}
              </div>

              <div className={styles.propertyRail} data-admin-shorts-interactive="true">
                {propertyButtons.map((item) => (
                  <button
                    key={item.kind}
                    className={activeEditor === item.kind ? styles.propertyActive : ""}
                    onClick={() => setActiveEditor((current) => current === item.kind ? null : item.kind)}
                    title={item.label}
                  >
                    <span>{item.icon}</span>
                    <small>{item.label}</small>
                    {item.badge && <i>{item.badge}</i>}
                  </button>
                ))}
              </div>

              {activeEditor && (
                <div className={styles.editorPanel} data-admin-shorts-interactive="true">
                  <div className={styles.editorHeader}>
                    <strong>{activeEditor === "name" ? "Dale identidad" : activeEditor === "aliases" ? "Cómo la llamáis" : activeEditor === "themes" ? "Qué vibra tiene" : activeEditor === "lyrics" ? "Cómo canta" : activeEditor === "artwork" ? "Portada principal" : "Portada avanzada"}</strong>
                    <button onClick={() => setActiveEditor(null)}><XIcon size={17} /></button>
                  </div>

                  {activeEditor === "name" && (
                    <div className={styles.nameEditor}>
                      <TypeIcon size={25} />
                      <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoFocus />
                      <small>Este nombre también se actualiza en las playlists globales.</small>
                    </div>
                  )}

                  {activeEditor === "aliases" && (
                    <div className={styles.aliasEditor}>
                      <div className={styles.chipCloud}>
                        {draft.aliases.map((alias, index) => (
                          <button key={`${alias}-${index}`} className={styles.aliasChip} onClick={() => setDraft({ ...draft, aliases: draft.aliases.filter((_, itemIndex) => itemIndex !== index) })}>
                            {alias}<XIcon size={13} />
                          </button>
                        ))}
                        {draft.aliases.length === 0 && <span className={styles.emptyHint}>Todavía no tiene nombres alternativos.</span>}
                      </div>
                      <div className={styles.inlineComposer}>
                        <PlusIcon size={17} />
                        <input
                          value={aliasInput}
                          onChange={(event) => { setAliasInput(event.target.value); setAliasError(null); }}
                          onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => { if (event.key === "Enter") { event.preventDefault(); addAlias(); } }}
                          placeholder="Añadir nombre alternativo"
                        />
                        <button onClick={addAlias}>Añadir</button>
                      </div>
                      {aliasError && <small className={styles.inlineError}>{aliasError}</small>}
                    </div>
                  )}

                  {activeEditor === "themes" && (
                    <div className={styles.themeEditor}>
                      <div className={styles.themeCloud}>
                        {themes.map((theme) => {
                          const selected = draft.themeIds.includes(theme.id);
                          return (
                            <button key={theme.id} className={selected ? styles.themeSelected : ""} onClick={() => toggleTheme(theme.id)}>
                              {selected && <CheckIcon size={13} />}{theme.name}
                            </button>
                          );
                        })}
                      </div>
                      <div className={styles.inlineComposer}>
                        <SparklesIcon size={17} />
                        <input
                          value={newThemeName}
                          onChange={(event) => setNewThemeName(event.target.value)}
                          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createThemeInline(); } }}
                          placeholder="Crear tema nuevo"
                        />
                        <button onClick={() => void createThemeInline()} disabled={creatingTheme}>{creatingTheme ? "..." : "Crear"}</button>
                      </div>
                    </div>
                  )}


                  {activeEditor === "lyrics" && (
                    <div className={styles.lyricsEditor}>
                      <div className={styles.lyricsModes}>
                        <button
                          className={draft.lyricsMode === "none" ? styles.lyricsModeActive : ""}
                          onClick={() => setDraft({ ...draft, lyricsMode: "none", dynamicLyricsFile: null })}
                        >
                          <XIcon size={16} />
                          <span><strong>Sin lyrics</strong><small>Solo música</small></span>
                        </button>
                        <button
                          className={draft.lyricsMode === "static" ? styles.lyricsModeActive : ""}
                          onClick={() => setDraft({ ...draft, lyricsMode: "static", dynamicLyricsFile: null })}
                        >
                          <FileTextIcon size={16} />
                          <span><strong>Estáticas</strong><small>Texto libre</small></span>
                        </button>
                        <button
                          className={draft.lyricsMode === "dynamic" ? styles.lyricsModeActive : ""}
                          onClick={() => setDraft({ ...draft, lyricsMode: "dynamic" })}
                        >
                          <Mic2Icon size={16} />
                          <span><strong>Dinámicas</strong><small>Sincronizadas</small></span>
                        </button>
                      </div>

                      {draft.lyricsMode === "none" && (
                        <div className={styles.lyricsEmptyState}>
                          <Music2Icon size={28} />
                          <div>
                            <strong>Esta canción quedará sin lyrics</strong>
                            <small>Al aplicar se eliminarán tanto las dinámicas como las estáticas.</small>
                          </div>
                        </div>
                      )}

                      {draft.lyricsMode === "static" && (
                        <div className={styles.staticLyricsEditor}>
                          <div className={styles.lyricsEditorMeta}>
                            <span><FileTextIcon size={15} /> {draft.staticLyrics.split(/\r?\n/).filter((line) => line.trim()).length} líneas</span>
                            <button onClick={() => void refreshCurrentSong()} disabled={refreshingSong} title="Recargar toda la canción desde el servidor">
                              <RefreshCwIcon size={15} className={refreshingSong ? styles.spin : ""} /> Recargar
                            </button>
                          </div>
                          <textarea
                            value={draft.staticLyrics}
                            onChange={(event) => setDraft({ ...draft, staticLyrics: event.target.value, lyricsMode: "static" })}
                            placeholder={"Escribe las lyrics tal como quieres que aparezcan...\nUna línea por verso, si quieres."}
                          />
                        </div>
                      )}

                      {draft.lyricsMode === "dynamic" && (
                        <div className={styles.dynamicLyricsEditor}>
                          <div className={styles.dynamicLyricsStatus}>
                            <span className={styles.dynamicLyricsPulse}><Mic2Icon size={19} /></span>
                            <div>
                              <strong>
                                {draft.dynamicLyricsFile
                                  ? draft.dynamicLyricsFile.name
                                  : currentSong.lyricsSrt
                                    ? "Lyrics dinámicas listas"
                                    : "Prepara las lyrics dinámicas"}
                              </strong>
                              <small>
                                {draft.dynamicLyricsFile
                                  ? `${dynamicFileLineCount ?? 0} líneas detectadas en el archivo`
                                  : currentSong.lyricsSrt
                                    ? `${currentDynamicLineCount} líneas sincronizadas`
                                    : "Sube un SRT/VTT o abre el editor para crearlas desde cero."}
                              </small>
                            </div>
                          </div>

                          <div className={styles.lyricsToolRow}>
                            <button className={styles.lyricsUploadButton} onClick={() => lyricsInputRef.current?.click()}>
                              <PlusIcon size={16} /> {draft.dynamicLyricsFile ? "Cambiar SRT/VTT" : "Subir SRT/VTT"}
                            </button>
                            <button onClick={() => void downloadCurrentSong()} disabled={downloadingAudio} title="Descargar el audio para preparar las lyrics">
                              <DownloadIcon size={16} /> {downloadingAudio ? "Descargando..." : "MP3"}
                            </button>
                            <button className={styles.lyricsEditorButton} onClick={() => void openLyricsEditor()}>
                              <ExternalLinkIcon size={16} /> Editor
                            </button>
                            <button onClick={() => void refreshCurrentSong()} disabled={refreshingSong} title="Recargar portada, nombre, etiquetas y lyrics desde el servidor">
                              <RefreshCwIcon size={16} className={refreshingSong ? styles.spin : ""} /> Recargar
                            </button>
                          </div>
                          <input
                            ref={lyricsInputRef}
                            type="file"
                            accept=".srt,.vtt,text/vtt,application/x-subrip"
                            hidden
                            onChange={(event) => void chooseDynamicLyricsFile(event.target.files?.[0] || null)}
                          />
                          <small className={styles.lyricsFootnote}>
                            El editor se abre en otra pestaña y pausa esta canción. Cuando guardes allí, vuelve aquí y pulsa Recargar.
                          </small>
                        </div>
                      )}
                    </div>
                  )}

                  {activeEditor === "artwork" && (
                    <div className={styles.mediaEditor}>
                      <div className={styles.mediaPreview}>{draft.iconPreview ? <img src={draft.iconPreview} alt="" /> : <ImageIcon size={42} />}</div>
                      <div>
                        <strong>{draft.iconFile ? draft.iconFile.name : "Portada actual"}</strong>
                        <small>Se guarda con el mismo pipeline optimizado del editor normal.</small>
                        <button onClick={() => iconInputRef.current?.click()}><ImageIcon size={16} /> Elegir imagen</button>
                      </div>
                      <input ref={iconInputRef} type="file" accept="image/*" hidden onChange={(event) => chooseIcon(event.target.files?.[0] || null)} />
                    </div>
                  )}

                  {activeEditor === "advanced" && (
                    <div className={styles.mediaEditor}>
                      <div className={`${styles.mediaPreview} ${styles.mediaPreviewVertical}`}>
                        {draft.advancedPreview ? (
                          draft.advancedPreviewType?.startsWith("video/") || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(draft.advancedPreview)
                            ? <video src={draft.advancedPreview} muted autoPlay loop playsInline />
                            : <img src={draft.advancedPreview} alt="" />
                        ) : <Layers3Icon size={42} />}
                      </div>
                      <div>
                        <strong>{draft.advancedCoverFile ? draft.advancedCoverFile.name : draft.advancedPreview ? "Avanzada actual" : "Sin avanzada"}</strong>
                        <small>Imagen, GIF o vídeo vertical. Al pasar el ratón por la portada puedes verla detrás.</small>
                        <button onClick={() => advancedInputRef.current?.click()}><Layers3Icon size={16} /> Elegir archivo</button>
                      </div>
                      <input ref={advancedInputRef} type="file" accept="image/*,video/*" hidden onChange={(event) => chooseAdvancedCover(event.target.files?.[0] || null)} />
                    </div>
                  )}
                </div>
              )}

              <div className={styles.quickActions} data-admin-shorts-interactive="true">
                {dirty ? (
                  <>
                    <button className={styles.discardButton} onClick={() => resetDraft(currentSong)}><RotateCcwIcon size={16} /> Descartar</button>
                    <button className={styles.saveButton} onClick={() => void saveCurrent()} disabled={saving}>
                      {saving ? <RefreshCwIcon size={16} className={styles.spin} /> : <SaveIcon size={16} />}
                      {saving ? "Aplicando..." : "Aplicar"}
                    </button>
                  </>
                ) : (
                  <span className={styles.scrollHint}><ArrowDownIcon size={15} /> scroll para pasar</span>
                )}
              </div>
            </div>

            <div className={styles.navButtons} data-admin-shorts-interactive="true">
              <button onClick={() => requestRelativeMove(-1, "button")} disabled={currentIndex <= 0}><ArrowUpIcon size={20} /></button>
              <button onClick={() => requestRelativeMove(1, "button")}><ArrowDownIcon size={20} /></button>
            </div>
          </section>
        ) : null}
      </main>

      <AdminShortsPlayer
        song={currentSong}
        canGoPrev={currentIndex > 0}
        canGoNext={songs.length > 0 && currentIndex < songs.length}
        onPrev={() => requestRelativeMove(-1, "player")}
        onNext={() => requestRelativeMove(1, "player")}
      />

      {pendingNavigation && (
        <div className={styles.unsavedOverlay} data-admin-shorts-interactive="true">
          <div className={styles.unsavedModal}>
            <span className={styles.unsavedIcon}><PencilLineIcon size={26} /></span>
            <small>EY</small>
            <h2>Cambios sin aplicar</h2>
            <p>Has tocado esta canción. Decide qué hacer antes de seguir deslizando.</p>
            <div className={styles.unsavedActions}>
              <button className={styles.unsavedDiscard} onClick={() => void discardAndContinue()} disabled={saving}><Trash2Icon size={17} /> Descartar y seguir</button>
              <button className={styles.unsavedApply} onClick={() => void applyAndContinue()} disabled={saving}>
                {saving ? <RefreshCwIcon size={17} className={styles.spin} /> : <SaveIcon size={17} />}
                Aplicar y seguir
              </button>
            </div>
            <button className={styles.unsavedCancel} onClick={() => setPendingNavigation(null)}>Me quedo aquí</button>
          </div>
        </div>
      )}
    </div>
  );
}
