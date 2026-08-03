"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { CalendarClockIcon, CopyIcon, Disc3Icon, HeartIcon, LibraryIcon, LockKeyholeIcon, MoreHorizontalIcon, PauseIcon, PlayIcon, Share2Icon, ShareIcon, SparklesIcon } from "lucide-react";
import { auth } from "@/lib/firebase";
import {
  followAlbum,
  getAlbum,
  revealAlbumTrack,
  touchAlbum,
  unfollowAlbum,
  type AlbumDetail,
  type AlbumTrackEntry,
} from "@/lib/albums";
import { getMediaUrl, type ApiSong } from "@/lib/radioApi";
import { formatPlaylistDuration } from "@/lib/playlistDuration";
import { useMusicPlayer, type MusicPlaylistSource, type MusicTrack } from "@/components/MusicPlayerProvider";
import SongArtwork from "@/components/SongArtwork";
import AlbumDiscBackdrop from "@/components/AlbumDiscBackdrop";
import { addSongToPrivatePlaylist, listOwnPrivatePlaylists, type PrivatePlaylist } from "@/lib/privatePlaylists";
import { createPortal } from "react-dom";

const mapSong = (song: ApiSong): MusicTrack => ({
  ...song,
  url: getMediaUrl(song.url),
  iconUrl: getMediaUrl(song.iconUrl),
  advancedCoverUrl: getMediaUrl(song.advancedCoverUrl),
});

const formatRelease = (value?: string | null) => {
  if (!value) return "Próximamente";
  return new Date(value).toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const countdown = (releaseAt: string | null | undefined, serverNow: number) => {
  if (!releaseAt) return "";
  const difference = Math.max(0, new Date(releaseAt).getTime() - serverNow);
  const seconds = Math.ceil(difference / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
};

function playRevealSound(volume: number) {
  if (volume <= 0 || typeof window === "undefined") return;
  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0, context.currentTime);
  gain.gain.linearRampToValueAtTime(Math.min(0.2, volume * 0.18), context.currentTime + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.9);
  gain.connect(context.destination);
  [392, 523.25, 783.99].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    oscillator.type = index === 2 ? "sine" : "triangle";
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(context.currentTime + index * 0.08);
    oscillator.stop(context.currentTime + 0.95);
  });
  window.setTimeout(() => void context.close(), 1200);
}

export default function AlbumPlayer({ albumId }: { albumId: string }) {
  const { currentSource, currentTrack, isPlaying, isShuffle, playQueue, togglePlayPause, toggleTrack, volume } = useMusicPlayer();
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(auth?.currentUser || null);
  const [clock, setClock] = useState(Date.now());
  const [revealing, setRevealing] = useState<{ entryId: string; variant: number } | null>(null);
  const [openMenu, setOpenMenu] = useState<{ entryId: string; x: number; y: number } | null>(null);
  const [shareSongTarget, setShareSongTarget] = useState<MusicTrack | null>(null);
  const [personalPlaylists, setPersonalPlaylists] = useState<PrivatePlaylist[]>([]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getAlbum(albumId);
      setAlbum(data);
      setClock(data.serverTime);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo cargar el álbum.");
    } finally {
      setLoading(false);
    }
  }, [albumId]);

  useEffect(() => { void load(); }, [load, user?.uid]);
  useEffect(() => auth ? onAuthStateChanged(auth, setUser) : undefined, []);
  useEffect(() => {
    if (!user) {
      setPersonalPlaylists([]);
      return;
    }
    void listOwnPrivatePlaylists(user.uid).then(setPersonalPlaylists).catch(() => setPersonalPlaylists([]));
  }, [user]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1000), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!album?.tracks.some(track => track.state === "scheduled" && track.releaseAt && new Date(track.releaseAt).getTime() <= clock)) return;
    void load();
  }, [album, clock, load]);
  useEffect(() => {
    if (album?.isFollowing && user) void touchAlbum(albumId).catch(() => undefined);
  }, [album?.isFollowing, albumId, user]);
  useEffect(() => {
    if (currentSource?.type !== "album" || currentSource.id !== albumId || !currentTrack?.albumEntryId || currentTrack.firstListenPending !== false) return;
    setAlbum((current) => current ? {
      ...current,
      tracks: current.tracks.map((entry) => entry.entryId === currentTrack.albumEntryId && entry.song
        ? { ...entry, song: { ...entry.song, firstListenPending: false } }
        : entry),
    } : current);
  }, [albumId, currentSource?.id, currentSource?.type, currentTrack?.albumEntryId, currentTrack?.firstListenPending]);
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  const source = useMemo<MusicPlaylistSource>(() => ({ id: albumId, name: album?.nombre || "Álbum", type: "album" }), [album?.nombre, albumId]);
  const playable = useMemo(() => album?.tracks
    .filter(entry => entry.song && (entry.state === "revealed" || entry.state === "normal"))
    .map(entry => mapSong(entry.song!))
    .reverse() || [], [album]);
  const active = currentSource?.type === "album" && currentSource.id === albumId;
  const duration = useMemo(() => playable.reduce((total, track) => total + (track.duration || 0), 0), [playable]);

  const reveal = async (entry: AlbumTrackEntry) => {
    if (revealing) return;
    try {
      const result = await revealAlbumTrack(albumId, entry.entryId);
      setRevealing({ entryId: entry.entryId, variant: result.variant });
      setAlbum((current) => current ? {
        ...current,
        tracks: current.tracks.map(track => track.entryId === entry.entryId ? {
          ...track,
          state: "revealed",
          song: result.song,
        } : track),
      } : current);
      playRevealSound(volume);
      window.setTimeout(() => {
        setRevealing(null);
      }, 1350);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "No se pudo revelar la pista.");
    }
  };

  const playAlbum = () => {
    if (active && currentTrack) {
      togglePlayPause();
      return;
    }
    if (playable.length === 0) {
      setMessage("Descubre primero una pista del álbum.");
      return;
    }
    playQueue(playable, isShuffle && playable.length > 1 ? Math.floor(Math.random() * playable.length) : 0, source);
  };

  const toggleFollow = async () => {
    if (!album) return;
    if (!user) {
      setMessage("Inicia sesión para seguir álbumes.");
      return;
    }
    try {
      if (album.isFollowing) await unfollowAlbum(albumId);
      else await followAlbum(albumId);
      setAlbum({
        ...album,
        isFollowing: !album.isFollowing,
        followerCount: Math.max(0, album.followerCount + (album.isFollowing ? -1 : 1)),
      });
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "No se pudo actualizar el seguimiento.");
    }
  };

  const copyShareLink = async (path: string) => {
    const url = `${window.location.origin}${path}`;
    await navigator.clipboard.writeText(url);
    setMessage("Enlace copiado.");
  };

  const playlistIcon = (playlist: PrivatePlaylist) => playlist.iconUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={playlist.iconUrl} alt="" className="playlist-song-table__submenu-icon" />
  ) : (
    <span className="playlist-song-table__submenu-icon playlist-song-table__submenu-icon--fallback"><LibraryIcon size={13} /></span>
  );

  const openSongMenu = (entryId: string, x: number, y: number) => setOpenMenu({
    entryId,
    x: Math.max(8, Math.min(x, window.innerWidth - 202)),
    y: Math.max(8, Math.min(y, window.innerHeight - 88)),
  });

  const renderSongMenu = (track: MusicTrack) => (
    <div
      className="playlist-song-table__menu playlist-song-table__menu--fixed"
      style={{ left: openMenu?.x, top: openMenu?.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      role="menu"
    >
      <div className="playlist-song-table__menu-item playlist-song-table__menu-item--submenu" role="menuitem">
        <span>Añadir a playlist</span>
        <div className="playlist-song-table__submenu" role="menu">
          {personalPlaylists.length === 0 ? (
            <span className="playlist-song-table__submenu-empty">Sin playlists propias</span>
          ) : personalPlaylists.map((playlist) => (
            <button
              key={playlist.id}
              type="button"
              onClick={() => {
                setOpenMenu(null);
                void addSongToPrivatePlaylist(playlist.id, track.id)
                  .then(() => setMessage(`Añadida a ${playlist.nombre}.`))
                  .catch(() => setMessage("No se pudo añadir la canción."));
              }}
            >
              {playlistIcon(playlist)}
              <span>{playlist.nombre}</span>
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="playlist-song-table__menu-item" onClick={() => { setOpenMenu(null); setShareSongTarget(track); }} role="menuitem">
        <ShareIcon size={14} /> Compartir
      </button>
    </div>
  );

  if (loading) return <main className="playlist-admin album-page album-page--loading"><SparklesIcon size={34} /><span>Preparando álbum...</span></main>;
  if (error || !album) return <main className="playlist-admin album-page album-page--loading"><p>{error || "Álbum no encontrado."}</p></main>;

  return (
    <main className={`playlist-admin album-page ${active && currentTrack ? "album-page--disc-active" : ""}`}>
      <AlbumDiscBackdrop
        artworkUrl={active && currentTrack ? currentTrack.iconUrl : album.iconUrl}
        isPlaying={Boolean(active && isPlaying)}
        visible={Boolean(active && currentTrack)}
      />
      <div className="playlist-admin__content album-page__content">
        <header className="playlist-admin__header playlist-admin__header--playlist album-page__hero">
          <div className="playlist-admin__playlist-heading">
            <SongArtwork src={getMediaUrl(album.iconUrl)} alt={album.nombre} className="playlist-admin__playlist-icon playlist-admin__playlist-icon--hero album-page__cover" />
            <div className="playlist-admin__playlist-heading-content">
              <span className="album-page__eyebrow">{album.revelationEnabled ? "Álbum en revelación" : "Álbum"}</span>
              <h1 className="playlist-admin__title">{album.nombre}</h1>
              <p className="playlist-admin__subtitle">
                {album.numCanciones} canciones{duration > 0 ? `, ${formatPlaylistDuration(playable)}` : ""} · {album.followerCount} seguidores
              </p>
              <div className="album-page__actions">
                <button type="button" className="playlist-admin__round-play" onClick={playAlbum} title={active && isPlaying ? "Pausar álbum" : "Reproducir álbum"}>
                  {active && isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button type="button" className={`album-page__utility ${album.isFollowing ? "album-page__utility--followed" : ""}`} onClick={toggleFollow}>
                  <HeartIcon fill={album.isFollowing ? "currentColor" : "none"} />
                  {album.isFollowing ? "Siguiendo" : "Seguir"}
                </button>
                <button type="button" className="album-page__utility" onClick={() => void copyShareLink(`/album/${encodeURIComponent(albumId)}`)}><Share2Icon /> Compartir</button>
              </div>
            </div>
          </div>
        </header>

        {message && <div className="playlist-admin__message">{message}</div>}

        <section className="album-track-list" aria-label={`Canciones de ${album.nombre}`}>
          {[...album.tracks].reverse().map((entry, index) => {
            const revealState = revealing?.entryId === entry.entryId ? revealing : null;
            if (entry.state === "scheduled") {
              return (
                <article key={entry.entryId} className="album-track album-track--locked">
                  <span className="album-track__number"><LockKeyholeIcon size={17} /></span>
                  <div className="album-track__mystery-art"><CalendarClockIcon /></div>
                  <div><strong>Estreno bloqueado</strong><small>{formatRelease(entry.releaseAt)} · {countdown(entry.releaseAt, clock)}</small></div>
                  <span className="album-track__seal"><LockKeyholeIcon size={14} /></span>
                </article>
              );
            }
            if (entry.state === "mystery") {
              return (
                <button
                  key={entry.entryId}
                  type="button"
                  className={`album-track album-track--mystery ${revealState ? `album-track--revealing album-track--reveal-${revealState.variant}` : ""}`}
                  onClick={() => void reveal(entry)}
                  disabled={Boolean(revealing)}
                >
                  <span className="album-track__number">{album.numCanciones - index}</span>
                  <span className="album-track__mystery-art"><Disc3Icon /></span>
                  <span className="album-track__mystery-copy"><strong>{revealState ? "Revelando..." : "Pista misteriosa"}</strong><small>{revealState ? "" : "Toca para descubrirla"}</small></span>
                  <span className="album-track__particles" aria-hidden="true"><i /><i /><i /><i /><i /></span>
                  <span className="album-track__seal"><i /></span>
                </button>
              );
            }

            if (!entry.song) return null;
            const track = mapSong(entry.song);
            const current = currentTrack?.albumEntryId === entry.entryId || (active && currentTrack?.id === track.id);
            return (
              <article key={entry.entryId} className={`album-track ${current ? "album-track--current" : ""} ${revealState ? `album-track--revealing album-track--reveal-${revealState.variant}` : ""}`} onClick={() => toggleTrack(track, playable, source)} onContextMenu={(event) => { event.preventDefault(); openSongMenu(entry.entryId, event.clientX, event.clientY); }}>
                <span className="album-track__number">{current && isPlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />}</span>
                <SongArtwork src={track.iconUrl} alt={track.name} className="album-track__art" />
                <div className="album-track__copy"><strong>{track.name}</strong>{track.variantes?.length ? <small>{track.variantes.join(", ")}</small> : null}</div>
                <span className="album-track__first-slot">{entry.song.firstListenPending && <span className="album-track__first">Primera escucha</span>}</span>
                <button type="button" className="album-track__more" onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); openSongMenu(entry.entryId, rect.left, rect.bottom); }}><MoreHorizontalIcon /></button>
                {revealState && (
                  <span className="album-track__reveal-overlay" aria-hidden="true">
                    <span className="album-track__mystery-art"><Disc3Icon /></span>
                    <span className="album-track__mystery-copy"><strong>Revelando...</strong></span>
                    <span className="album-track__particles"><i /><i /><i /><i /><i /></span>
                  </span>
                )}
              </article>
            );
          })}
        </section>
      </div>
      {openMenu && typeof document !== "undefined" && (() => {
        const entry = album.tracks.find((item) => item.entryId === openMenu.entryId);
        if (!entry?.song) return null;
        return createPortal(renderSongMenu(mapSong(entry.song)), document.body);
      })()}
      {shareSongTarget && (
        <div className="playlist-admin__modal-overlay" onClick={() => setShareSongTarget(null)}>
          <div className="playlist-admin__modal" onClick={(event) => event.stopPropagation()}>
            <div className="playlist-admin__modal-header"><h3>Compartir canción</h3><button type="button" className="playlist-admin__btn-cancel-small" onClick={() => setShareSongTarget(null)}>×</button></div>
            <p className="playlist-admin__modal-copy">Canción: <strong>{shareSongTarget.name}</strong></p>
            <label className="playlist-admin__upload-form-group">
              <span className="playlist-admin__upload-form-label">Enlace de Farreo</span>
              <div className="album-page__share-row"><input readOnly className="playlist-admin__upload-form-input" value={`${window.location.origin}/play?song=${encodeURIComponent(shareSongTarget.id)}`} /><button type="button" onClick={() => void copyShareLink(`/play?song=${encodeURIComponent(shareSongTarget.id)}`)}><CopyIcon size={16} /> Copiar</button></div>
            </label>
            <label className="playlist-admin__upload-form-group">
              <span className="playlist-admin__upload-form-label">Enlace directo al MP3</span>
              <div className="album-page__share-row"><input readOnly className="playlist-admin__upload-form-input" value={getMediaUrl(shareSongTarget.url)} /><button type="button" onClick={() => void navigator.clipboard.writeText(getMediaUrl(shareSongTarget.url)).then(() => setMessage("Enlace del MP3 copiado."))}><CopyIcon size={16} /> Copiar</button></div>
            </label>
          </div>
        </div>
      )}
    </main>
  );
}
