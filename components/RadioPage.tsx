"use client";

import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  ChevronsUpIcon,
  DicesIcon,
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

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
};

type InsertChoice = "last" | "next" | "now";
type PlaylistChoice =
  | { kind: "private"; id: string; name: string; count: number }
  | { kind: "global"; id: string; name: string; count: number }
  | { kind: "external"; id: string; name: string; count: number; url: string };
type SelectedRadioItem =
  | { type: "song"; song: ApiSong }
  | { type: "playlist"; playlist: PlaylistChoice };

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
    duration,
    enableRadioMode,
    isRadioAwaitingUserGesture,
    isRadioBuffering,
    isPlaying,
    playerMode,
    radioState,
    togglePlayPause,
    playNext,
  } = useMusicPlayer();
  const { currentTime } = useMusicPlayerTime();
  const { isVisible } = useHiddenSongs();

  const [user, setUser] = useState<User | null>(null);
  const [songs, setSongs] = useState<ApiSong[]>([]);
  const [globalPlaylists, setGlobalPlaylists] = useState<ApiPlaylistInfo[]>([]);
  const [privatePlaylists, setPrivatePlaylists] = useState<PrivatePlaylist[]>([]);
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
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const state = radioState;
  const currentItem = state?.currentItem ?? null;
  const queue = state?.queue || [];
  const pendingQueue = queue.slice(1).filter((item) => isVisible(item.song.id));
  const livePosition = playerMode === "radio" ? currentTime : getLiveRadioPosition(state);
  const liveDuration = duration || currentItem?.song.duration || 0;
  const progress = liveDuration > 0 ? Math.min(100, Math.max(0, (livePosition / liveDuration) * 100)) : 0;

  useEffect(() => {
    enableRadioMode().catch(() => {
      setMessage({ type: "error", text: "No se pudo conectar con la radio." });
    });

    const load = async () => {
      try {
        const [songData, playlistData] = await Promise.all([
          radioGet<ApiSong[]>("/canciones"),
          radioGet<ApiPlaylistInfo[]>("/playlists"),
        ]);
        setSongs(songData);
        setGlobalPlaylists(playlistData);
      } catch {
        setMessage({ type: "error", text: "No se pudo cargar el catalogo." });
      }
    };

    load();
    // enableRadioMode is provided by context and intentionally called only when entering /radio.
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
            url: `${window.location.origin}/user-playlist/${encodeURIComponent(localPlaylist.id)}`,
          });
          return;
        }

        const data = await radioPost<{
          playlist: { id: string; nombre: string; count: number };
        }>("/radio/resolve-user-playlist-url", { url: query });

        if (controller.signal.aborted) return;
        setResolvedUrlSource(query);
        setResolvedUrlPlaylist({
          kind: "external",
          id: data.playlist.id,
          name: data.playlist.nombre,
          count: data.playlist.count,
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
    })),
    ...globalPlaylists.map((playlist) => ({
      kind: "global" as const,
      id: playlist.id,
      name: playlist.nombre,
      count: playlist.numCanciones,
    })),
  ], [globalPlaylists, privatePlaylists]);

  const filteredSongs = useMemo(() => {
    const visibleSongs = songs.filter((song) => isVisible(song.id));
    const q = songQuery.trim().toLowerCase();
    if (!q) return visibleSongs.slice(0, 12);
    return visibleSongs
      .filter((song) =>
        song.name.toLowerCase().includes(q) ||
        Boolean(song.variantes?.some((variant) => variant.toLowerCase().includes(q)))
      )
      .slice(0, 18);
  }, [songQuery, songs, isVisible]);

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

  const resolveInsertAt = (): RadioInsertAt => {
    return insertChoice;
  };

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
      "Cancion quitada de la cola."
    );
  };

  const movePendingItem = (from: number, to: number) => {
    if (!state) return;
    const pending = state.queue.slice(1);
    if (to < 0 || to >= pending.length) return;
    const reordered = [...pending];
    const [item] = reordered.splice(from, 1);
    reordered.splice(to, 0, item);
    runRadioAction(
      () => radioPost<RadioState>("/radio/queue/reorder", { itemIds: reordered.map((entry) => entry.itemId) }),
      "Cola reordenada."
    );
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
    <main className="playlist-admin radio-page">
      <div className="playlist-admin__content radio-page__content">
        <header className="playlist-admin__header radio-page__header">
          <div>
            <h1 className="playlist-admin__title radio-page__title">
              <RadioIcon size={34} /> Radio
            </h1>
            <p className="playlist-admin__subtitle">
              Estacion compartida sincronizada para web y Discord
            </p>
          </div>
          <div className="playlist-admin__header-actions">
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
            <section className="radio-page__current-card">
              <div className="radio-page__now-info">
                <span className="radio-page__eyebrow">
                  {isRadioAwaitingUserGesture
                    ? "Listo para unirte"
                    : isRadioBuffering ? "Sincronizando" : state?.status === "playing" ? "En directo" : "Pausada"}
                </span>
                <h2>{currentItem?.song.name || "Sin cancion en radio"}</h2>
                <p>
                  {isRadioAwaitingUserGesture
                    ? "La radio sigue sonando. Pulsa play para entrar exactamente al directo."
                    : isRadioBuffering
                    ? "Cargando audio y ajustando el punto exacto de la radio..."
                    : currentItem ? `${currentItem.source.name} - Pitch ${currentItem.pitch.toFixed(2)}x` : "Anade canciones para empezar la estacion."}
                </p>
              </div>

              <div className="radio-page__controls">
                <button className="playlist-admin__control-btn playlist-admin__control-btn--play" onClick={togglePlayPause} title={isPlaying ? "Pausar radio" : "Reproducir radio"}>
                  {isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
                </button>
                <button className="playlist-admin__control-btn" onClick={playNext} title="Siguiente">
                  <SkipForwardIcon size={18} />
                </button>
              </div>

              <div className="radio-page__progress">
                <span>{formatTime(livePosition)}</span>
                <div className="radio-page__progress-track">
                  <span style={{ width: `${progress}%` }} />
                </div>
                <span>{formatTime(liveDuration)}</span>
              </div>

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

            <section className="radio-page__queue">
              <div className="playlist-admin__section-header">
                <h2 className="playlist-admin__section-title">Cola actual</h2>
                <div className="radio-page__queue-header-actions">
                  <span className="playlist-admin__subtitle">{queue.length} canciones</span>
                  <button onClick={reorderQueue} className="radio-page__reorder-btn" disabled={pendingQueue.length < 2}>
                    <ShuffleIcon size={14} /> Reordenar
                  </button>
                </div>
              </div>

              {queue.length === 0 ? (
                <p className="playlist-admin__empty">La radio esta vacia.</p>
              ) : (
                <div className="radio-page__queue-list">
                  {currentItem && (
                    <QueueRow
                      item={currentItem}
                      index={0}
                      current
                      onRemove={removeQueueItem}
                      onPitch={updateQueuePitch}
                    />
                  )}
                  {pendingQueue.map((item, index) => (
                    <QueueRow
                      key={item.itemId}
                      item={item}
                      index={index + 1}
                      onRemove={removeQueueItem}
                      onPitch={updateQueuePitch}
                      onMoveUp={() => movePendingItem(index, index - 1)}
                      onMoveDown={() => movePendingItem(index, index + 1)}
                      canMoveUp={index > 0}
                      canMoveDown={index < pendingQueue.length - 1}
                    />
                  ))}
                </div>
              )}
            </section>
          </aside>

          <section className="radio-page__add-card">
            <div className="radio-page__add-grid">
              <div className="radio-page__add-panel">
                <h2 className="playlist-admin__section-title">
                  <SearchIcon size={18} /> Anadir canciones
                </h2>
                <div className="radio-page__form-row">
                  <input
                    value={songQuery}
                    onChange={(e) => setSongQuery(e.target.value)}
                    className="playlist-admin__upload-form-input"
                    placeholder="Buscar por nombre o etiqueta"
                  />
                </div>
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
                      <div>
                        <strong>{song.name}</strong>
                        <span>{song.duration ? formatTime(song.duration) : "Sin duracion"}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="radio-page__add-panel">
                <h2 className="playlist-admin__section-title">
                  <SearchIcon size={18} /> Anadir playlists
                </h2>
                <div className="radio-page__form-row">
                  <input
                    value={playlistQuery}
                    onChange={(e) => setPlaylistQuery(e.target.value)}
                    className="playlist-admin__upload-form-input"
                    placeholder="Buscar playlist o pegar URL publica"
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
                      <div>
                        <strong>{playlist.name}</strong>
                        <span>
                          {playlist.kind === "private" ? "Propia publica" : playlist.kind === "external" ? "URL publica" : "Global"} - {playlist.count} canciones
                        </span>
                      </div>
                    </button>
                  ))}
                  {isResolvingUrl && (
                    <p className="playlist-admin__empty">Buscando playlist publica...</p>
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
                  <button className={insertChoice === "last" ? "radio-page__option-icon radio-page__option-icon--active" : "radio-page__option-icon"} onClick={() => setInsertChoice("last")} title="Anadir ultima">
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
                Anadir
              </button>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function QueueRow({
  item,
  index,
  current = false,
  canMoveUp = false,
  canMoveDown = false,
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
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove: (item: RadioQueueItem) => void;
  onPitch: (item: RadioQueueItem, value: number) => void;
}) {
  return (
    <div className={`radio-page__queue-item ${current ? "radio-page__queue-item--current" : ""}`}>
      <div className="radio-page__queue-index">{current ? "ON" : index + 1}</div>
      <div className="radio-page__queue-song">
        <strong>{item.song.name}</strong>
        <span>{item.source.name} - {formatTime(item.song.duration || 0)}</span>
      </div>
      <div className="radio-page__queue-pitch">
        <input
          key={`${item.itemId}-${item.pitch}`}
          type="number"
          min={0.5}
          max={1.5}
          step={0.01}
          defaultValue={item.pitch}
          onBlur={(e) => onPitch(item, Number(e.currentTarget.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") onPitch(item, Number(e.currentTarget.value));
          }}
          title="Pitch de esta cancion"
        />
        <span>x</span>
      </div>
      <div className="radio-page__queue-actions">
        {!current && (
          <>
            <button onClick={onMoveUp} disabled={!canMoveUp} title="Subir">
              <ArrowUpIcon size={15} />
            </button>
            <button onClick={onMoveDown} disabled={!canMoveDown} title="Bajar">
              <ArrowDownIcon size={15} />
            </button>
          </>
        )}
        <button onClick={() => onRemove(item)} title={current ? "Saltar cancion actual" : "Quitar"}>
          <TrashIcon size={15} />
        </button>
      </div>
    </div>
  );
}
