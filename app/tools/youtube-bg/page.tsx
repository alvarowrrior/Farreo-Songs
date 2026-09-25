"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  LoaderCircleIcon,
  PlayIcon,
  SaveIcon,
  TrashIcon,
} from "lucide-react";
import { auth } from "@/lib/firebase";
import { MUSIC_API_URL } from "@/lib/radioApi";
import SongArtwork from "@/components/SongArtwork";
import styles from "./YoutubeBg.module.scss";

interface Song {
  id: string;
  name: string;
  iconUrl?: string | null;
}

interface ResolveResult {
  directUrl: string;
  videoId: string | null;
  title: string | null;
  formatId: string | null;
  ext: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  vcodec: string | null;
}

interface MappingEntry {
  songId: string;
  youtubeUrl: string | null;
  updatedAt: string | null;
}

const adminHeaders = async () => {
  const user = auth?.currentUser;
  if (!user) throw new Error("Necesitas una sesión de administrador.");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${await user.getIdToken()}`,
  };
};

export default function YouTubeVideoTestPage() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [status, setStatus] = useState<
    "idle" | "resolving" | "loading" | "ready" | "saving" | "failed"
  >("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    fetch(`${MUSIC_API_URL}/canciones`)
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<Song[]>;
      })
      .then(setSongs)
      .catch(() => setError("No se pudo cargar el catálogo de canciones."));
  }, []);

  const selected = songs.find((song) => song.id === selectedId) || null;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return songs.slice(0, 80);
    return songs
      .filter((song) => song.name.toLowerCase().includes(normalized))
      .slice(0, 80);
  }, [query, songs]);

  const selectSong = async (song: Song) => {
    setSelectedId(song.id);
    setQuery(song.name);
    setResult(null);
    setError("");
    setNotice("");

    try {
      const response = await fetch(
        `${MUSIC_API_URL}/youtube-backgrounds/${encodeURIComponent(song.id)}`,
        { cache: "no-store" },
      );
      const data = await response.json() as MappingEntry;
      setUrl(data.youtubeUrl || "");
    } catch {
      setUrl("");
    }
  };

  const resolve = async () => {
    setStatus("resolving");
    setError("");
    setNotice("");
    setResult(null);

    try {
      const response = await fetch(
        `${MUSIC_API_URL}/admin/youtube-video/resolve`,
        {
          method: "POST",
          headers: await adminHeaders(),
          body: JSON.stringify({ url: url.trim() }),
        },
      );
      const data = await response.json().catch(() => ({})) as ResolveResult & {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "No se pudo resolver.");

      setResult(data);
      setStatus("loading");
    } catch (reason) {
      setStatus("failed");
      setError(reason instanceof Error ? reason.message : "No se pudo resolver.");
    }
  };

  const save = async (overrideUrl?: string) => {
    if (!selectedId) {
      setError("Selecciona primero una canción.");
      return;
    }

    setStatus("saving");
    setError("");
    setNotice("");
    const nextUrl = overrideUrl !== undefined ? overrideUrl : url.trim();

    try {
      const response = await fetch(
        `${MUSIC_API_URL}/admin/youtube-backgrounds/${encodeURIComponent(selectedId)}`,
        {
          method: "PUT",
          headers: await adminHeaders(),
          body: JSON.stringify({ youtubeUrl: nextUrl }),
        },
      );
      const data = await response.json().catch(() => ({})) as MappingEntry & {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "No se pudo guardar.");

      setUrl(data.youtubeUrl || "");
      setNotice(data.youtubeUrl
        ? "Videoclip asignado a la canción."
        : "Videoclip eliminado de la canción.");
      setStatus("idle");
    } catch (reason) {
      setStatus("failed");
      setError(reason instanceof Error ? reason.message : "No se pudo guardar.");
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/tools">← Herramientas</Link>
        <div>
          <h1>YouTube BG</h1>
          <p>
            Asocia un vídeo de YouTube a una canción de Farreo. En PC, Farreo
            resolverá el stream de vídeo y lo reproducirá directamente desde
            Google detrás de la interfaz, sincronizado con el audio local.
          </p>
        </div>
      </header>

      <section className={styles.card}>
        <label>1. Canción de Farreo</label>
        <input
          className={styles.fullInput}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (event.target.value !== selected?.name) setSelectedId("");
          }}
          placeholder="Buscar canción…"
        />

        <div className={styles.songList}>
          {filtered.map((song) => (
            <button
              key={song.id}
              type="button"
              className={`${styles.song} ${selectedId === song.id ? styles.songSelected : ""}`}
              onClick={() => void selectSong(song)}
            >
              <SongArtwork src={song.iconUrl} alt={song.name} sizes="44px" />
              <span>{song.name}</span>
            </button>
          ))}
        </div>

        <label>2. URL del videoclip en YouTube</label>
        <input
          className={styles.fullInput}
          type="url"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setResult(null);
          }}
          placeholder="https://www.youtube.com/watch?v=..."
          spellCheck={false}
        />

        <div className={styles.actions}>
          <button
            type="button"
            onClick={() => void resolve()}
            disabled={!url.trim() || status === "resolving"}
          >
            {status === "resolving"
              ? <LoaderCircleIcon size={17} className={styles.spin} />
              : <PlayIcon size={17} />}
            Probar stream
          </button>

          <button
            type="button"
            onClick={() => void save()}
            disabled={!selectedId || status === "saving"}
          >
            <SaveIcon size={17} />
            Guardar
          </button>

          <button
            type="button"
            className={styles.danger}
            onClick={() => {
              setUrl("");
              setResult(null);
              void save("");
            }}
            disabled={!selectedId}
          >
            <TrashIcon size={17} />
            Quitar
          </button>
        </div>

        {notice && <div className={styles.notice}>{notice}</div>}
        {error && <div className={styles.error}>{error}</div>}
      </section>

      {result && (
        <section className={styles.playerCard}>
          <div className={styles.meta}>
            <div>
              <strong>{result.title || result.videoId || "Vídeo resuelto"}</strong>
              <span>
                {result.width || "?"}×{result.height || "?"}
                {" · "}{result.fps || "?"} FPS
                {" · "}{result.vcodec || result.ext || "codec desconocido"}
              </span>
            </div>
          </div>

          <video
            key={result.directUrl}
            ref={videoRef}
            src={result.directUrl}
            muted
            controls
            playsInline
            preload="auto"
            className={styles.video}
            onLoadStart={() => setStatus("loading")}
            onCanPlay={() => setStatus("ready")}
            onPlaying={() => setStatus("ready")}
            onError={() => {
              setStatus("failed");
              setError("El navegador no pudo abrir este stream directo.");
            }}
          />

          <div className={`${styles.badge} ${status === "ready" ? styles.ok : ""}`}>
            {status === "ready"
              ? "✓ Stream directo listo"
              : "Esperando al stream directo…"}
          </div>
        </section>
      )}
    </main>
  );
}
