"use client";

import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import Link from "next/link";
import { GlobeIcon, LockIcon, PencilIcon, PlayIcon, PlusIcon, SearchIcon, ShareIcon, TrashIcon, XIcon } from "lucide-react";
import { auth } from "@/lib/firebase";
import {
  addSongToPrivatePlaylist,
  getPrivatePlaylist,
  removeSongFromPrivatePlaylist,
  updatePrivatePlaylist,
  type PrivatePlaylist,
  type PrivatePlaylistVisibility,
} from "@/lib/privatePlaylists";
import { useHiddenSongs } from "@/lib/useHiddenSongs";
import { useMusicPlayer, type MusicPlaylistSource, type MusicTrack } from "@/components/MusicPlayerProvider";

const TUNNEL_URL = "https://welite.ddns.net:3001";

const getMediaUrl = (url?: string | null) => {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  return `${TUNNEL_URL}${url}`;
};

interface ApiSong {
  id: string;
  name: string;
  url: string;
  variantes?: string[];
  lyricsSrt?: string | null;
  lyricsUrl?: string | null;
  lyricsFileName?: string | null;
  duration?: number | null;
}

type Notice = {
  type: "success" | "error";
  text: string;
  action?: "make-public";
} | null;

export default function PrivatePlaylistPlayer({ playlistId }: { playlistId: string }) {
  const { currentTrack, loadQueue, stop, toggleTrack } = useMusicPlayer();
  const { isVisible, loading: hiddenLoading } = useHiddenSongs();
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [playlist, setPlaylist] = useState<PrivatePlaylist | null>(null);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [allSongs, setAllSongs] = useState<MusicTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<Notice>(null);
  const [error, setError] = useState<string | null>(null);

  const [showSongPicker, setShowSongPicker] = useState(false);
  const [songSearchQuery, setSongSearchQuery] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorName, setEditorName] = useState("");
  const [editorIconPreview, setEditorIconPreview] = useState("");
  const [editorVisibility, setEditorVisibility] = useState<PrivatePlaylistVisibility>("private");
  const [saving, setSaving] = useState(false);

  const isOwner = Boolean(user?.uid && playlist?.ownerId === user.uid);

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

  const getPlaylistSource = (pl = playlist): MusicPlaylistSource | null => {
    if (!pl) return null;
    return {
      id: pl.id,
      name: pl.nombre,
      type: "private",
    };
  };

  const loadSongs = async (songIds: string[], source = getPlaylistSource()) => {
    const res = await fetch(`${TUNNEL_URL}/canciones`);
    if (!res.ok) throw new Error("No se pudieron cargar las canciones.");
    const songs = (await res.json()) as ApiSong[];
    const mapped = songs
      .map((song) => ({
        id: song.id,
        name: song.name,
        url: getMediaUrl(song.url),
        variantes: song.variantes,
        lyricsSrt: song.lyricsSrt,
        lyricsUrl: song.lyricsUrl,
        lyricsFileName: song.lyricsFileName,
        duration: song.duration,
      }))
      .filter((song) => isVisible(song.id));
    const ids = new Set(songIds);
    const playlistTracks = mapped.filter((song) => ids.has(song.id));
    setAllSongs(mapped);
    setTracks(playlistTracks);
    loadQueue(playlistTracks, source);
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

    await loadSongs(pl.songIds, getPlaylistSource(pl));
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
    // loadPlaylist depends on the latest auth user.
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
      loadQueue(tracks, getPlaylistSource(updated));
      setEditorOpen(false);
      setMessage({ type: "success", text: "Playlist actualizada." });
    } catch {
      setMessage({ type: "error", text: "No se pudo guardar la playlist." });
    } finally {
      setSaving(false);
    }
  };

  const openSongPicker = async () => {
    try {
      if (allSongs.length === 0) await loadSongs(playlist?.songIds || []);
      setSongSearchQuery("");
      setShowSongPicker(true);
    } catch {
      setMessage({ type: "error", text: "No se pudo cargar la lista de canciones." });
    }
  };

  const addSong = async (song: MusicTrack) => {
    if (!playlist) return;
    try {
      await addSongToPrivatePlaylist(playlist.id, song.id);
      const updated = { ...playlist, songIds: [...playlist.songIds, song.id] };
      const nextTracks = [...tracks, song];
      setPlaylist(updated);
      setTracks(nextTracks);
      loadQueue(nextTracks, getPlaylistSource(updated));
      setMessage({ type: "success", text: `"${song.name}" añadida.` });
    } catch {
      setMessage({ type: "error", text: "No se pudo añadir la canción." });
    }
  };

  const removeSong = async (song: MusicTrack) => {
    if (!playlist) return;
    try {
      await removeSongFromPrivatePlaylist(playlist.id, song.id);
      const updated = { ...playlist, songIds: playlist.songIds.filter((id) => id !== song.id) };
      const nextTracks = tracks.filter((track) => track.id !== song.id);
      setPlaylist(updated);
      setTracks(nextTracks);
      loadQueue(nextTracks, getPlaylistSource(updated));
      if (currentTrack?.id === song.id) stop();
      setMessage({ type: "success", text: `"${song.name}" quitada.` });
    } catch {
      setMessage({ type: "error", text: "No se pudo quitar la canción." });
    }
  };

  const sharePlaylist = () => {
    if (!playlist) return;
    if (playlist.visibility !== "public") {
      setMessage({
        type: "error",
        text: "No puedes compartir una playlist privada.",
        action: "make-public",
      });
      return;
    }

    navigator.clipboard.writeText(`${window.location.origin}/user-playlist/${encodeURIComponent(playlist.id)}`)
      .then(() => setMessage({ type: "success", text: "Enlace copiado al portapapeles." }))
      .catch(() => setMessage({ type: "error", text: "No se pudo copiar el enlace." }));
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
        <header className="playlist-admin__header">
          <div className="playlist-admin__playlist-heading">
            {playlist?.iconUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={playlist.iconUrl} alt="" className="playlist-admin__playlist-icon playlist-admin__playlist-icon--hero" />
            )}
            <div>
              <h1 className="playlist-admin__title">{playlist?.nombre || "Playlist propia"}</h1>
              <p className="playlist-admin__subtitle">
                {tracks.length} canciones · {playlist?.visibility === "public" ? "Pública" : "Privada"}
              </p>
            </div>
          </div>
          <div className="playlist-admin__header-actions">
            <button onClick={sharePlaylist} className="playlist-admin__btn-action" title="Compartir playlist">
              <ShareIcon size={16} /> Compartir
            </button>
            {isOwner && (
              <>
                <button onClick={() => openEditor()} className="playlist-admin__btn-action" title="Editar playlist">
                  <PencilIcon size={16} /> Editar
                </button>
                <button onClick={openSongPicker} className="playlist-admin__btn-action" title="Añadir canción">
                  <PlusIcon size={16} /> Añadir Canción
                </button>
              </>
            )}
          </div>
        </header>

        {message && (
          <div className={`playlist-admin__message playlist-admin__message--${message.type}`}>
            {message.text}
            {message.action === "make-public" && (
              <>
                {" "}
                <button
                  className="playlist-admin__message-action"
                  onClick={() => openEditor(true)}
                >
                  Hacer Pública
                </button>
              </>
            )}
          </div>
        )}

        <section className="playlist-admin__list">
          <div className="playlist-admin__list-header" style={{ gridTemplateColumns: isOwner ? "50px 1fr 80px" : "50px 1fr" }}>
            <div>#</div>
            <div>Título</div>
            {isOwner && <div style={{ textAlign: "right" }}>Acciones</div>}
          </div>
          {loading ? (
            <p className="playlist-admin__empty">Cargando playlist...</p>
          ) : tracks.length === 0 ? (
            <p className="playlist-admin__empty">No hay canciones para reproducir.</p>
          ) : (
            tracks.map((track, i) => (
              <div
                key={track.id}
                className={`playlist-admin__item ${currentTrack?.id === track.id ? "playlist-admin__item--active" : ""}`}
                onClick={() => toggleTrack(track, tracks, getPlaylistSource())}
                style={{ gridTemplateColumns: isOwner ? "50px 1fr 80px" : "50px 1fr" }}
              >
                <div className="playlist-admin__item-index">
                  <span className="playlist-admin__item-play-icon"><PlayIcon size={14} /></span>
                  <span className="playlist-admin__item-num">{i + 1}</span>
                </div>
                <div className="playlist-admin__item-info">
                  <span className="playlist-admin__item-title">{track.name}</span>
                  {track.variantes && track.variantes.length > 0 && (
                    <span className="playlist-admin__item-date">{track.variantes.join(", ")}</span>
                  )}
                </div>
                {isOwner && (
                  <div className="playlist-admin__item-actions">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSong(track);
                      }}
                      className="playlist-admin__item-delete"
                      title="Quitar de esta playlist"
                    >
                      <TrashIcon size={16} />
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </section>
      </div>

      {showSongPicker && (
        <div className="playlist-admin__song-picker">
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
                <div
                  key={song.id}
                  className="playlist-admin__song-picker-item"
                  onClick={() => addSong(song)}
                >
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
              <button onClick={() => setEditorOpen(false)} className="playlist-admin__btn-cancel-small">✕</button>
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
    </main>
  );
}
