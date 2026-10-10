"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Mic2Icon, PencilIcon, PlayIcon, RotateCcwIcon, TrashIcon, XIcon } from "lucide-react";
import { auth } from "@/lib/firebase";
import { MUSIC_API_URL, type ApiSong } from "@/lib/radioApi";
import SongArtwork from "@/components/SongArtwork";
import styles from "./YouTubeSongAdminPanel.module.scss";

type AdminSong = ApiSong & {
  youtubeUrl?: string;
  lyricArtist?: string;
  lyricTrack?: string;
  lyricsSource?: string | null;
  lyricsStatus?: string;
};

function lyricsLabel(song: AdminSong) {
  const provider = song.lyricsSource === "lrclib" ? "LRCLIB"
    : song.lyricsSource === "lyrics.ovh" ? "lyrics.ovh"
      : song.lyricsSource === "youtube-captions" ? "YouTube" : null;
  if (song.lyricsSrt) return `Lyrics sincronizadas${provider ? ` · ${provider}` : ""}`;
  if (song.staticLyrics) return `Lyrics estáticas${provider ? ` · ${provider}` : ""}`;
  if (song.lyricsStatus === "retry") return "Buscando letras (pendiente de reintento)";
  if (song.lyricsStatus === "unidentified") return "Faltan artista o titulo musical";
  if (song.lyricsStatus === "none") return "Sin coincidencias";
  return "Lyrics pendientes";
}

function durationLabel(seconds?: number | null) {
  const value = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

async function adminRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const user = auth?.currentUser;
  if (!user) throw new Error("Inicia sesión como administrador para continuar.");
  const token = await user.getIdToken();
  const response = await fetch(`${MUSIC_API_URL}${path}`, {
    ...options,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Error HTTP ${response.status}`);
  return data as T;
}

export default function YouTubeSongAdminPanel() {
  const [songs, setSongs] = useState<AdminSong[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [trackTitle, setTrackTitle] = useState("");
  const [duration, setDuration] = useState("");
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminRequest<{ songs: AdminSong[] }>("/admin/youtube-tracks");
      setSongs(data.songs);
      setNotice(null);
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : "No se pudo cargar YouTube." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const text = search.trim().toLocaleLowerCase("es");
    return text ? songs.filter(song => song.name.toLocaleLowerCase("es").includes(text) || song.id.includes(text)) : songs;
  }, [search, songs]);

  const startEdit = (song: AdminSong) => {
    setEditingId(song.id);
    setTitle(song.name);
    setArtist(song.lyricArtist || "");
    setTrackTitle(song.lyricTrack || "");
    setDuration(String(song.duration || ""));
    setNotice(null);
  };

  const save = async (song: AdminSong) => {
    const videoId = song.id.replace(/^youtube:/, "");
    const parsedDuration = Number(duration);
    if (!title.trim() || !Number.isFinite(parsedDuration) || parsedDuration <= 0) {
      setNotice({ error: true, text: "Introduce un título y una duración válidos." });
      return;
    }
    setBusyId(song.id);
    try {
      const result = await adminRequest<{ song: AdminSong }>(`/admin/youtube-tracks/${encodeURIComponent(videoId)}`, {
        method: "PATCH",
        body: JSON.stringify({ title: title.trim(), duration: parsedDuration, artist: artist.trim(), track: trackTitle.trim() }),
      });
      setSongs(current => current.map(item => item.id === song.id ? result.song : item));
      setEditingId(null);
      setNotice({ error: false, text: "Canción actualizada. Se buscarán letras con estos metadatos." });
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : "No se pudo editar." });
    } finally {
      setBusyId(null);
    }
  };

  const findLyrics = async (song: AdminSong) => {
    const videoId = song.id.slice("youtube:".length);
    setBusyId(song.id);
    setNotice(null);
    try {
      const result = await adminRequest<{ song: AdminSong }>(`/admin/youtube-tracks/${encodeURIComponent(videoId)}/lyrics/refresh`, {
        method: "POST",
      });
      if (result.song) setSongs(current => current.map(item => item.id === song.id ? result.song : item));
      const status = result.song ? lyricsLabel(result.song) : "No hay letras disponibles";
      setNotice({ error: false, text: `${song.name}: ${status}.` });
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : "No se pudieron buscar letras." });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (song: AdminSong) => {
    if (!window.confirm(`¿Eliminar «${song.name}» del catálogo de YouTube?\n\nDesaparecerá de la radio. Las playlists personales que la referencien ya no podrán reproducirla. Esta acción no elimina archivos de audio.`)) return;
    setBusyId(song.id);
    setNotice(null);
    try {
      await adminRequest(`/admin/youtube-tracks/${encodeURIComponent(song.id.slice("youtube:".length))}`, { method: "DELETE" });
      setSongs(current => current.filter(item => item.id !== song.id));
      if (editingId === song.id) setEditingId(null);
      setNotice({ error: false, text: "Canción eliminada del catálogo." });
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : "No se pudo eliminar." });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className={styles.panel} aria-label="Catálogo de canciones de YouTube">
      <header className={styles.header}>
        <div>
          <h3><PlayIcon size={19} /> Canciones de YouTube <span>({songs.length})</span></h3>
          <p>Se guardan las referencias, no archivos MP3. Estas canciones no se muestran en el catálogo normal de Farreo.</p>
        </div>
        <button className={styles.secondaryButton} type="button" onClick={() => void load()} disabled={loading || busyId !== null}>
          <RotateCcwIcon size={16} /> Actualizar
        </button>
      </header>
      <input
        className={styles.search}
        type="search"
        placeholder="Buscar título o identificador de YouTube..."
        value={search}
        onChange={event => setSearch(event.target.value)}
      />
      {notice && <p className={notice.error ? styles.error : styles.success} role="status">{notice.text}</p>}
      {loading ? <p className={styles.empty}>Cargando canciones...</p> : filtered.length === 0 ? (
        <p className={styles.empty}>{songs.length ? "No hay coincidencias." : "Todavía no hay canciones de YouTube importadas."}</p>
      ) : (
        <div className={styles.list}>
          {filtered.map(song => {
            const editing = editingId === song.id;
            const busy = busyId === song.id;
            const videoId = song.id.slice("youtube:".length);
            return (
              <article className={styles.item} key={song.id}>
                <SongArtwork src={song.iconUrl} alt="" className={styles.artwork} />
                <div className={styles.details}>
                  {editing ? (
                    <div className={styles.editFields}>
                      <label>Título <input value={title} maxLength={220} onChange={event => setTitle(event.target.value)} /></label>
                      <label>Duración (segundos) <input type="number" min="1" max="43200" step="0.01" value={duration} onChange={event => setDuration(event.target.value)} /></label>
                      <label>Artista para buscar lyrics <input value={artist} maxLength={160} onChange={event => setArtist(event.target.value)} placeholder="Nombre del artista" /></label>
                      <label>Título musical para buscar lyrics <input value={trackTitle} maxLength={180} onChange={event => setTrackTitle(event.target.value)} placeholder="Título de la canción" /></label>
                    </div>
                  ) : <strong>{song.name}</strong>}
                  <div className={styles.metadata}>
                    <span>{durationLabel(song.duration)}</span>
                    <span>{lyricsLabel(song)}</span>
                    <a href={song.youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noopener noreferrer">Ver en YouTube ↗</a>
                  </div>
                </div>
                <div className={styles.actions}>
                  {editing ? (
                    <>
                      <button className={styles.primaryButton} type="button" disabled={busy} onClick={() => void save(song)}>Guardar</button>
                      <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => setEditingId(null)} aria-label="Cancelar"><XIcon size={16} /></button>
                    </>
                  ) : (
                    <>
                      <button className={styles.secondaryButton} type="button" disabled={busyId !== null} onClick={() => void findLyrics(song)}><Mic2Icon size={16} /> Buscar letras</button>
                      <button className={styles.secondaryButton} type="button" disabled={busyId !== null} onClick={() => startEdit(song)}><PencilIcon size={16} /> Editar</button>
                      <button className={styles.dangerButton} type="button" disabled={busyId !== null} onClick={() => void remove(song)}><TrashIcon size={16} /> Borrar</button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
