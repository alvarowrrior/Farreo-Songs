"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  ChevronsUpIcon,
  DicesIcon,
  EyeOffIcon,
  GripVerticalIcon,
  ListPlusIcon,
  PauseIcon,
  PlayIcon,
  RadioIcon,
  SearchIcon,
  ShuffleIcon,
  SkipForwardIcon,
  TrashIcon,
} from "lucide-react";
import { useMusicPlayer, useMusicPlayerTime } from "@/components/MusicPlayerProvider";
import { auth } from "@/lib/firebase";
import { getPrivatePlaylist, listOwnPrivatePlaylists, type PrivatePlaylist } from "@/lib/privatePlaylists";
import { useHiddenSongs } from "@/lib/useHiddenSongs";
import YouTubeSongImport from "@/components/YouTubeSongImport";
import SongArtwork from "@/components/SongArtwork";
import {
  getLiveRadioPosition,
  radioDelete,
  radioGet,
  radioPatch,
  radioPost,
  type ApiPlaylistInfo,
  type ApiSong,
  type RadioInsertAt,
  type RadioQueueItem,
  type RadioState,
} from "@/lib/radioApi";
import { addAlbumToRadio, getAlbum, listAlbums } from "@/lib/albums";
import styles from "./RadioPageAdminControls.module.scss";
import queueStyles from "./RadioQueueEditorial.module.scss";

const RADIO_ADMIN_HIDDEN_KEY = "farreo-radio-admin-show-hidden-v1";

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
};

type InsertChoice = "last" | "next" | "now";
type PlaylistChoice =
  | { kind: "private"; id: string; name: string; count: number; iconUrl?: string | null }
  | { kind: "global"; id: string; name: string; count: number; iconUrl?: string | null }
  | { kind: "album"; id: string; name: string; count: number; entryIds: string[]; iconUrl?: string | null }
  | { kind: "external"; id: string; name: string; count: number; url: string; iconUrl?: string | null };
type SelectedRadioItem =
  | { type: "song"; song: ApiSong }
  | { type: "playlist"; playlist: PlaylistChoice };

type RadioQueueDrag = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  offsetY: number;
  left: number;
  width: number;
  height: number;
  targetIndex: number;
  active: boolean;
  playNow: boolean;
};

function RadioProgress() {
  const { duration, playerMode, radioState } = useMusicPlayer();
  const { currentTime } = useMusicPlayerTime();
  const currentItem = radioState?.currentItem ?? null;
  const livePosition = playerMode === "radio" ? currentTime : getLiveRadioPosition(radioState);
  const liveDuration = playerMode === "radio"
    ? duration || currentItem?.song.duration || 0
    : currentItem?.song.duration || 0;
  const progress = liveDuration > 0 ? Math.min(100, Math.max(0, (livePosition / liveDuration) * 100)) : 0;

  return (
    <div className="radio-page__progress">
      <span>{formatTime(livePosition)}</span>
      <div className="radio-page__progress-track">
        <span style={{ width: `${progress}%` }} />
      </div>
      <span>{formatTime(liveDuration)}</span>
    </div>
  );
}

const extractUserPlaylistId = (value: string) => {
  const raw = value.trim();
  if (!raw) return "";

  const pathMatch = raw.match(/(?:^|\/)user-playlist\/([^/?#\s]+)/);
  if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);

  try {
    const parsed = new URL(raw);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const marker = parts.findIndex((part) => part === "user-playlist");
    if (marker >= 0 && parts[marker + 1]) return decodeURIComponent(parts[marker + 1]);
  } catch {
    return "";
  }

  return "";
};

export default function RadioPage() {
  const {
    enableRadioMode,
    isRadioAwaitingUserGesture,
    isRadioBuffering,
    isPlaying,
    playerMode,
    radioState,
    togglePlayPause,
    playNext,
  } = useMusicPlayer();
  const { isAdmin, hiddenIds, isVisible } = useHiddenSongs();

  const [user, setUser] = useState<User | null>(null);
  const [songs, setSongs] = useState<ApiSong[]>([]);
  const [drag, setDrag] = useState<RadioQueueDrag | null>(null);
  const dragRef = useRef<RadioQueueDrag | null>(null);
  const queueAreaRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<RadioQueueItem[]>([]);
  const radioStateRef = useRef<RadioState | null>(null);
  const displaySongRef = useRef<(id: string) => boolean>(() => true);
  const [globalPlaylists, setGlobalPlaylists] = useState<ApiPlaylistInfo[]>([]);
  const [privatePlaylists, setPrivatePlaylists] = useState<PrivatePlaylist[]>([]);
  const [availableAlbums, setAvailableAlbums] = useState<Array<{ id: string; name: string; count: number; entryIds: string[] }>>([]);
  const [songQuery, setSongQuery] = useState("");
  const [playlistQuery, setPlaylistQuery] = useState("");
  const [resolvedUrlPlaylist, setResolvedUrlPlaylist] = useState<PlaylistChoice | null>(null);
  const [resolvedUrlSource, setResolvedUrlSource] = useState("");
  const [isResolvingUrl, setIsResolvingUrl] = useState(false);
  const [selectedItem, setSelectedItem] = useState<SelectedRadioItem | null>(null);
  const [insertChoice, setInsertChoice] = useState<InsertChoice>("last");
  const [pitch, setPitch] = useState(1);
  const [randomPitch, setRandomPitch] = useState(true);
  const [playlistShuffle, setPlaylistShuffle] = useState(false);
  const [showHiddenForAdmin, setShowHiddenForAdmin] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(RADIO_ADMIN_HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const canDisplaySong = (songId: string) => {
    if (!isAdmin) return isVisible(songId);
    return showHiddenForAdmin || !hiddenIds.has(songId);
  };

  const state = radioState;
  const currentItem = state?.currentItem ?? null;
  const queue = state?.queue || [];
  const pendingQueue = queue.slice(1).filter((item) => canDisplaySong(item.song.id));
  pendingRef.current = pendingQueue;
  radioStateRef.current = state;
  displaySongRef.current = canDisplaySong;
  const radioButtonPlaying = playerMode === "radio" ? isPlaying : state?.status === "playing";

  const handleRadioPlayPause = () => {
    if (playerMode !== "radio") {
      enableRadioMode().catch(() => {
        setMessage({ type: "error", text: "No se pudo conectar con la radio." });
      });
      return;
    }

    togglePlayPause();
  };

  useEffect(() => {
    if (!isAdmin) return;
    try {
      window.localStorage.setItem(RADIO_ADMIN_HIDDEN_KEY, showHiddenForAdmin ? "1" : "0");
    } catch {
      // Local preference only; storage failure must not affect the radio.
    }
  }, [isAdmin, showHiddenForAdmin]);

  useEffect(() => {
    enableRadioMode().catch(() => {
      setMessage({ type: "error", text: "No se pudo conectar con la radio." });
    });

    const load = async () => {
      try {
        const [songData, playlistData, albumCards] = await Promise.all([
          radioGet<ApiSong[]>("/canciones"),
          radioGet<ApiPlaylistInfo[]>("/playlists"),
          listAlbums().catch(() => []),
        ]);
        setSongs(songData);
        setGlobalPlaylists(playlistData);
        const albumDetails = await Promise.all(albumCards.map((album) => getAlbum(album.id).catch(() => null)));
        setAvailableAlbums(albumDetails.flatMap((album) => {
          if (!album) return [];
          const entries = album.tracks.filter((entry) => entry.song && (entry.state === "revealed" || entry.state === "normal"));
          return entries.length > 0 ? [{ id: album.id, name: album.nombre, count: entries.length, entryIds: entries.map((entry) => entry.entryId), iconUrl: album.iconUrl }] : [];
        }));
      } catch {
        setMessage({ type: "error", text: "No se pudo cargar el catalogo." });
      }
    };

    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  useEffect(() => {
    const loadPrivate = async () => {
      if (!user) {
        setPrivatePlaylists([]);
        return;
      }

      try {
        const own = await listOwnPrivatePlaylists(user.uid);
        setPrivatePlaylists(own.filter((playlist) => playlist.visibility === "public"));
      } catch {
        setPrivatePlaylists([]);
      }
    };

    loadPrivate();
  }, [user]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const query = playlistQuery.trim();
    const playlistId = extractUserPlaylistId(query);
    const looksLikeUserPlaylistUrl = Boolean(playlistId);

    if (!looksLikeUserPlaylistUrl) {
      setResolvedUrlPlaylist(null);
      setResolvedUrlSource("");
      setIsResolvingUrl(false);
      return;
    }

    const controller = new AbortController();
    setIsResolvingUrl(true);

    const timer = setTimeout(async () => {
      try {
        const localPlaylist = await getPrivatePlaylist(playlistId).catch(() => null);
        if (localPlaylist?.visibility === "public") {
          if (controller.signal.aborted) return;
          setResolvedUrlSource(query);
          setResolvedUrlPlaylist({
            kind: "external",
            id: localPlaylist.id,
            name: localPlaylist.nombre,
            count: localPlaylist.songIds.length,
            iconUrl: localPlaylist.iconUrl,
            url: `${window.location.origin}/user-playlist/${encodeURIComponent(localPlaylist.id)}`,
          });
          return;
        }

        const data = await radioPost<{
          playlist: { id: string; nombre: string; count: number; iconUrl?: string | null };
        }>("/radio/resolve-user-playlist-url", { url: query });

        if (controller.signal.aborted) return;
        setResolvedUrlSource(query);
        setResolvedUrlPlaylist({
          kind: "external",
          id: data.playlist.id,
          name: data.playlist.nombre,
          count: data.playlist.count,
          iconUrl: data.playlist.iconUrl,
          url: query,
        });
      } catch {
        if (controller.signal.aborted) return;
        setResolvedUrlPlaylist(null);
        setResolvedUrlSource("");
      } finally {
        if (!controller.signal.aborted) setIsResolvingUrl(false);
      }
    }, 250);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [playlistQuery]);

  const playlistChoices = useMemo<PlaylistChoice[]>(() => [
    ...privatePlaylists.map((playlist) => ({
      kind: "private" as const,
      id: playlist.id,
      name: playlist.nombre,
      count: playlist.songIds.length,
      iconUrl: playlist.iconUrl,
    })),
    ...globalPlaylists.map((playlist) => ({
      kind: "global" as const,
      id: playlist.id,
      name: playlist.nombre,
      count: playlist.numCanciones,
      iconUrl: playlist.iconUrl,
    })),
    ...availableAlbums.map((album) => ({
      kind: "album" as const,
      ...album,
    })),
  ], [availableAlbums, globalPlaylists, privatePlaylists]);

  // Shuffle the list ONCE per catalogue fetch. Searching filters that same
  // stable order so results don't jump around on each keystroke or radio tick.
  const shuffledSongs = useMemo(() => {
    const result = [...songs];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }, [songs]);
  const filteredSongs = useMemo(() => {
    const visibleSongs = shuffledSongs.filter((song) => (
      !isAdmin
        ? isVisible(song.id)
        : showHiddenForAdmin || !hiddenIds.has(song.id)
    ));
    const q = songQuery.trim().toLowerCase();
    if (!q) return visibleSongs.slice(0, 12);
    return visibleSongs
      .filter((song) =>
        song.name.toLowerCase().includes(q) ||
        Boolean(song.variantes?.some((variant) => variant.toLowerCase().includes(q)))
      )
      .slice(0, 18);
  }, [hiddenIds, isAdmin, isVisible, showHiddenForAdmin, songQuery, shuffledSongs]);

  const filteredPlaylists = useMemo(() => {
    const q = playlistQuery.trim().toLowerCase();
    const isUrlSearch = Boolean(extractUserPlaylistId(playlistQuery.trim()));
    const base = isUrlSearch
      ? []
      : playlistChoices.filter((playlist) => !q || playlist.name.toLowerCase().includes(q)).slice(0, 18);

    if (!resolvedUrlPlaylist || resolvedUrlSource !== playlistQuery.trim()) return base;
    const withoutDuplicate = base.filter((playlist) =>
      `${playlist.kind}:${playlist.id}` !== `${resolvedUrlPlaylist.kind}:${resolvedUrlPlaylist.id}`
    );
    return [resolvedUrlPlaylist, ...withoutDuplicate];
  }, [playlistChoices, playlistQuery, resolvedUrlPlaylist, resolvedUrlSource]);

  const resolveInsertAt = (): RadioInsertAt => insertChoice;

  const addOptions = () => ({
    insertAt: resolveInsertAt(),
    pitch: randomPitch ? undefined : pitch,
    randomPitch,
    addedBy: "web",
  });

  const runRadioAction = async (action: () => Promise<RadioState>, success?: string) => {
    try {
      await action();
      if (success) setMessage({ type: "success", text: success });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "No se pudo actualizar la radio." });
    }
  };

  const addSelectedItem = () => {
    if (!selectedItem) return;

    if (selectedItem.type === "song") {
      runRadioAction(() => radioPost<RadioState>("/radio/queue/songs", {
        songIds: [selectedItem.song.id],
        ...addOptions(),
      }));
      return;
    }

    const playlist = selectedItem.playlist;
    const shuffle = playlistShuffle;

    if (playlist.kind === "album") {
      runRadioAction(() => addAlbumToRadio<RadioState>(playlist.id, {
        entryIds: playlist.entryIds,
        shuffle,
        ...addOptions(),
      }));
      return;
    }

    if (playlist.kind === "private" || playlist.kind === "external") {
      const url = playlist.kind === "external"
        ? playlist.url
        : `${window.location.origin}/user-playlist/${encodeURIComponent(playlist.id)}`;
      runRadioAction(() => radioPost<RadioState>("/radio/queue/user-playlist-url", {
        url,
        shuffle,
        ...addOptions(),
      }));
      return;
    }

    runRadioAction(() => radioPost<RadioState>("/radio/queue/global-playlist", {
      playlistId: playlist.id,
      shuffle,
      ...addOptions(),
    }));
  };

  const updateQueuePitch = (item: RadioQueueItem, value: number) => {
    runRadioAction(
      () => radioPatch<RadioState>(`/radio/queue/${encodeURIComponent(item.itemId)}`, { pitch: value }),
      "Pitch actualizado."
    );
  };

  const removeQueueItem = (item: RadioQueueItem) => {
    runRadioAction(
      () => radioDelete<RadioState>(`/radio/queue/${encodeURIComponent(item.itemId)}`),
      "Canción quitada de la cola."
    );
  };

  // Apply a visible drag without dropping hidden songs from the shared queue.
  // Hidden items keep their own positions; only visible slots are permuted.
  const commitVisibleQueueOrder = async (visibleIds: string[], skipAfter = false) => {
    const live = radioStateRef.current;
    if (!live) return;
    const full = live.queue.slice(1);
    const allowed = new Set(full.filter((item) => displaySongRef.current(item.song.id)).map((item) => item.itemId));
    const canonical = full.filter((item) => allowed.has(item.itemId)).map((item) => item.itemId);
    if (canonical.length !== visibleIds.length ||
        canonical.some((id) => !visibleIds.includes(id))) return;
    let at = 0;
    const ids = full.map((item) => allowed.has(item.itemId) ? visibleIds[at++] : item.itemId);
    try {
      if (ids.some((id, index) => id !== full[index]?.itemId)) {
        await radioPost<RadioState>("/radio/queue/reorder", { itemIds: ids });
      }
      if (skipAfter) await radioPost<RadioState>("/radio/skip");
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "No se pudo reordenar la radio." });
    }
  };
  const beginRadioDrag = (event: ReactPointerEvent<HTMLElement>, itemId: string) => {
    if (event.button !== 0 || dragRef.current) return;
    if (event.target instanceof Element && event.target.closest("button, input, label, select")) return;
    const row = event.currentTarget.closest<HTMLElement>("[data-radio-queue-row]");
    const area = queueAreaRef.current;
    if (!row || !area) return;
    event.preventDefault();
    const bounds = row.getBoundingClientRect();
    const value: RadioQueueDrag = {
      id: itemId, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY,
      offsetY: event.clientY - bounds.top,
      left: bounds.left, width: bounds.width, height: bounds.height,
      targetIndex: pendingRef.current.findIndex((item) => item.itemId === itemId),
      active: false, playNow: false,
    };
    dragRef.current = value;
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const value = dragRef.current;
      if (!value || value.pointerId !== event.pointerId) return;
      const active = value.active || Math.hypot(event.clientX - value.startX, event.clientY - value.startY) > 5;
      if (!active) return;
      event.preventDefault();
      const area = queueAreaRef.current;
      const rows = area ? [...area.querySelectorAll<HTMLElement>("[data-radio-queue-row]")] : [];
      const remaining = rows.filter((row) => row.dataset.radioQueueRow !== value.id);
      const targetIndex = remaining.filter((row) => event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2).length;
      const now = area?.querySelector<HTMLElement>("[data-radio-queue-current]")?.getBoundingClientRect();
      const playNow = Boolean(now && event.clientX >= now.left && event.clientX <= now.right &&
        event.clientY >= now.top && event.clientY <= now.bottom);
      const next = { ...value, x: event.clientX, y: event.clientY, targetIndex, active, playNow };
      dragRef.current = next;
      setDrag(next);
    };
    const finish = (event: PointerEvent) => {
      const value = dragRef.current;
      if (!value || value.pointerId !== event.pointerId) return;
      if (value.active) {
        const original = pendingRef.current.map((item) => item.itemId);
        const at = original.indexOf(value.id);
        if (at >= 0) {
          const next = [...original];
          next.splice(at, 1);
          next.splice(Math.max(0, Math.min(next.length, value.playNow ? 0 : value.targetIndex)), 0, value.id);
          if (next.some((id, index) => id !== original[index]) || value.playNow) {
            void commitVisibleQueueOrder(next, value.playNow);
          }
        }
      }
      dragRef.current = null;
      setDrag(null);
    };
    const cancel = () => { dragRef.current = null; setDrag(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
    };
    // State needed during the drag lives in refs to avoid reattaching listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const movePendingItem = (from: number, to: number) => {
    if (!state) return;
    const pending = state.queue.slice(1);
    if (to < 0 || to >= pending.length) return;
    const reordered = [...pending];
    const [item] = reordered.splice(from, 1);
    reordered.splice(to, 0, item);
    void commitVisibleQueueOrder(reordered.map((entry) => entry.itemId));
  };

  const reorderQueue = () => {
    runRadioAction(
      () => radioPatch<RadioState>("/radio/settings", { shuffleNow: true })
    );
  };

  const clearQueue = () => {
    runRadioAction(() => radioPost<RadioState>("/radio/queue/clear"), "Cola vaciada.");
  };

  return (
    <>
    <main className={`playlist-admin radio-page ${queueStyles.page}`}>
      <div className="playlist-admin__content radio-page__content">
        <header className="playlist-admin__header radio-page__header">
          <div>
            <h1 className="playlist-admin__title radio-page__title">
              <RadioIcon size={29} strokeWidth={1.9} /> Radio
            </h1>
            <p className="playlist-admin__subtitle">
              Estación compartida · sincronizada en tiempo real
            </p>
          </div>
          <div className="playlist-admin__header-actions">
            {isAdmin && (
              <label className={styles.hiddenToggle} title="Preferencia local de este navegador">
                <span className={styles.hiddenToggleCopy}>
                  <EyeOffIcon size={15} />
                  <span>Mostrar ocultas</span>
                </span>
                <input
                  type="checkbox"
                  checked={showHiddenForAdmin}
                  onChange={(event) => setShowHiddenForAdmin(event.target.checked)}
                />
                <i aria-hidden="true"><span /></i>
              </label>
            )}
            <button onClick={clearQueue} className="playlist-admin__btn-action playlist-admin__btn-action--danger">
              <TrashIcon size={16} /> Vaciar
            </button>
          </div>
        </header>

        {message && (
          <div className={`playlist-admin__message playlist-admin__message--${message.type}`}>
            {message.text}
          </div>
        )}

        <div className="radio-page__workspace">
          <aside className="radio-page__left">
            <section className={`radio-page__current-card ${queueStyles.currentPanel}`}>
              <div className={queueStyles.currentIdentity}>
                <span className={queueStyles.currentCover}>
                  {currentItem ? <SongArtwork src={currentItem.song.iconUrl} alt="" /> : <RadioIcon size={25} strokeWidth={1.5} />}
                </span>
              <div className="radio-page__now-info">
                <span className="radio-page__eyebrow">
                  {isRadioAwaitingUserGesture
                    ? "Listo para unirte"
                    : isRadioBuffering ? "Sincronizando" : state?.status === "playing" ? "En directo" : "Pausada"}
                </span>
                <h2>{currentItem?.song.name || "Sin canción en radio"}</h2>
                <p>
                  {isRadioAwaitingUserGesture
                    ? "La radio sigue sonando. Pulsa play para entrar exactamente al directo."
                    : isRadioBuffering
                    ? "Cargando audio y ajustando el punto exacto de la radio..."
                    : currentItem ? `${currentItem.source.name} - Pitch ${currentItem.pitch.toFixed(2)}x` : "Añade canciones para empezar la sesión compartida."}
                </p>
              </div>
              </div>

              <div className="radio-page__controls">
                <button className="playlist-admin__control-btn playlist-admin__control-btn--play" onClick={handleRadioPlayPause} title={radioButtonPlaying ? "Pausar radio" : "Reproducir radio"}>
                  {radioButtonPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
                </button>
                <button className="playlist-admin__control-btn" onClick={playNext} title="Siguiente">
                  <SkipForwardIcon size={18} />
                </button>
              </div>

              <RadioProgress />

              {currentItem && (
                <div className="radio-page__current-pitch">
                  <label htmlFor="radio-current-pitch">Pitch actual</label>
                  <input
                    id="radio-current-pitch"
                    type="range"
                    min={0.5}
                    max={1.5}
                    step={0.01}
                    value={currentItem.pitch}
                    onChange={(e) => updateQueuePitch(currentItem, Number(e.target.value))}
                  />
                  <strong>{currentItem.pitch.toFixed(2)}x</strong>
                </div>
              )}
            </section>

            <section className={`radio-page__queue ${queueStyles.queue}`}>
              <div className={queueStyles.heading}>
                <div>
                  <span className={queueStyles.eyebrow}><RadioIcon size={13}/> RADIO · COLA COMPARTIDA</span>
                  <h2>Cola de reproducción</h2>
                </div>
                <div className={queueStyles.headingActions}>
                  <span>{queue.length} canciones</span>
                  <button onClick={reorderQueue} title="Mezclar próximas canciones" disabled={pendingQueue.length < 2}>
                    <ShuffleIcon size={14} /> Mezclar
                  </button>
                </div>
              </div>

              {queue.length === 0 ? (
                <p className="playlist-admin__empty">La cola está vacía. Añade una canción o playlist.</p>
              ) : (
                <div className="radio-page__queue-list" ref={queueAreaRef}>
                  {currentItem && (
                    <QueueRow
                      item={currentItem}
                      index={0}
                      current
                      dropNow={Boolean(drag?.active && drag.playNow)}
                      onRemove={removeQueueItem}
                      onPitch={updateQueuePitch}
                    />
                  )}
                  {pendingQueue.map((item, index) => (
                    <div key={item.itemId} className={queueStyles.dragSlot}>
                      {drag?.active && !drag.playNow && drag.targetIndex === index && <div className={queueStyles.dropLine} />}
                      <QueueRow
                      dragId={item.itemId}
                      dragging={drag?.active && drag.id === item.itemId}
                      onDragStart={(event) => beginRadioDrag(event, item.itemId)}
                      item={item}
                      index={index + 1}
                      onRemove={removeQueueItem}
                      onPitch={updateQueuePitch}
                      onMoveUp={() => movePendingItem(index, index - 1)}
                      onMoveDown={() => movePendingItem(index, index + 1)}
                      canMoveUp={index > 0}
                      canMoveDown={index < pendingQueue.length - 1}
                      />
                    </div>
                  ))}
                  {drag?.active && !drag.playNow && drag.targetIndex === pendingQueue.length && (
                    <div className={queueStyles.dropLine} />
                  )}
                </div>
              )}
            </section>
          </aside>

          <section className={`radio-page__add-card ${queueStyles.addPanel}`}>
            <div className="radio-page__add-grid">
              <div className="radio-page__add-panel">
                <h2 className="playlist-admin__section-title">
                  <SearchIcon size={18} /> Añadir canciones
                </h2>
                <div className="radio-page__form-row">
                  <input
                    value={songQuery}
                    onChange={(e) => setSongQuery(e.target.value)}
                    className="playlist-admin__upload-form-input"
                    placeholder="Buscar por nombre o etiqueta"
                  />
                </div>
                <YouTubeSongImport
                  value={songQuery}
                  label="Importar y añadir a la radio"
                  onImported={async (song) => {
                    await radioPost<RadioState>("/radio/queue/songs", {
                      songIds: [song.id],
                      ...addOptions(),
                    });
                    setSongQuery("");
                    setMessage({ type: "success", text: `"${song.name}" añadida a la radio.` });
                  }}
                />
                <div className="radio-page__song-results">
                  {filteredSongs.map((song) => (
                    <button
                      key={song.id}
                      type="button"
                      className={selectedItem?.type === "song" && selectedItem.song.id === song.id
                        ? "radio-page__song-result radio-page__result--selected"
                        : "radio-page__song-result"}
                      onClick={() => setSelectedItem({ type: "song", song })}
                    >
                      <span className={queueStyles.resultCover}><SongArtwork src={song.iconUrl} alt="" /></span>
                      <div>
                        <strong>{song.name}</strong>
                        <span>
                          {song.duration ? formatTime(song.duration) : "Sin duración"}
                          {isAdmin && hiddenIds.has(song.id) ? " · Oculta" : ""}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="radio-page__add-panel">
                <h2 className="playlist-admin__section-title">
                  <SearchIcon size={18} /> Añadir playlists
                </h2>
                <div className="radio-page__form-row">
                  <input
                    value={playlistQuery}
                    onChange={(e) => setPlaylistQuery(e.target.value)}
                    className="playlist-admin__upload-form-input"
                    placeholder="Buscar playlist o pegar URL pública"
                  />
                </div>
                <div className="radio-page__playlist-results">
                  {filteredPlaylists.map((playlist) => (
                    <button
                      key={`${playlist.kind}:${playlist.id}`}
                      type="button"
                      className={selectedItem?.type === "playlist" &&
                        `${selectedItem.playlist.kind}:${selectedItem.playlist.id}` === `${playlist.kind}:${playlist.id}`
                        ? "radio-page__playlist-result radio-page__result--selected"
                        : "radio-page__playlist-result"}
                      onClick={() => setSelectedItem({ type: "playlist", playlist })}
                    >
                      {playlist.iconUrl ? (
                        <span className={queueStyles.resultCover}><SongArtwork src={playlist.iconUrl} alt="" /></span>
                      ) : (
                        <span className={queueStyles.resultCoverPlaceholder} aria-hidden="true"><ListPlusIcon size={19} strokeWidth={1.6}/></span>
                      )}
                      <div>
                        <strong>{playlist.name}</strong>
                        <span>
                          {playlist.kind === "private" ? "Propia pública" : playlist.kind === "external" ? "URL pública" : playlist.kind === "album" ? "Álbum disponible" : "Global"} - {playlist.count} canciones
                        </span>
                      </div>
                    </button>
                  ))}
                  {isResolvingUrl && (
                    <p className="playlist-admin__empty">Buscando playlist pública...</p>
                  )}
                  {!isResolvingUrl && filteredPlaylists.length === 0 && (
                    <p className="playlist-admin__empty">No hay playlists disponibles.</p>
                  )}
                </div>
              </div>
            </div>

            <div className="radio-page__options-bar">
              <div className="radio-page__option-group">
                <span>Posicion</span>
                <div className="radio-page__position-buttons">
                  <button className={insertChoice === "last" ? "radio-page__option-icon radio-page__option-icon--active" : "radio-page__option-icon"} onClick={() => setInsertChoice("last")} title="Añadir última">
                    <ListPlusIcon size={16} />
                  </button>
                  <button className={insertChoice === "next" ? "radio-page__option-icon radio-page__option-icon--active" : "radio-page__option-icon"} onClick={() => setInsertChoice("next")} title="Siguiente">
                    <ChevronRightIcon size={17} />
                  </button>
                  <button className={insertChoice === "now" ? "radio-page__option-icon radio-page__option-icon--active" : "radio-page__option-icon"} onClick={() => setInsertChoice("now")} title="Reproducir ahora">
                    <ChevronsUpIcon size={17} />
                  </button>
                </div>
              </div>
              <button
                type="button"
                className={randomPitch ? "radio-page__random-pitch radio-page__random-pitch--active" : "radio-page__random-pitch"}
                onClick={() => setRandomPitch((value) => !value)}
              >
                <DicesIcon size={16} /> Pitch aleatorio
              </button>
              {!randomPitch && (
                <label className="radio-page__compact-field radio-page__pitch-box">
                  Pitch
                  <input
                    type="number"
                    min={0.5}
                    max={1.5}
                    step={0.01}
                    value={pitch}
                    onChange={(e) => setPitch(Number(e.target.value))}
                    className="playlist-admin__upload-form-input"
                  />
                </label>
              )}
              {selectedItem?.type === "playlist" && (
                <button
                  type="button"
                  className={playlistShuffle ? "radio-page__playlist-shuffle radio-page__playlist-shuffle--active" : "radio-page__playlist-shuffle"}
                  onClick={() => setPlaylistShuffle((value) => !value)}
                  title={playlistShuffle ? "Playlist en shuffle" : "Playlist en orden"}
                >
                  <ShuffleIcon size={16} />
                </button>
              )}
              <button
                type="button"
                className="radio-page__add-selected"
                onClick={addSelectedItem}
                disabled={!selectedItem}
              >
                Añadir
              </button>
            </div>
          </section>
        </div>
      </div>
    </main>
    {drag?.active && typeof document !== "undefined" && createPortal(
      <div className={queueStyles.dragGhost} style={{ left: drag.left, top: drag.y - drag.offsetY, width: drag.width }}>
        <GripVerticalIcon size={13} />
        <span className={queueStyles.cover}><SongArtwork src={pendingQueue.find((item) => item.itemId === drag.id)?.song.iconUrl} alt="" /></span>
        <span className={queueStyles.dragGhostText}>{pendingQueue.find((item) => item.itemId === drag.id)?.song.name}</span>
      </div>, document.body
    )}
    </>
  );
}

function QueueRow({
  item,
  index,
  current = false,
  canMoveUp = false,
  canMoveDown = false,
  dragId,
  dragging = false,
  dropNow = false,
  onDragStart,
  onMoveUp,
  onMoveDown,
  onRemove,
  onPitch,
}: {
  item: RadioQueueItem;
  index: number;
  current?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  dragId?: string;
  dragging?: boolean;
  dropNow?: boolean;
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove: (item: RadioQueueItem) => void;
  onPitch: (item: RadioQueueItem, value: number) => void;
}) {
  return (
    <div className={`${queueStyles.row} ${current ? queueStyles.rowCurrent : ""} ${dragging ? queueStyles.rowDragging : ""} ${dropNow ? queueStyles.rowDropNow : ""} ${!current ? queueStyles.rowDraggable : ""}`}
      data-radio-queue-row={dragId} data-radio-queue-current={current ? "true" : undefined}
      onPointerDown={onDragStart}>
      {!current && <GripVerticalIcon size={13} className={queueStyles.grip} />}
      <span className={queueStyles.cover}><SongArtwork src={item.song.iconUrl} alt="" /></span>
      <div className={queueStyles.songInfo}>
        <strong title={item.song.name}>{item.song.name}</strong>
        <span title={item.source.name}>{item.source.name}</span>
      </div>
      {current && <RadioIcon size={15} className={queueStyles.liveIcon} aria-label="Sonando ahora" />}
      <label className={queueStyles.pitch} title="Pitch de esta canción">
        <span>PITCH</span>
        <input key={`${item.itemId}-${item.pitch}`} type="number"
          min={0.5} max={1.5} step={0.01} defaultValue={item.pitch}
          onBlur={(event) => {
            const value = Number(event.currentTarget.value);
            if (Number.isFinite(value) && value >= 0.5 && value <= 1.5 && Math.abs(value - item.pitch) >= .005) onPitch(item, value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              const value = Number(event.currentTarget.value);
              if (Number.isFinite(value) && value >= .5 && value <= 1.5) onPitch(item, value);
              event.currentTarget.blur();
            }
          }}
        />
        <span>×</span>
      </label>
      <div className={queueStyles.actions}>
        {!current && <>
          <button type="button" onClick={onMoveUp} disabled={!canMoveUp} title="Subir">
            <ArrowUpIcon size={14}/>
          </button>
          <button type="button" onClick={onMoveDown} disabled={!canMoveDown} title="Bajar">
            <ArrowDownIcon size={14}/>
          </button>
        </>}
        <button type="button" onClick={() => onRemove(item)}
          title={current ? "Saltar canción actual" : "Quitar de la cola"}>
          <TrashIcon size={14}/>
        </button>
      </div>
    </div>
  );
}
