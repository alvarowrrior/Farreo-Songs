"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import Link from "next/link";
import { HeartIcon, PlayIcon, ShareIcon } from "lucide-react";
import { useMusicPlayer, type MusicPlaylistSource, type MusicTrack } from "@/components/MusicPlayerProvider";
import { auth } from "@/lib/firebase";
import {
  countGlobalPlaylistFollowers,
  followGlobalPlaylist,
  isFollowingGlobalPlaylist,
  unfollowGlobalPlaylist,
} from "@/lib/globalPlaylistFollows";

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

interface ApiPlaylist {
  id?: string;
  nombre?: string;
  iconUrl?: string | null;
  canciones: ApiSong[];
}

interface PlaylistPlayerProps {
  playlistId?: string;
  songId?: string;
}

export default function PlaylistPlayer({ playlistId, songId }: PlaylistPlayerProps) {
  const { currentTrack, loadQueue, toggleTrack } = useMusicPlayer();
  const [playlist, setPlaylist] = useState<MusicTrack[]>([]);
  const [playlistTitle, setPlaylistTitle] = useState("");
  const [playlistIcon, setPlaylistIcon] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareSongTitle, setShareSongTitle] = useState("");
  const [shareSongLink, setShareSongLink] = useState("");
  const [shareInternalLink, setShareInternalLink] = useState("");
  const [copiedLink, setCopiedLink] = useState<'normal' | 'internal' | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followersCount, setFollowersCount] = useState(0);

  useEffect(() => {
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 2500);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        setError(null);

        if (playlistId) {
          const plRes = await fetch(`${TUNNEL_URL}/playlist/${encodeURIComponent(playlistId)}`);
          if (!plRes.ok) throw new Error("Error cargando la playlist. Quiza no existe.");
          const plData = (await plRes.json()) as ApiPlaylist;

          const tracks = plData.canciones.map((song) => ({
            id: song.id,
            name: song.name,
            url: getMediaUrl(song.url),
            variantes: song.variantes,
            lyricsSrt: song.lyricsSrt,
            lyricsUrl: song.lyricsUrl,
            lyricsFileName: song.lyricsFileName,
            duration: song.duration,
          }));
          const source: MusicPlaylistSource = {
            id: playlistId,
            name: plData.nombre || playlistId,
            type: "global",
          };

          setPlaylistTitle(plData.nombre || playlistId);
          setPlaylistIcon(plData.iconUrl || null);
          setPlaylist(tracks);
          loadQueue(tracks, source);
          return;
        }

        if (songId) {
          const songsRes = await fetch(`${TUNNEL_URL}/canciones`);
          if (!songsRes.ok) throw new Error("Error cargando base de datos de canciones.");
          const songsData = (await songsRes.json()) as ApiSong[];
          const dbSong = songsData.find((song) => song.id === songId);
          if (!dbSong) throw new Error("Cancion no encontrada.");

          const tracks = [{
            id: dbSong.id,
            name: dbSong.name,
            url: getMediaUrl(dbSong.url),
            variantes: dbSong.variantes,
            lyricsSrt: dbSong.lyricsSrt,
            lyricsUrl: dbSong.lyricsUrl,
            lyricsFileName: dbSong.lyricsFileName,
            duration: dbSong.duration,
          }];
          const source: MusicPlaylistSource = {
            id: dbSong.id,
            name: "Cancion suelta",
            type: "song",
          };

          setPlaylistTitle("Reproduciendo");
          setPlaylistIcon(null);
          setPlaylist(tracks);
          loadQueue(tracks, source);
          return;
        }

        throw new Error("No se especifico que reproducir.");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "No se pudo cargar la musica.");
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [playlistId, songId, loadQueue]);

  useEffect(() => {
    if (!playlistId) return;

    const loadFollowState = async () => {
      try {
        setFollowersCount(await countGlobalPlaylistFollowers(playlistId));
        if (user) {
          setIsFollowing(await isFollowingGlobalPlaylist(user.uid, playlistId));
        } else {
          setIsFollowing(false);
        }
      } catch {
        setFollowersCount(0);
        setIsFollowing(false);
      }
    };

    loadFollowState();
  }, [playlistId, user]);

  const toggleFollow = async () => {
    if (!playlistId) return;
    if (!user) {
      setMessage("Inicia sesión para seguir playlists.");
      return;
    }

    try {
      if (isFollowing) {
        await unfollowGlobalPlaylist(user.uid, playlistId);
        setIsFollowing(false);
        setFollowersCount((value) => Math.max(0, value - 1));
        setMessage("Has dejado de seguir esta playlist.");
      } else {
        await followGlobalPlaylist({
          userId: user.uid,
          userEmail: user.email,
          playlistId,
        });
        setIsFollowing(true);
        setFollowersCount((value) => value + 1);
        setMessage("Playlist añadida a tus playlists propias.");
      }
    } catch {
      setMessage("No se pudo actualizar el seguimiento.");
    }
  };

  const handleShare = (type: "song" | "playlist", identifier: string) => {
    if (type === "playlist") {
      const url = `${window.location.origin}/playlist/${encodeURIComponent(identifier)}`;
      navigator.clipboard.writeText(url)
        .then(() => setMessage("Enlace copiado al portapapeles."))
        .catch(() => setMessage("No se pudo copiar el enlace."));
    } else {
      const song = playlist.find(s => s.id === identifier);
      if (!song) return;

      const normalLink = `${window.location.origin}/play?song=${encodeURIComponent(song.id)}`;
      const internalLink = getMediaUrl(song.url);

      setShareSongTitle(song.name);
      setShareSongLink(normalLink);
      setShareInternalLink(internalLink);
      setShareModalOpen(true);
    }
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

  return (
    <main className="playlist-admin">
      <div className="playlist-admin__content" style={{ paddingBottom: "120px" }}>
        <header className="playlist-admin__header">
          <div className="playlist-admin__playlist-heading">
            {playlistIcon && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={getMediaUrl(playlistIcon)} alt="" className="playlist-admin__playlist-icon playlist-admin__playlist-icon--hero" />
            )}
            <div>
              <h1 className="playlist-admin__title">{playlistId ? playlistTitle || playlistId : "Reproduciendo"}</h1>
              <p className="playlist-admin__subtitle">
                {playlist.length} canciones{playlistId ? ` · ${followersCount} seguidores` : ""}
              </p>
            </div>
          </div>
          {playlistId && (
            <div className="playlist-admin__header-actions">
              <button
                onClick={() => handleShare("playlist", playlistId)}
                className="playlist-admin__btn-action"
                title="Compartir playlist"
              >
                <ShareIcon size={16} /> Compartir
              </button>
              <button
                onClick={toggleFollow}
                className="playlist-admin__btn-action"
                title={isFollowing ? "Dejar de seguir" : "Seguir playlist"}
              >
                <HeartIcon size={16} /> {isFollowing ? "Dejar de Seguir" : "Seguir"}
              </button>
            </div>
          )}
        </header>

        {message && (
          <div className="playlist-admin__message playlist-admin__message--success">
            {message}
          </div>
        )}

        <section className="playlist-admin__list">
          <div className="playlist-admin__list-header" style={{ gridTemplateColumns: "50px 1fr 80px" }}>
            <div>#</div>
            <div>Titulo</div>
            <div style={{ textAlign: "right" }}>Compartir</div>
          </div>

          {loading ? (
            <p className="playlist-admin__empty">Cargando musica...</p>
          ) : playlist.length === 0 ? (
            <p className="playlist-admin__empty">No hay canciones para reproducir.</p>
          ) : (
            playlist.map((track, i) => (
              <div
                key={track.id}
                className={`playlist-admin__item ${currentTrack?.id === track.id ? "playlist-admin__item--active" : ""}`}
                onClick={() => toggleTrack(track, playlist, playlistId ? {
                  id: playlistId,
                  name: playlistTitle || playlistId,
                  type: "global",
                } : undefined)}
                style={{ gridTemplateColumns: "50px 1fr 80px" }}
              >
                <div className="playlist-admin__item-index">
                  <span className="playlist-admin__item-play-icon"><PlayIcon size={14} /></span>
                  <span className="playlist-admin__item-num">{i + 1}</span>
                </div>
                <div className="playlist-admin__item-info">
                  <span className="playlist-admin__item-title">{track.name}</span>
                  {track.variantes && track.variantes.length > 0 && (
                    <span className="playlist-admin__item-date">
                      {track.variantes.join(", ")}
                    </span>
                  )}
                </div>
                <div className="playlist-admin__item-actions">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleShare("song", track.id);
                    }}
                    className="playlist-admin__item-edit"
                    title="Compartir cancion"
                  >
                    <ShareIcon size={16} />
                  </button>
                </div>
              </div>
            ))
          )}

          {songId && playlist[0] && (
            <button
              className="playlist-admin__upload-btn"
              onClick={() => toggleTrack(playlist[0], playlist, {
                id: playlist[0].id,
                name: "Cancion suelta",
                type: "song",
              })}
            >
              Reproducir
            </button>
          )}
        </section>
      </div>
      {shareModalOpen && (
        <div className="playlist-admin__modal-overlay" onClick={() => setShareModalOpen(false)}>
          <div className="playlist-admin__modal" onClick={(e) => e.stopPropagation()}>
            <div className="playlist-admin__modal-header">
              <h3>Compartir Canción</h3>
              <button onClick={() => setShareModalOpen(false)} className="playlist-admin__btn-cancel-small">✕</button>
            </div>
            
            <p style={{ fontSize: "0.95rem", color: "#b3b3b3", marginBottom: "1.5rem" }}>
              Canción: <strong style={{ color: "#fff" }}>{shareSongTitle}</strong>
            </p>

            <div className="playlist-admin__upload-form-group" style={{ marginBottom: "1.2rem" }}>
              <label className="playlist-admin__upload-form-label">Link de la canción</label>
              <div className="playlist-admin__upload-form-row">
                <input
                  type="text"
                  readOnly
                  value={shareSongLink}
                  className="playlist-admin__upload-form-input"
                  style={{ background: "rgba(255, 255, 255, 0.05)" }}
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(shareSongLink)
                      .then(() => {
                        setCopiedLink('normal');
                        setTimeout(() => setCopiedLink(null), 2000);
                      });
                  }}
                  className="playlist-admin__upload-form-add"
                  style={{ background: copiedLink === 'normal' ? '#fff' : '#1ed760', color: '#000', fontWeight: "bold", minWidth: "80px" }}
                >
                  {copiedLink === 'normal' ? 'Copiado!' : 'Copiar'}
                </button>
              </div>
            </div>

            <div className="playlist-admin__upload-form-group" style={{ marginBottom: "1.5rem" }}>
              <label className="playlist-admin__upload-form-label">Link interno (MP3 real)</label>
              <div className="playlist-admin__upload-form-row">
                <input
                  type="text"
                  readOnly
                  value={shareInternalLink}
                  className="playlist-admin__upload-form-input"
                  style={{ background: "rgba(255, 255, 255, 0.05)" }}
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(shareInternalLink)
                      .then(() => {
                        setCopiedLink('internal');
                        setTimeout(() => setCopiedLink(null), 2000);
                      });
                  }}
                  className="playlist-admin__upload-form-add"
                  style={{ background: copiedLink === 'internal' ? '#fff' : '#1ed760', color: '#000', fontWeight: "bold", minWidth: "80px" }}
                >
                  {copiedLink === 'internal' ? 'Copiado!' : 'Copiar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
