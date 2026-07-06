"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon, ChevronUpIcon, GripVerticalIcon, LibraryIcon, MoreHorizontalIcon, PauseIcon, PlayIcon, ShareIcon } from "lucide-react";
import SongArtwork from "@/components/SongArtwork";
import type { MusicPlaylistSource, MusicTrack } from "@/components/MusicPlayerProvider";
import type { PrivatePlaylist } from "@/lib/privatePlaylists";

type SortKey = "index" | "title" | "addedAt" | "duration";
type SortDirection = "asc" | "desc";

export interface PlaylistSongRow extends MusicTrack {
  addedAt?: string | null;
}

interface PlaylistSongTableProps {
  tracks: PlaylistSongRow[];
  currentTrackId?: string | null;
  isPlaying?: boolean;
  source?: MusicPlaylistSource | null;
  emptyText?: string;
  loading?: boolean;
  canReorder?: boolean;
  onPlayTrack: (track: PlaylistSongRow, tracks: PlaylistSongRow[], source?: MusicPlaylistSource | null) => void;
  onReorder?: (tracks: PlaylistSongRow[]) => void | Promise<void>;
  onRemove?: (track: PlaylistSongRow) => void | Promise<void>;
  onShare?: (track: PlaylistSongRow) => void;
  personalPlaylists?: PrivatePlaylist[];
  onAddToPlaylist?: (playlistId: string, track: PlaylistSongRow) => void | Promise<void>;
  allowRemove?: boolean;
  allowAddToPlaylist?: boolean;
  showActions?: boolean;
}

const formatDuration = (value?: number | null) => {
  if (!value || !Number.isFinite(value) || value <= 0) return "";
  const total = Math.floor(value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const formatAddedAt = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "2-digit" });
};

function PlaylistSubmenuIcon({ playlist }: { playlist: PrivatePlaylist }) {
  if (playlist.iconUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={playlist.iconUrl} alt="" className="playlist-song-table__submenu-icon" />
    );
  }

  return (
    <span className="playlist-song-table__submenu-icon playlist-song-table__submenu-icon--fallback">
      <LibraryIcon size={13} />
    </span>
  );
}

export default function PlaylistSongTable({
  tracks,
  currentTrackId,
  isPlaying = false,
  source,
  emptyText = "No hay canciones para reproducir.",
  loading = false,
  canReorder = false,
  onPlayTrack,
  onReorder,
  onRemove,
  onShare,
  personalPlaylists = [],
  onAddToPlaylist,
  allowRemove = false,
  allowAddToPlaylist = true,
  showActions = true,
}: PlaylistSongTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "index", direction: "desc" });
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ trackId: string; x: number; y: number } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const reorderEnabled = canReorder && sort.key === "index" && sort.direction === "desc";

  const sortedTracks = useMemo(() => {
    const indexed = tracks.map((track, index) => ({ track, index }));
    if (sort.key === "index") {
      return sort.direction === "asc" ? tracks : [...tracks].reverse();
    }

    indexed.sort((a, b) => {
      let result = 0;
      if (sort.key === "title") {
        result = a.track.name.localeCompare(b.track.name, "es", { sensitivity: "base" });
      } else if (sort.key === "addedAt") {
        const aTime = a.track.addedAt ? new Date(a.track.addedAt).getTime() : 0;
        const bTime = b.track.addedAt ? new Date(b.track.addedAt).getTime() : 0;
        result = aTime - bTime;
      } else if (sort.key === "duration") {
        result = (a.track.duration || 0) - (b.track.duration || 0);
      }

      if (result === 0) result = a.index - b.index;
      return sort.direction === "asc" ? result : -result;
    });

    return indexed.map((item) => item.track);
  }, [sort, tracks]);
  const playbackTracks = useMemo(() => [...tracks].reverse(), [tracks]);

  const requestSort = (key: SortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  const sortIcon = (key: SortKey) => {
    if (sort.key !== key) return null;
    return sort.direction === "asc" ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />;
  };

  const handleDrop = async (targetId: string) => {
    if (!draggedId || draggedId === targetId || !reorderEnabled || !onReorder) {
      setDraggedId(null);
      return;
    }

    const visibleOrder = sort.direction === "desc" ? [...tracks].reverse() : [...tracks];
    const from = visibleOrder.findIndex((track) => track.id === draggedId);
    const to = visibleOrder.findIndex((track) => track.id === targetId);
    if (from < 0 || to < 0) {
      setDraggedId(null);
      return;
    }

    const nextVisible = [...visibleOrder];
    const [moved] = nextVisible.splice(from, 1);
    nextVisible.splice(to, 0, moved);
    const nextStoredOrder = sort.direction === "desc" ? nextVisible.reverse() : nextVisible;
    setDraggedId(null);
    await onReorder(nextStoredOrder);
  };

  const renderMenu = (track: PlaylistSongRow, fixedPosition?: { x: number; y: number }) => (
    <div
      className={`playlist-song-table__menu ${fixedPosition ? "playlist-song-table__menu--fixed" : ""}`}
      style={fixedPosition ? { left: fixedPosition.x, top: fixedPosition.y } : undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event) => event.stopPropagation()}
      onMouseLeave={() => {
        if (fixedPosition) setContextMenu(null);
      }}
    >
      {allowRemove && onRemove && (
        <button type="button" className="playlist-song-table__menu-item playlist-song-table__menu-item--danger" onClick={() => { setOpenMenuId(null); setContextMenu(null); onRemove(track); }}>
          Quitar de playlist
        </button>
      )}
      {allowAddToPlaylist && (
        <div className="playlist-song-table__menu-item playlist-song-table__menu-item--submenu">
          <span>Añadir a playlist</span>
          <div className="playlist-song-table__submenu">
            {personalPlaylists.length === 0 || !onAddToPlaylist ? (
              <span className="playlist-song-table__submenu-empty">Sin playlists propias</span>
            ) : (
              personalPlaylists.map((playlist) => (
                <button
                  key={playlist.id}
                  type="button"
                  onClick={() => {
                    setOpenMenuId(null);
                    setContextMenu(null);
                    onAddToPlaylist(playlist.id, track);
                  }}
                >
                  <PlaylistSubmenuIcon playlist={playlist} />
                  <span>{playlist.nombre}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
      {onShare && (
        <button type="button" className="playlist-song-table__menu-item" onClick={() => { setOpenMenuId(null); setContextMenu(null); onShare(track); }}>
          <ShareIcon size={14} /> Compartir
        </button>
      )}
    </div>
  );

  if (loading) {
    return <p className="playlist-admin__empty">Cargando canciones...</p>;
  }

  if (tracks.length === 0) {
    return <p className="playlist-admin__empty">{emptyText}</p>;
  }

  return (
    <div className="playlist-song-table" onMouseLeave={() => setOpenMenuId(null)}>
      <div className="playlist-song-table__header">
        <button type="button" onClick={() => requestSort("index")}>
          # {sortIcon("index")}
        </button>
        <button type="button" onClick={() => requestSort("title")}>
          Título {sortIcon("title")}
        </button>
        <button type="button" onClick={() => requestSort("addedAt")}>
          Fecha añadida {sortIcon("addedAt")}
        </button>
        <button type="button" onClick={() => requestSort("duration")}>
          Duración {sortIcon("duration")}
        </button>
        {showActions && <span>Acciones</span>}
      </div>

      {sortedTracks.map((track, visibleIndex) => {
        const realIndex = tracks.findIndex((item) => item.id === track.id);
        const active = currentTrackId === track.id;
        const menuOpen = openMenuId === track.id;

        return (
          <div
            key={track.id}
            className={`playlist-song-table__row ${active ? "playlist-song-table__row--active" : ""} ${draggedId === track.id ? "playlist-song-table__row--dragging" : ""}`}
            draggable={reorderEnabled}
            onDragStart={(event) => {
              if (!reorderEnabled) return;
              setDraggedId(track.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (reorderEnabled) event.preventDefault();
            }}
            onDrop={() => handleDrop(track.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              setOpenMenuId(null);
              setContextMenu({ trackId: track.id, x: event.clientX, y: event.clientY });
            }}
            onClick={() => {
              setContextMenu(null);
              onPlayTrack(track, playbackTracks, source);
            }}
          >
            <div className="playlist-song-table__index">
              {reorderEnabled ? <GripVerticalIcon size={16} className="playlist-song-table__grip" /> : null}
              <span className="playlist-song-table__index-number">
                <span className="playlist-song-table__num">{sort.key === "index" ? realIndex + 1 : visibleIndex + 1}</span>
                <span className="playlist-song-table__play">
                  {active && isPlaying ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
                </span>
              </span>
            </div>

            <div className="playlist-song-table__title-cell">
              <SongArtwork src={track.iconUrl} alt={track.name} />
              <div className="playlist-song-table__song-text">
                <span className="playlist-song-table__song-title">{track.name}</span>
                {track.variantes && track.variantes.length > 0 && (
                  <span className="playlist-song-table__song-meta">{track.variantes.join(", ")}</span>
                )}
              </div>
            </div>

            <div className="playlist-song-table__muted">{formatAddedAt(track.addedAt)}</div>
            <div className="playlist-song-table__muted playlist-song-table__duration">{formatDuration(track.duration)}</div>

            {showActions && (
              <div className="playlist-song-table__actions" onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  className="playlist-song-table__menu-btn"
                  onClick={() => setOpenMenuId((current) => current === track.id ? null : track.id)}
                  title="Acciones"
                >
                  <MoreHorizontalIcon size={18} />
                </button>

                {menuOpen && renderMenu(track)}
              </div>
            )}
          </div>
        );
      })}
      {contextMenu && (() => {
        const track = tracks.find((item) => item.id === contextMenu.trackId);
        if (!track || typeof document === "undefined") return null;
        return createPortal(
          renderMenu(track, { x: contextMenu.x, y: contextMenu.y }),
          document.body
        );
      })()}
    </div>
  );
}
