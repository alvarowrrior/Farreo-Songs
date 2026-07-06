"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  GlobeIcon,
  LibraryIcon,
  LockIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  ShareIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import { auth } from "@/lib/firebase";
import {
  addSongToPrivatePlaylist,
  deletePrivatePlaylist,
  getPrivatePlaylist,
  listOwnPrivatePlaylists,
  removeSongFromPrivatePlaylist,
  reorderPrivatePlaylistSongs,
  updatePrivatePlaylist,
  type PrivatePlaylist,
  type PrivatePlaylistVisibility,
} from "@/lib/privatePlaylists";
import { useHiddenSongs } from "@/lib/useHiddenSongs";
import { useMusicPlayer, type MusicPlaylistSource } from "@/components/MusicPlayerProvider";
import PlaylistSongTable, { type PlaylistSongRow } from "@/components/PlaylistSongTable";
import SongArtwork from "@/components/SongArtwork";
import { getMediaUrl, MUSIC_API_URL, type ApiSong } from "@/lib/radioApi";

type Notice = {
  type: "success" | "error";
  text: string;
  action?: "make-public";
} | null;

const mapSongToTrack = (song: ApiSong, addedAt?: string | null): PlaylistSongRow => ({
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

const getPlaybackOrder = (tracks: PlaylistSongRow[]) => [...tracks].reverse();

export default function PrivatePlaylistPlayer({ playlistId }: { playlistId: string }) {
  const router = useRouter();
  const { currentSource, currentTrack, isPlaying, loadQueue, playQueue, stop, togglePlayPause, toggleTrack } = useMusicPlayer();
  const { isVisible, loading: hiddenLoading } = useHiddenSongs();
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [playlist, setPlaylist] = useState<PrivatePlaylist | null>(null);
  const [tracks, setTracks] = useState<PlaylistSongRow[]>([]);
  const [allSongs, setAllSongs] = useState<PlaylistSongRow[]>([]);
  const [personalPlaylists, setPersonalPlaylists] = useState<PrivatePlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<Notice>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const [showSongPicker, setShowSongPicker] = useState(false);
  const [songPickerPosition, setSongPickerPosition] = useState<{ left: number; top: number } | null>(null);
  const [songSearchQuery, setSongSearchQuery] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorName, setEditorName] = useState("");
  const [editorIconPreview, setEditorIconPreview] = useState("");
  const [editorVisibility, setEditorVisibility] = useState<PrivatePlaylistVisibility>("private");
  const [saving, setSaving] = useState(false);

  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareSongTitle, setShareSongTitle] = useState("");
  const [shareSongLink, setShareSongLink] = useState("");
  const [shareInternalLink, setShareInternalLink] = useState("");
  const [copiedLink, setCopiedLink] = useState<"normal" | "internal" | null>(null);

  const isOwner = Boolean(user?.uid && playlist?.ownerId === user.uid);

  const source = useMemo<MusicPlaylistSource | null>(() => {
    if (!playlist) return null;
    return { id: playlist.id, name: playlist.nombre, type: "private" };
  }, [playlist]);

  useEffect(() => {
    if (!auth) {
      setAuthReady(true);
      return;
    }

    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) {
      setPersonalPlaylists([]);
      return;
    }

    listOwnPrivatePlaylists(user.uid)
      .then(setPersonalPlaylists)
      .catch(() => setPersonalPlaylists([]));
  }, [user]);

  const fetchAllSongs = async () => {
    const res = await fetch(`${MUSIC_API_URL}/canciones`);
    if (!res.ok) throw new Error("No se pudieron cargar las canciones.");
    const songs = (await res.json()) as ApiSong[];
    return songs.map((song) => mapSongToTrack(song)).filter((song) => isVisible(song.id));
  };

  const loadSongsForPlaylist = async (pl: PrivatePlaylist) => {
    const mapped = await fetchAllSongs();
    const byId = new Map(mapped.map((song) => [song.id, song]));
    const entries = pl.songEntries.length > 0
      ? pl.songEntries
      : pl.songIds.map((songId) => ({ songId, addedAt: null }));
    const playlistTracks: PlaylistSongRow[] = [];
    entries.forEach((entry) => {
      const song = byId.get(entry.songId);
      if (song) playlistTracks.push({ ...song, addedAt: entry.addedAt });
    });

    setAllSongs(mapped);
    setTracks(playlistTracks);
    loadQueue(getPlaybackOrder(playlistTracks), { id: pl.id, name: pl.nombre, type: "private" });
  };

  const loadPlaylist = async () => {
    const pl = await getPrivatePlaylist(playlistId);
    if (!pl) throw new Error("Playlist no encontrada.");

    const owner = user?.uid === pl.ownerId;
    setPlaylist(pl);

    if (pl.visibility !== "public" && !owner) {
      setTracks([]);
      loadQueue([]);
      return;
    }

    await loadSongsForPlaylist(pl);
  };

  useEffect(() => {
    if (!authReady || hiddenLoading) return;

    const load = async () => {
      try {
        setLoading(true);
        await loadPlaylist();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "No se pudo cargar la playlist.");
      } finally {
        setLoading(false);
      }
    };

    load();
    // loadPlaylist needs latest auth state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, hiddenLoading, playlistId, user?.uid]);

  const filteredPickerSongs = useMemo(() => {
    const currentIds = new Set(tracks.map((track) => track.id));
    const q = songSearchQuery.trim().toLowerCase();
    return allSongs.filter((song) => {
      if (currentIds.has(song.id)) return false;
      if (!q) return true;
      return song.name.toLowerCase().includes(q) ||
        Boolean(song.variantes?.some((variant) => variant.toLowerCase().includes(q)));
    });
  }, [allSongs, songSearchQuery, tracks]);

  const openEditor = (forcePublic = false) => {
    if (!playlist) return;
    setEditorName(playlist.nombre);
    setEditorIconPreview(playlist.iconUrl || "");
    setEditorVisibility(forcePublic ? "public" : playlist.visibility);
    setEditorOpen(true);
    setMenuOpen(false);
  };

  const handleIconChange = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMessage({ type: "error", text: "El icono debe ser una imagen." });
      return;
    }
    if (file.size > 750 * 1024) {
      setMessage({ type: "error", text: "El icono debe pesar menos de 750 KB." });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setEditorIconPreview(String(reader.result || ""));
    reader.readAsDataURL(file);
  };

  const saveEditor = async () => {
    if (!playlist || !editorName.trim()) return;
    setSaving(true);
    try {
      await updatePrivatePlaylist(playlist.id, {
        nombre: editorName.trim(),
        iconUrl: editorIconPreview || null,
        visibility: editorVisibility,
      });
      const updated = {
        ...playlist,
        nombre: editorName.trim(),
        iconUrl: editorIconPreview || null,
        visibility: editorVisibility,
      };
      setPlaylist(updated);
      loadQueue(getPlaybackOrder(tracks), { id: updated.id, name: updated.nombre, type: "private" });
      setEditorOpen(false);
      setMessage({ type: "success", text: "Playlist actualizada." });
      window.dispatchEvent(new Event("farreo:library-updated"));
    } catch {
      setMessage({ type: "error", text: "No se pudo guardar la playlist." });
    } finally {
      setSaving(false);
    }
  };

  const placeSongPicker = (anchor?: HTMLElement | null) => {
    if (!anchor || typeof window === "undefined") {
      setSongPickerPosition(null);
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const pickerWidth = Math.min(360, window.innerWidth - 24);
    setSongPickerPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - pickerWidth - 12)),
      top: Math.max(12, rect.bottom + 8),
    });
  };

  const openSongPicker = async (event?: { currentTarget: HTMLElement }) => {
    placeSongPicker(event?.currentTarget ?? null);
    try {
      if (allSongs.length === 0) setAllSongs(await fetchAllSongs());
      setSongSearchQuery("");
      setShowSongPicker(true);
      setMenuOpen(false);
    } catch {
      setMessage({ type: "error", text: "No se pudo cargar la lista de canciones." });
    }
  };

  const addSong = async (song: PlaylistSongRow) => {
    if (!playlist) return;
    try {
      await addSongToPrivatePlaylist(playlist.id, song.id);
      const updated = await getPrivatePlaylist(playlist.id);
      if (updated) {
        setPlaylist(updated);
        await loadSongsForPlaylist(updated);
      }
      setMessage({ type: "success", text: `"${song.name}" añadida.` });
      window.dispatchEvent(new Event("farreo:library-updated"));
    } catch {
      setMessage({ type: "error", text: "No se pudo añadir la canción." });
    }
  };

  const removeSong = async (song: PlaylistSongRow) => {
    if (!playlist) return;
    try {
      await removeSongFromPrivatePlaylist(playlist.id, song.id);
      const updated = await getPrivatePlaylist(playlist.id);
      const nextTracks = tracks.filter((track) => track.id !== song.id);
      if (updated) setPlaylist(updated);
      setTracks(nextTracks);
      loadQueue(getPlaybackOrder(nextTracks), updated ? { id: updated.id, name: updated.nombre, type: "private" } : source);
      if (currentTrack?.id === song.id) stop();
      setMessage({ type: "success", text: `"${song.name}" quitada.` });
      window.dispatchEvent(new Event("farreo:library-updated"));
    } catch {
      setMessage({ type: "error", text: "No se pudo quitar la canción." });
    }
  };

  const reorderSongs = async (nextTracks: PlaylistSongRow[]) => {
    if (!playlist || !isOwner) return;
    try {
      setTracks(nextTracks);
      await reorderPrivatePlaylistSongs(playlist.id, nextTracks.map((track) => track.id));
      loadQueue(getPlaybackOrder(nextTracks), source);
      const updated = await getPrivatePlaylist(playlist.id);
      if (updated) setPlaylist(updated);
    } catch {
      setMessage({ type: "error", text: "No se pudo guardar el nuevo orden." });
      await loadPlaylist();
    }
  };

  const addTrackToAnotherPlaylist = async (targetPlaylistId: string, song: PlaylistSongRow) => {
    try {
      await addSongToPrivatePlaylist(targetPlaylistId, song.id);
      setMessage({ type: "success", text: "Canción añadida a la playlist." });
      window.dispatchEvent(new Event("farreo:library-updated"));
    } catch {
      setMessage({ type: "error", text: "No se pudo añadir la canción." });
    }
  };

  const sharePlaylist = () => {
    if (!playlist) return;
    if (playlist.visibility !== "public") {
      setMessage({ type: "error", text: "No puedes compartir una playlist privada.", action: "make-public" });
      return;
    }

    navigator.clipboard.writeText(`${window.location.origin}/user-playlist/${encodeURIComponent(playlist.id)}`)
      .then(() => setMessage({ type: "success", text: "Enlace copiado al portapapeles." }))
      .catch(() => setMessage({ type: "error", text: "No se pudo copiar el enlace." }));
  };

  const shareSong = (track: PlaylistSongRow) => {
    setShareSongTitle(track.name);
    setShareSongLink(`${window.location.origin}/play?song=${encodeURIComponent(track.id)}`);
    setShareInternalLink(getMediaUrl(track.url));
    setCopiedLink(null);
    setShareModalOpen(true);
  };

  const deletePlaylist = async () => {
    if (!playlist || !window.confirm(`Eliminar la playlist "${playlist.nombre}"?`)) return;
    await deletePrivatePlaylist(playlist.id);
    window.dispatchEvent(new Event("farreo:library-updated"));
    router.push("/");
  };

  const playAll = () => {
    if (tracks.length === 0) return;
    playQueue(getPlaybackOrder(tracks), 0, source);
  };

  const isCurrentSource = Boolean(source && currentSource?.id === source.id && currentSource.type === source.type);
  const handleMainPlay = () => {
    if (isCurrentSource) {
      togglePlayPause();
      return;
    }
    playAll();
  };

  if (error) {
    return (
      <main className="playlist-admin" style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ textAlign: "center", padding: "2rem", background: "#282828", borderRadius: "12px" }}>
          <h2>Oops...</h2>
          <p>{error}</p>
          <Link href="/" style={{ display: "inline-block", marginTop: "1rem", color: "#1ed760" }}>Ir al inicio</Link>
        </div>
      </main>
    );
  }

  if (!loading && playlist && playlist.visibility !== "public" && !isOwner) {
    return (
      <main className="playlist-admin" style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ textAlign: "center", padding: "2rem", background: "#282828", borderRadius: "12px" }}>
          <LockIcon size={38} />
          <h2>Playlist bloqueada</h2>
          <p>Esta playlist es privada y solo puede verla su creador.</p>
          <Link href="/" style={{ display: "inline-block", marginTop: "1rem", color: "#1ed760" }}>Ir al inicio</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="playlist-admin">
      <div className="playlist-admin__content" style={{ paddingBottom: "120px" }}>
        <header className="playlist-admin__header playlist-admin__header--playlist">
          <div className="playlist-admin__playlist-heading">
            {playlist?.iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={playlist.iconUrl} alt="" className="playlist-admin__playlist-icon playlist-admin__playlist-icon--hero" />
            ) : (
              <span className="playlist-admin__playlist-icon playlist-admin__playlist-icon--hero playlist-admin__playlist-icon--fallback">
                <LibraryIcon size={28} />
              </span>
            )}
            <div className="playlist-admin__playlist-heading-content">
              <h1 className="playlist-admin__title">{playlist?.nombre || "Playlist propia"}</h1>
              <p className="playlist-admin__subtitle">
                {tracks.length} canciones · {playlist?.visibility === "public" ? "Pública" : "Privada"}
              </p>
              <div className="playlist-admin__header-actions playlist-admin__header-actions--compact" onMouseLeave={() => setMenuOpen(false)}>
                <button type="button" onClick={handleMainPlay} className="playlist-admin__round-play" title={isCurrentSource && isPlaying ? "Pausar playlist" : "Reproducir playlist"}>
                  {isCurrentSource && isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
                </button>
                <div className={`playlist-admin__header-menu-wrap ${menuOpen ? "playlist-admin__header-menu-wrap--open" : ""}`}>
                  <button
                    type="button"
                    className={`playlist-admin__dots-btn ${menuOpen ? "playlist-admin__dots-btn--open" : ""}`}
                    onClick={() => setMenuOpen((value) => !value)}
                    title="Opciones de playlist"
                  >
                    <MoreHorizontalIcon size={20} />
                  </button>
                  {menuOpen && (
                    <div className="playlist-admin__playlist-menu">
                      {isOwner && <button type="button" onClick={(event) => openSongPicker(event)} title="Añadir canción"><PlusIcon size={15} /><span>Añadir canción</span></button>}
                      <button type="button" onClick={sharePlaylist} title="Compartir"><ShareIcon size={15} /><span>Compartir</span></button>
                      {isOwner && <button type="button" onClick={() => openEditor()} title="Editar"><PencilIcon size={15} /><span>Editar</span></button>}
                      {isOwner && <button type="button" className="playlist-admin__playlist-menu-danger" onClick={() => void deletePlaylist()} title="Borrar"><TrashIcon size={15} /><span>Borrar</span></button>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </header>

        {message && (
          <div className={`playlist-admin__message playlist-admin__message--${message.type}`}>
            {message.text}
            {message.action === "make-public" && (
              <>
                {" "}
                <button className="playlist-admin__message-action" onClick={() => openEditor(true)}>
                  Hacer Pública
                </button>
              </>
            )}
          </div>
        )}

        <section className="playlist-admin__list">
          <PlaylistSongTable
            tracks={tracks}
            currentTrackId={currentTrack?.id}
            isPlaying={isPlaying}
            source={source}
            loading={loading}
            canReorder={isOwner}
            onReorder={reorderSongs}
            onPlayTrack={(track, list, activeSource) => toggleTrack(track, list, activeSource)}
            onRemove={removeSong}
            onShare={shareSong}
            personalPlaylists={personalPlaylists.filter((item) => item.id !== playlist?.id)}
            onAddToPlaylist={addTrackToAnotherPlaylist}
            allowRemove={isOwner}
            allowAddToPlaylist
          />
        </section>
      </div>

      {showSongPicker && (
        <div
          className="playlist-admin__song-picker"
          style={songPickerPosition ? { left: songPickerPosition.left, top: songPickerPosition.top } : undefined}
        >
          <div className="playlist-admin__song-picker-header">
            <div className="playlist-admin__song-picker-search">
              <SearchIcon size={16} />
              <input
                type="text"
                value={songSearchQuery}
                onChange={(e) => setSongSearchQuery(e.target.value)}
                placeholder="Buscar canción..."
                className="playlist-admin__song-picker-input"
                autoFocus
              />
            </div>
            <button onClick={() => setShowSongPicker(false)} className="playlist-admin__btn-cancel-small">
              <XIcon size={18} />
            </button>
          </div>
          <div className="playlist-admin__song-picker-list">
            {filteredPickerSongs.length === 0 ? (
              <p className="playlist-admin__empty">No hay canciones disponibles para añadir.</p>
            ) : (
              filteredPickerSongs.map((song) => (
                <div key={song.id} className="playlist-admin__song-picker-item" onClick={() => addSong(song)}>
                  <SongArtwork src={song.iconUrl} alt={song.name} />
                  <div className="playlist-admin__song-picker-item-info">
                    <span className="playlist-admin__song-picker-item-name">{song.name}</span>
                    {song.variantes && song.variantes.length > 0 && (
                      <span className="playlist-admin__song-picker-item-tags">{song.variantes.join(", ")}</span>
                    )}
                  </div>
                  <PlusIcon size={18} className="playlist-admin__song-picker-item-add" />
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {editorOpen && playlist && (
        <div className="playlist-admin__modal-overlay" onClick={() => setEditorOpen(false)}>
          <div className="playlist-admin__modal" onClick={(e) => e.stopPropagation()}>
            <div className="playlist-admin__modal-header">
              <h3>Editar Playlist</h3>
              <button onClick={() => setEditorOpen(false)} className="playlist-admin__btn-cancel-small">x</button>
            </div>

            <div className="playlist-admin__upload-form-group">
              <label className="playlist-admin__upload-form-label">Nombre visible</label>
              <input
                type="text"
                value={editorName}
                onChange={(e) => setEditorName(e.target.value)}
                className="playlist-admin__upload-form-input"
                placeholder="Nombre de la playlist"
                autoFocus
              />
            </div>

            <div className="playlist-admin__upload-form-group">
              <label className="playlist-admin__upload-form-label">Icono</label>
              <div className="playlist-admin__playlist-icon-editor">
                <div className="playlist-admin__playlist-icon-preview">
                  {editorIconPreview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={editorIconPreview} alt="" />
                  ) : (
                    <LockIcon size={28} />
                  )}
                </div>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => handleIconChange(e.target.files?.[0] ?? null)}
                  className="playlist-admin__upload-form-input"
                />
              </div>
            </div>

            <div className="playlist-admin__upload-form-group">
              <label className="playlist-admin__upload-form-label">Visibilidad</label>
              <div className="playlist-admin__chips">
                <button
                  type="button"
                  className={`playlist-admin__chip ${editorVisibility === "private" ? "" : "playlist-admin__chip--muted"}`}
                  onClick={() => setEditorVisibility("private")}
                >
                  <LockIcon size={14} /> Privada
                </button>
                <button
                  type="button"
                  className={`playlist-admin__chip ${editorVisibility === "public" ? "" : "playlist-admin__chip--muted"}`}
                  onClick={() => setEditorVisibility("public")}
                >
                  <GlobeIcon size={14} /> Pública
                </button>
              </div>
            </div>

            <button onClick={saveEditor} disabled={saving} className="playlist-admin__upload-btn">
              {saving ? "Guardando..." : "Guardar Cambios"}
            </button>
          </div>
        </div>
      )}

      {shareModalOpen && (
        <div className="playlist-admin__modal-overlay" onClick={() => setShareModalOpen(false)}>
          <div className="playlist-admin__modal" onClick={(e) => e.stopPropagation()}>
            <div className="playlist-admin__modal-header">
              <h3>Compartir Canción</h3>
              <button onClick={() => setShareModalOpen(false)} className="playlist-admin__btn-cancel-small">x</button>
            </div>
            <p style={{ fontSize: "0.95rem", color: "#b3b3b3", marginBottom: "1.5rem" }}>
              Canción: <strong style={{ color: "#fff" }}>{shareSongTitle}</strong>
            </p>
            <div className="playlist-admin__upload-form-group" style={{ marginBottom: "1.2rem" }}>
              <label className="playlist-admin__upload-form-label">Link de la canción</label>
              <div className="playlist-admin__upload-form-row">
                <input type="text" readOnly value={shareSongLink} className="playlist-admin__upload-form-input" />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(shareSongLink).then(() => {
                      setCopiedLink("normal");
                      setTimeout(() => setCopiedLink(null), 2000);
                    });
                  }}
                  className="playlist-admin__upload-form-add"
                >
                  {copiedLink === "normal" ? "Copiado!" : "Copiar"}
                </button>
              </div>
            </div>
            <div className="playlist-admin__upload-form-group" style={{ marginBottom: "1.5rem" }}>
              <label className="playlist-admin__upload-form-label">Link interno (MP3 real)</label>
              <div className="playlist-admin__upload-form-row">
                <input type="text" readOnly value={shareInternalLink} className="playlist-admin__upload-form-input" />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(shareInternalLink).then(() => {
                      setCopiedLink("internal");
                      setTimeout(() => setCopiedLink(null), 2000);
                    });
                  }}
                  className="playlist-admin__upload-form-add"
                >
                  {copiedLink === "internal" ? "Copiado!" : "Copiar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
