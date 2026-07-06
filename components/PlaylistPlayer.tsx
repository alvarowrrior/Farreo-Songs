"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { onAuthStateChanged, type User } from "firebase/auth";
import { HeartIcon, LibraryIcon, MoreHorizontalIcon, PauseIcon, PlayIcon, ShareIcon } from "lucide-react";
import { useMusicPlayer, type MusicPlaylistSource } from "@/components/MusicPlayerProvider";
import PlaylistSongTable, { type PlaylistSongRow } from "@/components/PlaylistSongTable";
import { auth } from "@/lib/firebase";
import {
  countGlobalPlaylistFollowers,
  followGlobalPlaylist,
  isFollowingGlobalPlaylist,
  unfollowGlobalPlaylist,
} from "@/lib/globalPlaylistFollows";
import {
  addSongToPrivatePlaylist,
  listOwnPrivatePlaylists,
  type PrivatePlaylist,
} from "@/lib/privatePlaylists";
import { useHiddenSongs } from "@/lib/useHiddenSongs";
import { getMediaUrl, MUSIC_API_URL, type ApiSong } from "@/lib/radioApi";

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

const mapSongToTrack = (song: ApiSong): PlaylistSongRow => ({
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
  addedAt: song.addedAt,
  createdAt: song.createdAt,
});

const getPlaybackOrder = (tracks: PlaylistSongRow[]) => [...tracks].reverse();

export default function PlaylistPlayer({ playlistId, songId }: PlaylistPlayerProps) {
  const { currentSource, currentTrack, isPlaying, loadQueue, playQueue, togglePlayPause, toggleTrack } = useMusicPlayer();
  const { isVisible, loading: hiddenLoading } = useHiddenSongs();
  const [playlist, setPlaylist] = useState<PlaylistSongRow[]>([]);
  const [playlistTitle, setPlaylistTitle] = useState("");
  const [playlistIcon, setPlaylistIcon] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareSongTitle, setShareSongTitle] = useState("");
  const [shareSongLink, setShareSongLink] = useState("");
  const [shareInternalLink, setShareInternalLink] = useState("");
  const [copiedLink, setCopiedLink] = useState<"normal" | "internal" | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followersCount, setFollowersCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [personalPlaylists, setPersonalPlaylists] = useState<PrivatePlaylist[]>([]);

  const source = useMemo<MusicPlaylistSource | null>(() => {
    if (playlistId) {
      return { id: playlistId, name: playlistTitle || playlistId, type: "global" };
    }
    if (songId && playlist[0]) {
      return { id: playlist[0].id, name: "Canción suelta", type: "song" };
    }
    return null;
  }, [playlist, playlistId, playlistTitle, songId]);

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
    if (!user) {
      setPersonalPlaylists([]);
      return;
    }

    listOwnPrivatePlaylists(user.uid)
      .then(setPersonalPlaylists)
      .catch(() => setPersonalPlaylists([]));
  }, [user]);

  useEffect(() => {
    if (hiddenLoading) return;

    const loadData = async () => {
      try {
        setLoading(true);
        setError(null);

        if (playlistId) {
          const plRes = await fetch(`${MUSIC_API_URL}/playlist/${encodeURIComponent(playlistId)}`);
          if (!plRes.ok) throw new Error("Error cargando la playlist. Quiza no existe.");
          const plData = (await plRes.json()) as ApiPlaylist;
          const tracks = plData.canciones.map(mapSongToTrack).filter((track) => isVisible(track.id));
          const nextSource: MusicPlaylistSource = {
            id: playlistId,
            name: plData.nombre || playlistId,
            type: "global",
          };

          setPlaylistTitle(plData.nombre || playlistId);
          setPlaylistIcon(plData.iconUrl || null);
          setPlaylist(tracks);
          loadQueue(getPlaybackOrder(tracks), nextSource);
          return;
        }

        if (songId) {
          const songsRes = await fetch(`${MUSIC_API_URL}/canciones`);
          if (!songsRes.ok) throw new Error("Error cargando base de datos de canciones.");
          const songsData = (await songsRes.json()) as ApiSong[];
          const dbSong = songsData.find((song) => song.id === songId);
          if (!dbSong || !isVisible(dbSong.id)) throw new Error("Canción no encontrada.");

          const tracks = [mapSongToTrack(dbSong)];
          const nextSource: MusicPlaylistSource = {
            id: dbSong.id,
            name: "Canción suelta",
            type: "song",
          };

          setPlaylistTitle("Reproduciendo");
          setPlaylistIcon(null);
          setPlaylist(tracks);
          loadQueue(getPlaybackOrder(tracks), nextSource);
          return;
        }

        throw new Error("No se especifico que reproducir.");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "No se pudo cargar la música.");
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [playlistId, songId, loadQueue, hiddenLoading, isVisible]);

  useEffect(() => {
    if (!playlistId) return;

    const loadFollowState = async () => {
      try {
        setFollowersCount(await countGlobalPlaylistFollowers(playlistId));
        setIsFollowing(user ? await isFollowingGlobalPlaylist(user.uid, playlistId) : false);
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
        await followGlobalPlaylist({ userId: user.uid, userEmail: user.email, playlistId });
        setIsFollowing(true);
        setFollowersCount((value) => value + 1);
        setMessage("Playlist añadida a tu librería.");
      }
      window.dispatchEvent(new Event("farreo:library-updated"));
    } catch {
      setMessage("No se pudo actualizar el seguimiento.");
    }
  };

  const sharePlaylist = () => {
    if (!playlistId) return;
    navigator.clipboard.writeText(`${window.location.origin}/playlist/${encodeURIComponent(playlistId)}`)
      .then(() => setMessage("Enlace copiado al portapapeles."))
      .catch(() => setMessage("No se pudo copiar el enlace."));
  };

  const shareSong = (track: PlaylistSongRow) => {
    setShareSongTitle(track.name);
    setShareSongLink(`${window.location.origin}/play?song=${encodeURIComponent(track.id)}`);
    setShareInternalLink(getMediaUrl(track.url));
    setCopiedLink(null);
    setShareModalOpen(true);
  };

  const addToPersonalPlaylist = async (targetPlaylistId: string, track: PlaylistSongRow) => {
    try {
      await addSongToPrivatePlaylist(targetPlaylistId, track.id);
      setMessage("Canción añadida a la playlist.");
      window.dispatchEvent(new Event("farreo:library-updated"));
    } catch {
      setMessage("No se pudo añadir la canción.");
    }
  };

  const playAll = () => {
    if (playlist.length === 0) return;
    playQueue(getPlaybackOrder(playlist), 0, source);
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

  return (
    <main className="playlist-admin">
      <div className="playlist-admin__content" style={{ paddingBottom: "120px" }}>
        <header className="playlist-admin__header playlist-admin__header--playlist">
          <div className="playlist-admin__playlist-heading">
            {playlistIcon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={getMediaUrl(playlistIcon)} alt="" className="playlist-admin__playlist-icon playlist-admin__playlist-icon--hero" />
            ) : (
              <span className="playlist-admin__playlist-icon playlist-admin__playlist-icon--hero playlist-admin__playlist-icon--fallback">
                <LibraryIcon size={28} />
              </span>
            )}
            <div className="playlist-admin__playlist-heading-content">
              <h1 className="playlist-admin__title">{playlistId ? playlistTitle || playlistId : "Reproduciendo"}</h1>
              <p className="playlist-admin__subtitle">
                {playlist.length} canciones{playlistId ? ` · ${followersCount} seguidores` : ""}
              </p>
              <div className="playlist-admin__header-actions playlist-admin__header-actions--compact" onMouseLeave={() => setMenuOpen(false)}>
                <button type="button" onClick={handleMainPlay} className="playlist-admin__round-play" title={isCurrentSource && isPlaying ? "Pausar playlist" : "Reproducir playlist"}>
                  {isCurrentSource && isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
                </button>
                {playlistId && (
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
                        <button type="button" onClick={sharePlaylist} title="Compartir"><ShareIcon size={15} /><span>Compartir</span></button>
                        <button type="button" onClick={toggleFollow} title={isFollowing ? "Dejar de seguir" : "Seguir"}>
                          <HeartIcon
                            size={15}
                            fill={isFollowing ? "currentColor" : "none"}
                            style={isFollowing ? { color: "#ff4b6b" } : undefined}
                          />
                          <span>{isFollowing ? "Dejar de seguir" : "Seguir"}</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        {message && (
          <div className="playlist-admin__message playlist-admin__message--success">
            {message}
          </div>
        )}

        <section className="playlist-admin__list">
          <PlaylistSongTable
            tracks={playlist}
            currentTrackId={currentTrack?.id}
            isPlaying={isPlaying}
            source={source}
            loading={loading}
            onPlayTrack={(track, list, activeSource) => toggleTrack(track, list, activeSource)}
            onShare={shareSong}
            personalPlaylists={personalPlaylists}
            onAddToPlaylist={addToPersonalPlaylist}
            allowRemove={false}
            allowAddToPlaylist
          />

          {songId && playlist[0] && (
            <button
              className="playlist-admin__upload-btn"
              onClick={() => toggleTrack(playlist[0], getPlaybackOrder(playlist), source)}
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
              <button onClick={() => setShareModalOpen(false)} className="playlist-admin__btn-cancel-small">x</button>
            </div>

            <p style={{ fontSize: "0.95rem", color: "#b3b3b3", marginBottom: "1.5rem" }}>
              Canción: <strong style={{ color: "#fff" }}>{shareSongTitle}</strong>
            </p>

            <div className="playlist-admin__upload-form-group" style={{ marginBottom: "1.2rem" }}>
              <label className="playlist-admin__upload-form-label">Link de la canción</label>
              <div className="playlist-admin__upload-form-row">
                <input type="text" readOnly value={shareSongLink} className="playlist-admin__upload-form-input" style={{ background: "rgba(255, 255, 255, 0.05)" }} />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(shareSongLink).then(() => {
                      setCopiedLink("normal");
                      setTimeout(() => setCopiedLink(null), 2000);
                    });
                  }}
                  className="playlist-admin__upload-form-add"
                  style={{ background: copiedLink === "normal" ? "#fff" : "#1ed760", color: "#000", fontWeight: "bold", minWidth: "80px" }}
                >
                  {copiedLink === "normal" ? "Copiado!" : "Copiar"}
                </button>
              </div>
            </div>

            <div className="playlist-admin__upload-form-group" style={{ marginBottom: "1.5rem" }}>
              <label className="playlist-admin__upload-form-label">Link interno (MP3 real)</label>
              <div className="playlist-admin__upload-form-row">
                <input type="text" readOnly value={shareInternalLink} className="playlist-admin__upload-form-input" style={{ background: "rgba(255, 255, 255, 0.05)" }} />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(shareInternalLink).then(() => {
                      setCopiedLink("internal");
                      setTimeout(() => setCopiedLink(null), 2000);
                    });
                  }}
                  className="playlist-admin__upload-form-add"
                  style={{ background: copiedLink === "internal" ? "#fff" : "#1ed760", color: "#000", fontWeight: "bold", minWidth: "80px" }}
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
