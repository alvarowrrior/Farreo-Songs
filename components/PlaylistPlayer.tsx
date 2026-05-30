"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShareIcon } from "lucide-react";
import { useMusicPlayer, type MusicTrack } from "@/components/MusicPlayerProvider";

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
  const { currentTrack, playQueue, toggleTrack } = useMusicPlayer();
  const [playlist, setPlaylist] = useState<MusicTrack[]>([]);
  const [playlistTitle, setPlaylistTitle] = useState("");
  const [playlistIcon, setPlaylistIcon] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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

          setPlaylistTitle(plData.nombre || playlistId);
          setPlaylistIcon(plData.iconUrl || null);
          setPlaylist(plData.canciones.map((song) => ({
            id: song.id,
            name: song.name,
            url: getMediaUrl(song.url),
            variantes: song.variantes,
          })));
          return;
        }

        if (songId) {
          const songsRes = await fetch(`${TUNNEL_URL}/canciones`);
          if (!songsRes.ok) throw new Error("Error cargando base de datos de canciones.");
          const songsData = (await songsRes.json()) as ApiSong[];
          const dbSong = songsData.find((song) => song.id === songId);
          if (!dbSong) throw new Error("Cancion no encontrada.");

          setPlaylistTitle("Reproduciendo");
          setPlaylistIcon(null);
          setPlaylist([{
            id: dbSong.id,
            name: dbSong.name,
            url: getMediaUrl(dbSong.url),
            variantes: dbSong.variantes,
          }]);
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
  }, [playlistId, songId]);

  const handleShare = (type: "song" | "playlist", identifier: string) => {
    const url = type === "playlist"
      ? `${window.location.origin}/playlist/${encodeURIComponent(identifier)}`
      : `${window.location.origin}/play?song=${encodeURIComponent(identifier)}`;

    navigator.clipboard.writeText(url)
      .then(() => setMessage("Enlace copiado al portapapeles."))
      .catch(() => setMessage("No se pudo copiar el enlace."));
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
              <p className="playlist-admin__subtitle">{playlist.length} canciones</p>
            </div>
          </div>
          {playlistId && (
            <button
              onClick={() => handleShare("playlist", playlistId)}
              className="playlist-admin__btn-action"
              title="Compartir playlist"
            >
              <ShareIcon size={16} /> Compartir
            </button>
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
                onClick={() => playQueue(playlist, i)}
                style={{ gridTemplateColumns: "50px 1fr 80px" }}
              >
                <div className="playlist-admin__item-index">
                  <span className="playlist-admin__item-play-icon">▶</span>
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
              onClick={() => toggleTrack(playlist[0], playlist)}
            >
              Reproducir
            </button>
          )}
        </section>
      </div>
    </main>
  );
}
