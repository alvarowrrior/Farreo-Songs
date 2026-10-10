"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import {
  CheckIcon, ChevronDownIcon, ChevronUpIcon, GripVerticalIcon, ListMusicIcon,
  PauseIcon, PlayIcon, ShuffleIcon, Trash2Icon, XIcon, ZapIcon,
} from "lucide-react";
import FarreoContextMenu, { type FarreoContextMenuItem } from "@/components/FarreoContextMenu";
import SongArtwork from "@/components/SongArtwork";
import {
  useMusicPlayer, type PlaybackQueueEntry, type MusicTrack,
  type MusicPlaylistSource,
} from "@/components/MusicPlayerProvider";
import { addSongToPrivatePlaylist, getPrivatePlaylist } from "@/lib/privatePlaylists";
import { getMediaUrl, MUSIC_API_URL, radioGet, type ApiSong } from "@/lib/radioApi";
import { lookupYoutubeTracks } from "@/lib/youtubeTracks";
import styles from "./PlaybackQueueIsland.module.scss";

interface LocalMenu {
  x: number;
  y: number;
  item: PlaybackQueueEntry;
  section: "history" | "future";
}

interface QueueDrag {
  key: string;
  sourceIndex: number;
  targetIndex: number; // Index after removing the dragged song.
  x: number;
  y: number;
  initialY: number;
  offsetY: number;
  left: number;
  width: number;
  rowHeight: number;
  dropNow: boolean;
  active: boolean;
  pointerId: number;
}

const sourceKey = (source: MusicPlaylistSource) => `${source.type}:${source.id}`;
const ALL_SHUFFLE_SOURCE: MusicPlaylistSource = {
  id: "__farreo_all__", name: "Todas las playlists", type: "song",
};
const ALL_SHUFFLE_SOURCE_KEY = sourceKey(ALL_SHUFFLE_SOURCE);
const mapApiTrack = (song: ApiSong): MusicTrack => ({
  id: song.id, name: song.name, url: getMediaUrl(song.url),
  iconUrl: song.iconUrl, duration: song.duration, variantes: song.variantes,
  lyricsSrt: song.lyricsSrt, lyricsUrl: song.lyricsUrl,
  lyricsFileName: song.lyricsFileName, staticLyrics: song.staticLyrics,
  advancedCoverUrl: song.advancedCoverUrl, advancedCoverType: song.advancedCoverType,
  createdAt: song.createdAt,
});

// One native catalogue query is shared when "Todas" resolves several private
// playlists. The cache is short lived and holds metadata, never audio data.
let nativeCatalogueRequest: Promise<ApiSong[]> | null = null;
let nativeCatalogueExpiresAt = 0;
function nativeCatalogue(): Promise<ApiSong[]> {
  if (nativeCatalogueRequest && Date.now() < nativeCatalogueExpiresAt) return nativeCatalogueRequest;
  nativeCatalogueExpiresAt = Date.now() + 60_000;
  nativeCatalogueRequest = radioGet<ApiSong[]>("/canciones").catch((error) => {
    nativeCatalogueRequest = null;
    nativeCatalogueExpiresAt = 0;
    throw error;
  });
  return nativeCatalogueRequest;
}

async function resolveSourceTracks(
  source: MusicPlaylistSource, existing: PlaybackQueueEntry[],
): Promise<MusicTrack[]> {
  if (source.type === "global") {
    const response = await fetch(`${MUSIC_API_URL}/playlist/${encodeURIComponent(source.id)}`);
    if (!response.ok) throw new Error("No se pudo consultar esa playlist.");
    const data = await response.json() as { canciones?: ApiSong[] };
    return (data.canciones || []).map(mapApiTrack);
  }
  if (source.type === "private") {
    const playlist = await getPrivatePlaylist(source.id);
    if (!playlist) throw new Error("Playlist no encontrada.");
    const [native, youtube] = await Promise.all([
      nativeCatalogue(),
      lookupYoutubeTracks(playlist.songIds),
    ]);
    const byId = new Map([...native, ...youtube].map((song) => [song.id, song]));
    return playlist.songIds.map((id) => byId.get(id)).filter((song): song is ApiSong => !!song).map(mapApiTrack);
  }
  return existing.filter((entry) => entry.source && sourceKey(entry.source) === sourceKey(source))
    .map((entry) => entry.track);
}

export default function PlaybackQueueIsland() {
  const pathname = usePathname();
  const {
    playbackHistory, playbackUpcoming, playbackQueueCleared,
    playbackShuffleSources, playbackShuffleSourceKey, selectPlaybackShuffleSource,
    currentTrack, currentSource, playerMode, isShuffle, isPlaying, togglePlayPause,
    playPlaybackQueueEntry, reorderPlaybackQueueEntry,
    removeFromPlaybackQueue, clearPlaybackHistory,
    clearPlaybackUpcoming, addToPlaybackQueue,
  } = useMusicPlayer();
  const [expanded, setExpanded] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(3);
  const [menu, setMenu] = useState<LocalMenu | null>(null);
  const [notice, setNotice] = useState("");
  const [switchingSource, setSwitchingSource] = useState(false);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<QueueDrag | null>(null);
  const dragRef = useRef<QueueDrag | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const upcomingRef = useRef(playbackUpcoming);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLElement>(null);
  const startingScrollRef = useRef(0);
  const startingRectsRef = useRef<DOMRect[]>([]);

  upcomingRef.current = playbackUpcoming;
  const shownHistory = useMemo(() => playbackHistory.slice(-historyLimit).reverse(), [playbackHistory, historyLimit]);
  const selectedSourceKey = playbackShuffleSourceKey === ALL_SHUFFLE_SOURCE_KEY
    ? ALL_SHUFFLE_SOURCE_KEY
    : playbackShuffleSources.some(({ source }) => sourceKey(source) === playbackShuffleSourceKey)
      ? playbackShuffleSourceKey ?? "" : "";
  const allEntries = useMemo<PlaybackQueueEntry[]>(() => [
    ...playbackUpcoming, ...playbackHistory,
    ...(currentTrack ? [{
      key: `current:${currentTrack.id}`, track: currentTrack,
      source: currentSource, pitch: { kind: "random" } as const,
      manual: false,
    }] : []),
  ], [playbackUpcoming, playbackHistory, currentTrack, currentSource]);

  useEffect(() => {
    if (!isShuffle) setSourcePickerOpen(false);
  }, [isShuffle]);

  useEffect(() => {
    if (!sourcePickerOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setSourcePickerOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSourcePickerOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", keydown);
    };
  }, [sourcePickerOpen]);

  const cancelDrag = () => {
    dragRef.current = null;
    setDrag(null);
  };

  // Pointer-based drag rather than native HTML5 draggable: this gives us a
  // stable floating preview, animated displacement and a precise insert line.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const active = current.active || Math.abs(event.clientY - current.initialY) > 5;
      if (!active) return;
      event.preventDefault();
      const scroll = scrollRef.current;
      if (scroll) {
        const rect = scroll.getBoundingClientRect();
        if (event.clientY > rect.top && event.clientY < rect.bottom) {
          const distance = Math.min(event.clientY - rect.top, rect.bottom - event.clientY);
          if (distance < 34) {
            scroll.scrollTop += (event.clientY - rect.top < 34 ? -1 : 1) * Math.max(2, (34 - distance) * .35);
          }
        }
      }
      const bounds = nowRef.current?.getBoundingClientRect();
      const dropNow = Boolean(bounds && event.clientX >= bounds.left - 12
        && event.clientX <= bounds.right + 12
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom + 9);
      const scrollDelta = (scroll?.scrollTop ?? 0) - startingScrollRef.current;
      const withoutSource = startingRectsRef.current
        .map((rect, index) => ({ midpoint: rect.top + rect.height / 2 - scrollDelta, index }))
        .filter((rect) => rect.index !== current.sourceIndex);
      const targetIndex = withoutSource.filter((item) => event.clientY >= item.midpoint).length;
      const next: QueueDrag = {
        ...current, x: event.clientX, y: event.clientY, active, dropNow, targetIndex,
      };
      dragRef.current = next;
      setDrag(next);
    };
    const onFinish = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const entries = upcomingRef.current;
      const stillExists = entries.some((entry) => entry.key === current.key);
      if (current.active && stillExists) {
        // Pointer-up can also create a click on the song button; never play
        // that click after a drag-and-drop reorder.
        suppressClickRef.current = current.key;
        window.requestAnimationFrame(() => { suppressClickRef.current = null; });
        if (current.dropNow) playPlaybackQueueEntry(current.key);
        else reorderPlaybackQueueEntry(current.key, current.targetIndex);
      }
      dragRef.current = null;
      setDrag(null);
    };
    const onCancel = () => { dragRef.current = null; setDrag(null); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current) onCancel();
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onFinish);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onFinish);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKey);
    };
    // Refs hold the current queue; the drag listeners are installed only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playPlaybackQueueEntry, reorderPlaybackQueueEntry]);

  useEffect(() => {
    if (dragRef.current && !playbackUpcoming.some((item) => item.key === dragRef.current?.key)) {
      cancelDrag();
    }
  }, [playbackUpcoming]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>, key: string, index: number, fromGrip = false) => {
    if (event.button !== 0 || dragRef.current) return;
    const row = event.currentTarget.closest<HTMLElement>("[data-queue-row]");
    const scroller = scrollRef.current;
    if (!row || !scroller) return;
    if (fromGrip) { event.preventDefault(); event.stopPropagation(); }
    setMenu(null);
    startingScrollRef.current = scroller.scrollTop;
    startingRectsRef.current = Array.from(scroller.querySelectorAll<HTMLElement>("[data-queue-row]"))
      .map((node) => node.getBoundingClientRect());
    const bounds = row.getBoundingClientRect();
    const initial: QueueDrag = {
      key, sourceIndex: index, targetIndex: index,
      x: event.clientX, y: event.clientY, initialY: event.clientY,
      offsetY: event.clientY - bounds.top,
      left: bounds.left, width: bounds.width, rowHeight: bounds.height,
      dropNow: false, active: false, pointerId: event.pointerId,
    };
    dragRef.current = initial;
  };

  const switchSource = async (key: string) => {
    if (switchingSource || key === playbackShuffleSourceKey) {
      setSourcePickerOpen(false);
      return;
    }
    const selected = playbackShuffleSources.find((entry) => sourceKey(entry.source) === key);
    if (key !== ALL_SHUFFLE_SOURCE_KEY && !selected) return;
    setSourcePickerOpen(false);
    setSwitchingSource(true);
    try {
      if (key === ALL_SHUFFLE_SOURCE_KEY) {
        // "Todas" mixes the playlists currently participating in this session.
        // Keep a song's original playlist rather than relabelling it as "Todas".
        const results = await Promise.allSettled(playbackShuffleSources.map(async ({ source }) => ({
          source, tracks: await resolveSourceTracks(source, allEntries),
        })));
        const combined = new Map<string, MusicTrack>();
        const origin = new Map<string, MusicPlaylistSource>();
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          const { source, tracks } = result.value;
          for (const track of tracks) {
            if (!track.url || combined.has(track.id)) continue;
            combined.set(track.id, track);
            origin.set(track.id, source);
          }
        }
        if (!combined.size) throw new Error("No se pudieron cargar las playlists de la sesión.");
        selectPlaybackShuffleSource(ALL_SHUFFLE_SOURCE, [...combined.values()], origin);
        const failed = results.filter((result) => result.status === "rejected").length;
        setNotice(failed ? `Mezclando ${results.length - failed} playlists. ${failed} no se pudieron cargar.`
          : "Mezclando todas las playlists de la sesión.");
      } else if (selected) {
        const tracks = await resolveSourceTracks(selected.source, allEntries);
        const unique = [...new Map(tracks.filter((track) => track.url).map((track) => [track.id, track])).values()];
        if (!unique.length) throw new Error("Esta playlist no tiene canciones disponibles.");
        selectPlaybackShuffleSource(selected.source, unique);
        setNotice(`Próximas canciones desde ${selected.source.name}.`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo seleccionar la playlist.");
    } finally { setSwitchingSource(false); }
  };

  const openMenu = (
    event: React.MouseEvent<HTMLElement>, item: PlaybackQueueEntry,
    section: "history" | "future",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, item, section });
  };

  const itemView = (item: PlaybackQueueEntry, section: "history" | "future", index: number) => {
    const isFuture = section === "future";
    const isDragging = Boolean(isFuture && drag?.active && drag.key === item.key);
    const isShifted = Boolean(isFuture && drag?.active && !drag.dropNow && drag.sourceIndex !== index && (
      (drag.targetIndex < drag.sourceIndex && index >= drag.targetIndex && index < drag.sourceIndex)
      || (drag.targetIndex > drag.sourceIndex && index <= drag.targetIndex && index > drag.sourceIndex)
    ));
    const shift = drag && isShifted ? (drag.targetIndex < drag.sourceIndex ? drag.rowHeight : -drag.rowHeight) : 0;
    const before = Boolean(isFuture && drag?.active && !drag.dropNow
      && drag.targetIndex <= drag.sourceIndex && index === drag.targetIndex);
    const after = Boolean(isFuture && drag?.active && !drag.dropNow
      && drag.targetIndex > drag.sourceIndex && index === drag.targetIndex);
    return (
      <div
        key={item.key}
        data-queue-row={isFuture ? "true" : undefined}
        className={`${styles.song} ${!isFuture ? styles.songPlayed : ""} ${isDragging ? styles.dragOrigin : ""} ${before ? styles.dropBefore : ""} ${after ? styles.dropAfter : ""}`}
        style={shift ? { transform: `translateY(${shift}px)` } : undefined}
        onContextMenu={(event) => openMenu(event, item, section)}
      >
        {isFuture ? (
          <button type="button" className={styles.grip} aria-label={`Arrastrar ${item.track.name} para cambiar el orden`}
            onPointerDown={(event) => startDrag(event, item.key, index, true)}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                reorderPlaybackQueueEntry(item.key, index + (event.key === "ArrowUp" ? -1 : 1));
              }
            }}
            title="Arrastrar para ordenar · ↑↓ para mover con teclado">
            <GripVerticalIcon size={15} />
          </button>
        ) : null}
        <button type="button" className={styles.songMain}
          onPointerDown={isFuture ? (event) => startDrag(event, item.key, index) : undefined}
          onClick={() => {
            if (suppressClickRef.current === item.key) return;
            playPlaybackQueueEntry(item.key);
          }} title={`Reproducir ${item.track.name}`}>
          <span className={styles.cover}><SongArtwork src={item.track.iconUrl} alt="" /></span>
          <span className={styles.songCopy}>
            <span className={styles.songName}>{item.track.name}</span>
            <span className={styles.songSource}>{item.source?.name || "Canción"}</span>
          </span>
        </button>
        {isFuture && item.manual ? (
          <button type="button" className={styles.remove} aria-label={`Quitar ${item.track.name} de la cola`}
            onClick={() => removeFromPlaybackQueue(item.key)}><XIcon size={14} /></button>
        ) : null}
      </div>
    );
  };

  const menuItems: FarreoContextMenuItem[] = menu ? [
    { label: "Reproducir ahora", icon: <PlayIcon size={15} />,
      onSelect: () => playPlaybackQueueEntry(menu.item.key) },
    { label: "Añadir como siguiente", icon: <ZapIcon size={15} />,
      onSelect: () => addToPlaybackQueue(menu.item.track, "next", { kind: "random" }, menu.item.source) },
    { label: "Añadir al final de la cola", icon: <ListMusicIcon size={15} />,
      onSelect: () => addToPlaybackQueue(menu.item.track, "last", { kind: "random" }, menu.item.source) },
    ...(currentSource?.type === "private" ? [{
      label: `Añadir a ${currentSource.name}`, icon: <ListMusicIcon size={15} />,
      onSelect: () => void addSongToPrivatePlaylist(currentSource.id, menu.item.track.id)
        .then(() => setNotice("Canción añadida a la playlist."))
        .catch(() => setNotice("No se pudo añadir a la playlist.")),
    } satisfies FarreoContextMenuItem] : []),
    ...(menu.section === "future" && menu.item.manual ? [{
      label: "Quitar de la cola", icon: <Trash2Icon size={15} />, danger: true,
      onSelect: () => removeFromPlaybackQueue(menu.item.key),
    } satisfies FarreoContextMenuItem] : []),
  ] : [];

  // Desktop only. Radio has its own shared queue, not this personal queue.
  if (playerMode === "radio" || pathname.startsWith("/admin")) return null;

  const draggedEntry = drag?.active ? playbackUpcoming.find((item) => item.key === drag.key) : null;

  return (
    <aside className={`${styles.island} ${expanded ? styles.open : ""}`} aria-label="Cola de reproducción">
      <button type="button" className={styles.toggle}
        onClick={() => { setExpanded((value) => !value); setMenu(null); cancelDrag(); }}
        aria-expanded={expanded} title={expanded ? "Plegar cola" : "Abrir cola"}>
        <ListMusicIcon size={20} className={styles.logo} strokeWidth={1.8} />
        <span className={styles.toggleName}>{expanded ? "Cola de reproducción" : "Cola"}</span>
        {expanded ? <ChevronUpIcon size={18} className={styles.toggleArrow} />
          : <ChevronDownIcon size={18} className={styles.toggleArrow} />}
      </button>

      {expanded && (
        <div className={styles.body}>
          <div className={styles.scroll} ref={scrollRef}>
            <section className={styles.history} aria-label="Canciones anteriores">
              <div className={styles.sectionHeading}>
                <span>ANTERIORES</span>
                <button type="button" className={styles.clearButton} disabled={!playbackHistory.length}
                  onClick={clearPlaybackHistory}>Limpiar</button>
              </div>
              {shownHistory.length ? shownHistory.map((entry, index) => itemView(entry, "history", index))
                : <p className={styles.empty}>Todavía no hay canciones anteriores.</p>}
              {playbackHistory.length > historyLimit && (
                <button type="button" className={styles.more} onClick={() => setHistoryLimit((n) => n + 8)}>
                  Mostrar anteriores ({playbackHistory.length - historyLimit} más)
                </button>
              )}
              {historyLimit > 3 && playbackHistory.length > 3 && (
                <button type="button" className={styles.less} onClick={() => setHistoryLimit(3)}>Ver menos</button>
              )}
            </section>

            <section ref={nowRef} className={`${styles.nowSection} ${drag?.active && drag.dropNow ? styles.nowDrop : ""}`} aria-label="Sonando ahora">
              <div className={styles.sectionHeading}><span className={styles.playingLabel}>SONANDO</span></div>
              {drag?.active && drag.dropNow && (
                <div className={styles.nowDropLine}><PlayIcon size={12} /> Soltar para reproducir ahora</div>
              )}
              {currentTrack ? (
                <div className={styles.current}>
                  <span className={styles.heroCover}>
                    <SongArtwork src={currentTrack.iconUrl} alt="" />
                    <button type="button" className={styles.coverPlayback}
                      title={isPlaying ? "Pausar canción" : "Reanudar canción"}
                      aria-label={isPlaying ? "Pausar canción" : "Reanudar canción"}
                      onClick={togglePlayPause}>
                      {isPlaying ? <PauseIcon size={19} fill="currentColor" /> : <PlayIcon size={19} fill="currentColor" />}
                    </button>
                  </span>
                  <span className={styles.heroCopy}>
                    <strong title={currentTrack.name}>{currentTrack.name}</strong>
                    <small title={currentSource?.name || ""}>{currentSource?.name || "Canción"}</small>
                  </span>
                  <span className={`${styles.equalizer} ${!isPlaying ? styles.equalizerPaused : ""}`} aria-label={isPlaying ? "Reproduciendo" : "En pausa"}>
                    <i /><i /><i />
                  </span>
                </div>
              ) : <p className={styles.empty}>Elige una canción para empezar.</p>}
            </section>

            <section className={styles.upNext} aria-label="A continuación">
              <div className={styles.sectionHeading}>
                <span>A CONTINUACIÓN</span>
                <button type="button" className={styles.clearButton} disabled={!playbackUpcoming.length}
                  title="Vaciar la cola futura" onClick={clearPlaybackUpcoming}>Vaciar</button>
              </div>
              <div className={styles.songList}>
                {playbackUpcoming.length
                  ? playbackUpcoming.map((entry, index) => itemView(entry, "future", index))
                  : <p className={styles.empty}>{playbackQueueCleared
                    ? "La cola está vacía. Añade una canción cuando quieras."
                    : "Preparando las siguientes canciones…"}</p>}
              </div>
            </section>
          </div>

          {isShuffle && playbackShuffleSources.length > 0 && (
            <div className={styles.sourcePanel} ref={pickerRef}>
              <ShuffleIcon size={15} aria-hidden="true" />
              <span className={styles.sourceTitle}>Mezclar desde</span>
              <button type="button" className={styles.sourcePickerButton}
                aria-haspopup="listbox" aria-expanded={sourcePickerOpen}
                disabled={switchingSource}
                title="Seleccionar playlist para las próximas canciones aleatorias"
                onClick={() => setSourcePickerOpen((open) => !open)}>
                <span>{switchingSource ? "Cargando…" : selectedSourceKey === ALL_SHUFFLE_SOURCE_KEY
                  ? "Todas" : playbackShuffleSources.find(({source}) => sourceKey(source) === selectedSourceKey)?.source.name || "Elegir playlist"}</span>
                <ChevronDownIcon size={13} className={sourcePickerOpen ? styles.chevronOpen : ""} />
              </button>
              {sourcePickerOpen && (
                <div className={styles.sourcePickerMenu} role="listbox" aria-label="Origen de la mezcla">
                  <button type="button" role="option" aria-selected={selectedSourceKey === ALL_SHUFFLE_SOURCE_KEY}
                    className={`${styles.sourceOption} ${selectedSourceKey === ALL_SHUFFLE_SOURCE_KEY ? styles.sourceOptionActive : ""}`}
                    onClick={() => void switchSource(ALL_SHUFFLE_SOURCE_KEY)}>
                    <span><strong>Todas</strong><small>Mezclar las playlists de esta sesión</small></span>
                    {selectedSourceKey === ALL_SHUFFLE_SOURCE_KEY && <CheckIcon size={15}/>}
                  </button>
                  {playbackShuffleSources.map(({source}) => (
                    <button type="button" role="option" key={sourceKey(source)}
                      aria-selected={selectedSourceKey === sourceKey(source)}
                      className={`${styles.sourceOption} ${selectedSourceKey === sourceKey(source) ? styles.sourceOptionActive : ""}`}
                      onClick={() => void switchSource(sourceKey(source))}>
                      <span><strong>{source.name}</strong><small>{source.type === "private" ? "Playlist personal" : source.type === "album" ? "Álbum" : "Playlist"}</small></span>
                      {selectedSourceKey === sourceKey(source) && <CheckIcon size={15}/>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {notice && <button type="button" className={styles.notice} onClick={() => setNotice("")}>{notice} ×</button>}
        </div>
      )}
      {menu && <FarreoContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      {drag?.active && draggedEntry && typeof document !== "undefined" && createPortal(
        <div className={styles.dragGhost} style={{
          left: drag.left, top: drag.y - drag.offsetY, width: drag.width,
        }} aria-hidden="true">
          <span className={styles.cover}><SongArtwork src={draggedEntry.track.iconUrl} alt="" /></span>
          <span className={styles.songCopy}>
            <span className={styles.songName}>{draggedEntry.track.name}</span>
            <span className={styles.songSource}>{draggedEntry.source?.name || "Canción"}</span>
          </span>
        </div>, document.body,
      )}
    </aside>
  );
}
