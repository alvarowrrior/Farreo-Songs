"use client";

import { useEffect, useState, useRef } from "react";
import { onAuthStateChanged } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TrashIcon, PlusIcon, ListMusicIcon, ArrowLeftIcon, LibraryIcon, SearchIcon, ShuffleIcon, ArrowRightIcon, Volume2Icon, VolumeXIcon, DicesIcon, PencilIcon, XIcon, ShareIcon } from "lucide-react";
import { auth, isFirebaseConfigured } from "@/lib/firebase";

const ADMIN_EMAILS = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "").split(",");

// ⚠️ URL del servidor de música en casa del amigo (DDNS con HTTPS)
const TUNNEL_URL = "https://welite.ddns.net:3001";

const getMediaUrl = (url?: string | null) => {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  return `${TUNNEL_URL}${url}`;
};

interface PlaylistItem {
  id: string;
  name: string;
  url: string;
  variantes?: string[];
  createdAt: { seconds: number; nanoseconds: number } | Date | null;
}

interface PlaylistInfo {
  id: string;
  nombre: string;
  iconUrl?: string | null;
  numCanciones: number;
}

interface ApiPlaylistInfo extends PlaylistInfo {
  id: string;
}

type Vista = "playlists" | "canciones";

interface PlaylistLibraryProps {
  adminMode?: boolean;
}

export default function PlaylistLibrary({ adminMode = false }: PlaylistLibraryProps) {
  const router = useRouter();
  const [isCheckingAuth, setIsCheckingAuth] = useState(adminMode);
  const [isAuthorized, setIsAuthorized] = useState(!adminMode);

  // Vista actual
  const [vista, setVista] = useState<Vista>("playlists");
  const [playlistActual, setPlaylistActual] = useState<string | null>(null);

  // Playlists
  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [playlistEditorOpen, setPlaylistEditorOpen] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistInfo | null>(null);
  const [playlistEditorName, setPlaylistEditorName] = useState("");
  const [playlistEditorIconFile, setPlaylistEditorIconFile] = useState<File | null>(null);
  const [playlistEditorIconPreview, setPlaylistEditorIconPreview] = useState("");
  const [savingPlaylist, setSavingPlaylist] = useState(false);

  // Todas las canciones de la BD (vista principal)
  const [allCanciones, setAllCanciones] = useState<PlaylistItem[]>([]);
  const [loadingAllCanciones, setLoadingAllCanciones] = useState(false);

  // Canciones de la playlist actual
  const [playlist, setPlaylist] = useState<PlaylistItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Subida
  const [pendingUpload, setPendingUpload] = useState<File | null>(null);
  const [uploadNombre, setUploadNombre] = useState("");
  const [uploadVariantes, setUploadVariantes] = useState<string[]>([]);
  const [nuevaVarianteInput, setNuevaVarianteInput] = useState("");
  const [varianteError, setVarianteError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [etiquetasExistentes, setEtiquetasExistentes] = useState<Record<string, string>>({});

  // Reproductor
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTrack, setCurrentTrack] = useState<PlaylistItem | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPitch, setPlaybackPitch] = useState(1);
  const [volume, setVolume] = useState(0.8);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isShuffle, setIsShuffle] = useState(true);
  const [autoRandomPitch, setAutoRandomPitch] = useState(true);
  const [dragActive, setDragActive] = useState(false);

  // Picker de canciones para añadir a playlist
  const [showSongPicker, setShowSongPicker] = useState(false);
  const [allSongs, setAllSongs] = useState<PlaylistItem[]>([]);
  const [songSearchQuery, setSongSearchQuery] = useState("");

  // Buscadores de canciones
  const [searchAllCanciones, setSearchAllCanciones] = useState("");
  const [searchPlaylistCanciones, setSearchPlaylistCanciones] = useState("");

  // Editor de canción
  const [editingTrack, setEditingTrack] = useState<PlaylistItem | null>(null);
  const [editNombre, setEditNombre] = useState("");
  const [editVariantes, setEditVariantes] = useState<string[]>([]);
  const [editNuevaVariante, setEditNuevaVariante] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!adminMode) {
      loadPlaylists();
      setIsCheckingAuth(false);
      return;
    }

    if (!auth) {
      setIsAuthorized(false);
      setIsCheckingAuth(false);
      return;
    }

    const unsub = onAuthStateChanged(auth, (u) => {
      const authorized = Boolean(u?.email && ADMIN_EMAILS.includes(u.email));
      setIsAuthorized(authorized);

      if (authorized) {
        loadPlaylists();
        loadEtiquetas();
        loadAllCanciones();
      }

      setIsCheckingAuth(false);
    });

    return () => unsub();
  }, [adminMode]);

  // Ocultar mensajes automáticamente después de 3 segundos
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // ==========================================
  // CARGA DE DATOS
  // ==========================================

  const loadPlaylists = async () => {
    try {
      setLoadingPlaylists(true);
      const res = await fetch(`${TUNNEL_URL}/playlists`);
      if (res.ok) {
        const data = (await res.json()) as ApiPlaylistInfo[];
        setPlaylists(data.map((playlist) => ({
          ...playlist,
          id: playlist.id.endsWith(".txt") ? playlist.nombre : playlist.id,
        })));
      }
    } catch {
      setMessage({ type: "error", text: "No se pudo conectar con el servidor de música." });
    } finally {
      setLoadingPlaylists(false);
    }
  };

  const loadPlaylistCanciones = async (nombre: string) => {
    try {
      setLoading(true);
      const res = await fetch(`${TUNNEL_URL}/playlist/${encodeURIComponent(nombre)}`);
      if (res.ok) {
        const data = await res.json();
        const absoluteData = data.canciones.map((item: PlaylistItem) => ({
          ...item,
          url: getMediaUrl(item.url)
        }));
        setPlaylist(absoluteData);
      }
    } catch {
      setMessage({ type: "error", text: "No se pudo cargar esta playlist." });
    } finally {
      setLoading(false);
    }
  };

  const loadEtiquetas = async () => {
    try {
      const res = await fetch(`${TUNNEL_URL}/etiquetas`);
      if (res.ok) setEtiquetasExistentes(await res.json());
    } catch {
      setEtiquetasExistentes({});
    }
  };

  const loadAllCanciones = async () => {
    try {
      setLoadingAllCanciones(true);
      const res = await fetch(`${TUNNEL_URL}/canciones`);
      if (res.ok) {
        const data = await res.json();
        const absoluteData = data.map((item: PlaylistItem) => ({
          ...item,
          url: getMediaUrl(item.url)
        }));
        setAllCanciones(absoluteData);
      }
    } catch {
      setMessage({ type: "error", text: "No se pudo cargar la lista de canciones." });
    } finally {
      setLoadingAllCanciones(false);
    }
  };

  // ==========================================
  // PLAYLISTS
  // ==========================================

  const volverAPlaylists = () => {
    setVista("playlists");
    setPlaylistActual(null);
    setPlaylist([]);
    setCurrentTrack(null);
    setIsPlaying(false);
    audioRef.current?.pause();
    loadPlaylists();
    loadAllCanciones();
  };

  const openAdminPlaylistSongs = (playlist: PlaylistInfo) => {
    setPlaylistActual(playlist.id);
    setVista("canciones");
    setSearchPlaylistCanciones("");
    setShowSongPicker(false);
    loadPlaylistCanciones(playlist.id);
  };

  const openCreatePlaylist = () => {
    setEditingPlaylist(null);
    setPlaylistEditorName("");
    setPlaylistEditorIconFile(null);
    setPlaylistEditorIconPreview("");
    setPlaylistEditorOpen(true);
  };

  const openEditPlaylist = (playlist: PlaylistInfo) => {
    setEditingPlaylist(playlist);
    setPlaylistEditorName(playlist.nombre);
    setPlaylistEditorIconFile(null);
    setPlaylistEditorIconPreview(getMediaUrl(playlist.iconUrl));
    setPlaylistEditorOpen(true);
  };

  const handlePlaylistIconChange = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMessage({ type: "error", text: "El icono debe ser una imagen." });
      return;
    }

    if (file.size > 750 * 1024) {
      setMessage({ type: "error", text: "El icono debe pesar menos de 750 KB." });
      return;
    }

    setPlaylistEditorIconFile(file);
    const reader = new FileReader();
    reader.onload = () => setPlaylistEditorIconPreview(String(reader.result || ""));
    reader.readAsDataURL(file);
  };

  const savePlaylist = async () => {
    const displayName = playlistEditorName.trim();
    if (!displayName) return;

    setSavingPlaylist(true);
    try {
      const formData = new FormData();
      formData.append("nombre", displayName);
      if (playlistEditorIconFile) {
        formData.append("icon", playlistEditorIconFile);
      }

      if (editingPlaylist) {
        const res = await fetch(`${TUNNEL_URL}/playlist/${encodeURIComponent(editingPlaylist.id)}`, {
          method: 'PUT',
          body: formData,
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Error actualizando playlist.");
        }
        setMessage({ type: "success", text: "Playlist actualizada." });
      } else {
        const res = await fetch(`${TUNNEL_URL}/playlist`, {
          method: 'POST',
          body: formData,
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Error creando playlist.");
        }

        setMessage({ type: "success", text: "Playlist creada." });
      }

      setPlaylistEditorOpen(false);
      setEditingPlaylist(null);
      setPlaylistEditorName("");
      setPlaylistEditorIconFile(null);
      setPlaylistEditorIconPreview("");
      loadPlaylists();
    } catch (err: unknown) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "No se pudo guardar la playlist." });
    } finally {
      setSavingPlaylist(false);
    }
  };

  const eliminarPlaylist = async (playlist: PlaylistInfo) => {
    if (!window.confirm(`¿Eliminar la playlist "${playlist.nombre}"?`)) return;
    try {
      const res = await fetch(`${TUNNEL_URL}/playlist/${encodeURIComponent(playlist.id)}`, { method: 'DELETE' });
      if (res.ok) {
        setMessage({ type: "success", text: "Playlist eliminada." });
        if (playlistActual === playlist.id) volverAPlaylists();
        else loadPlaylists();
      }
    } catch {
      setMessage({ type: "error", text: "Error eliminando playlist." });
    }
  };

  const openSongPicker = async () => {
    try {
      const res = await fetch(`${TUNNEL_URL}/canciones`);
      if (res.ok) {
        const data = await res.json();
        setAllSongs(data);
        setShowSongPicker(true);
        setSongSearchQuery("");
      }
    } catch {
      setMessage({ type: "error", text: "No se pudo cargar la lista de canciones." });
    }
  };

  const addSongToPlaylist = async (nombreCancion: string) => {
    if (!playlistActual) return;
    try {
      const res = await fetch(`${TUNNEL_URL}/playlist/${encodeURIComponent(playlistActual)}/add-song`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombreCancion })
      });
      if (res.ok) {
        setMessage({ type: "success", text: `"${nombreCancion}" añadida.` });
        loadPlaylistCanciones(playlistActual);
      } else {
        const err = await res.json();
        setMessage({ type: "error", text: err.error });
      }
    } catch {
      setMessage({ type: "error", text: "Error añadiendo canción." });
    }
  };

  // Canciones del picker filtradas: no están ya en la playlist y coinciden con la búsqueda
  const filteredPickerSongs = allSongs.filter(song => {
    const yaEnPlaylist = playlist.some(p => p.name === song.name);
    if (yaEnPlaylist) return false;
    if (!songSearchQuery.trim()) return true;
    const q = songSearchQuery.toLowerCase();
    return song.name.toLowerCase().includes(q) ||
      (song.variantes && song.variantes.some(v => v.toLowerCase().includes(q)));
  });

  // ==========================================
  // SUBIDA DE CANCIONES
  // ==========================================

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    initUpload(e.target.files[0]);
    e.target.value = '';
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) initUpload(e.dataTransfer.files[0]);
  };

  const initUpload = (file: File) => {
    setPendingUpload(file);
    setUploadNombre(file.name.replace(/\.[^/.]+$/, ""));
    setUploadVariantes([]);
    setNuevaVarianteInput("");
    setVarianteError(null);
  };

  const anadirVariante = () => {
    setVarianteError(null);
    const val = nuevaVarianteInput.trim();
    if (!val) return;
    const valLower = val.toLowerCase();
    if (etiquetasExistentes[valLower]) {
      setVarianteError(`¡"${val}" ya se usa en "${etiquetasExistentes[valLower]}"!`);
      return;
    }
    if (uploadVariantes.some(v => v.toLowerCase() === valLower)) {
      setVarianteError("Ya has añadido esta variante.");
      return;
    }
    setUploadVariantes(prev => [...prev, val]);
    setNuevaVarianteInput("");
  };

  const removeVariante = (index: number) => setUploadVariantes(prev => prev.filter((_, i) => i !== index));

  const confirmUpload = async () => {
    if (!pendingUpload) return;
    setIsUploading(true);
    setMessage(null);
    const formData = new FormData();
    formData.append("file", pendingUpload);
    formData.append("metadata", JSON.stringify({
      nombre: uploadNombre.trim() || pendingUpload.name,
      variantes: uploadVariantes
    }));
    try {
      const res = await fetch(`${TUNNEL_URL}/upload`, { method: 'POST', body: formData });
      if (res.ok) {
        setMessage({ type: "success", text: "¡Canción subida!" });
        setPendingUpload(null);
        loadEtiquetas();
        loadAllCanciones();
      } else {
        setMessage({ type: "error", text: "Error en el servidor al subir." });
      }
    } catch {
      setMessage({ type: "error", text: "No se pudo conectar al servidor." });
    } finally {
      setIsUploading(false);
    }
  };

  // ==========================================
  // REPRODUCTOR
  // ==========================================

  const playSong = (track: PlaylistItem) => {
    if (!track.url) return;

    // Si es la misma canción, toggle pause/play
    if (currentTrack?.id === track.id) {
      if (audioRef.current) {
        if (isPlaying) {
          audioRef.current.pause();
        } else {
          audioRef.current.play();
        }
        setIsPlaying(!isPlaying);
      }
      return;
    }

    // Canción nueva
    let pitch = playbackPitch;
    if (autoRandomPitch) {
      pitch = Math.random() * (1.2 - 0.8) + 0.8;
      setPlaybackPitch(pitch);
    }

    setCurrentTrack(track);
    setIsPlaying(true);
    setTimeout(() => {
      if (audioRef.current) {
        audioRef.current.preservesPitch = false;
        audioRef.current.playbackRate = pitch;
        audioRef.current.volume = volume;
        audioRef.current.play().catch(e => console.error("Auto-play prevented", e));
      }
    }, 50);
  };

  const playNext = () => {
    if (playlist.length === 0) return;
    if (isShuffle) {
      let nextIndex = Math.floor(Math.random() * playlist.length);
      if (playlist.length > 1 && currentTrack) {
        while (playlist[nextIndex].id === currentTrack.id) {
          nextIndex = Math.floor(Math.random() * playlist.length);
        }
      }
      playSong(playlist[nextIndex]);
    } else {
      if (!currentTrack) { playSong(playlist[0]); return; }
      const idx = playlist.findIndex(t => t.id === currentTrack.id);
      const nextIdx = (idx + 1) % playlist.length;
      playSong(playlist[nextIdx]);
    }
  };

  const playPrev = () => {
    if (playlist.length === 0) return;
    if (isShuffle) {
      playNext();
    } else {
      if (!currentTrack) { playSong(playlist[playlist.length - 1]); return; }
      const idx = playlist.findIndex(t => t.id === currentTrack.id);
      const prevIdx = (idx - 1 + playlist.length) % playlist.length;
      playSong(playlist[prevIdx]);
    }
  };

  const togglePlayPause = () => {
    if (!currentTrack && playlist.length > 0) { playNext(); return; }
    if (audioRef.current) {
      if (isPlaying) audioRef.current.pause(); else audioRef.current.play();
      setIsPlaying(!isPlaying);
    }
  };

  const handleVolumeChange = (val: number) => {
    setVolume(val);
    if (audioRef.current) audioRef.current.volume = val;
  };

  const handlePitchChange = (val: number) => {
    setPlaybackPitch(val);
    if (audioRef.current) {
      audioRef.current.preservesPitch = false;
      audioRef.current.playbackRate = val;
    }
  };

  const handleSeek = (val: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = val;
      setCurrentTime(val);
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  };

  // ==========================================
  // COMPARTIR
  // ==========================================
  const handleShare = (type: 'song' | 'playlist', identifier: string) => {
    const url = type === "playlist"
      ? `${window.location.origin}/playlist/${encodeURIComponent(identifier)}`
      : `${window.location.origin}/play?song=${encodeURIComponent(identifier)}`;
    navigator.clipboard.writeText(url)
      .then(() => setMessage({ type: "success", text: "Enlace copiado al portapapeles." }))
      .catch(() => setMessage({ type: "error", text: "Error copiando el enlace." }));
  };

  // ==========================================
  // EDITAR CANCIÓN
  // ==========================================

  const openEditModal = (track: PlaylistItem) => {
    setEditingTrack(track);
    setEditNombre(track.name);
    setEditVariantes(track.variantes ? [...track.variantes] : []);
    setEditNuevaVariante("");
  };

  const closeEditModal = () => {
    setEditingTrack(null);
    setEditNombre("");
    setEditVariantes([]);
    setEditNuevaVariante("");
  };

  const saveEdit = async () => {
    if (!editingTrack) return;
    setIsSaving(true);
    try {
      const res = await fetch(`${TUNNEL_URL}/cancion/${editingTrack.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre: editNombre.trim(), variantes: editVariantes })
      });
      if (res.ok) {
        setMessage({ type: "success", text: "Canción actualizada." });
        closeEditModal();
        loadAllCanciones();
        loadEtiquetas();
      } else {
        const err = await res.json();
        setMessage({ type: "error", text: err.error || "Error actualizando." });
      }
    } catch {
      setMessage({ type: "error", text: "No se pudo conectar al servidor." });
    } finally {
      setIsSaving(false);
    }
  };

  // ==========================================
  // FILTROS DE BÚSQUEDA
  // ==========================================

  const filteredAllCanciones = allCanciones.filter(t => {
    if (!searchAllCanciones.trim()) return true;
    const q = searchAllCanciones.toLowerCase();
    return t.name.toLowerCase().includes(q) ||
      (t.variantes && t.variantes.some(v => v.toLowerCase().includes(q)));
  });

  const filteredPlaylist = playlist.filter(t => {
    if (!searchPlaylistCanciones.trim()) return true;
    const q = searchPlaylistCanciones.toLowerCase();
    return t.name.toLowerCase().includes(q) ||
      (t.variantes && t.variantes.some(v => v.toLowerCase().includes(q)));
  });

  const currentPlaylist = playlistActual
    ? playlists.find((item) => item.id === playlistActual) ?? null
    : null;

  // Borrar canción DE LA BD (mp3 + json + de todas las playlists)
  const handleDeleteFromDB = async (item: PlaylistItem) => {
    if (!window.confirm(`¿BORRAR PERMANENTEMENTE "${item.name}" de la base de datos?`)) return;
    try {
      const res = await fetch(`${TUNNEL_URL}/cancion/${item.id}`, { method: 'DELETE' });
      if (res.ok) {
        setMessage({ type: "success", text: "Canción eliminada de la base de datos." });
        if (currentTrack?.id === item.id) {
          audioRef.current?.pause();
          setCurrentTrack(null);
          setIsPlaying(false);
        }
        loadAllCanciones();
        loadEtiquetas();
        loadPlaylists();
      }
    } catch {
      setMessage({ type: "error", text: "Error borrando." });
    }
  };

  // Quitar canción SOLO de la playlist actual (no borra de la BD)
  const handleRemoveFromPlaylist = async (item: PlaylistItem) => {
    if (!playlistActual) return;
    try {
      const res = await fetch(
        `${TUNNEL_URL}/playlist/${encodeURIComponent(playlistActual)}/song?cancion=${encodeURIComponent(item.name)}`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        setMessage({ type: "success", text: `"${item.name}" quitada de la playlist.` });
        if (currentTrack?.id === item.id) {
          audioRef.current?.pause();
          setCurrentTrack(null);
          setIsPlaying(false);
        }
        loadPlaylistCanciones(playlistActual);
      }
    } catch {
      setMessage({ type: "error", text: "Error quitando canción de la playlist." });
    }
  };

  // ==========================================
  // RENDERS CONDICIONALES
  // ==========================================

  if (isCheckingAuth) return <main className="playlist-admin playlist-admin--loading"><p className="playlist-admin__subtitle">Cargando...</p></main>;
  if (adminMode && !isFirebaseConfigured) {
    return (
      <main className="playlist-admin">
        <div style={{ textAlign: "center", marginTop: "100px" }}>
          <h2>Firebase no esta configurado</h2>
          <p>Crea un archivo .env.local con las claves de Firebase y reinicia el servidor local.</p>
        </div>
      </main>
    );
  }
  if (adminMode && !isAuthorized) return <main className="playlist-admin"><div style={{ textAlign: "center", marginTop: "100px" }}><h2>Acceso Denegado</h2><p>Solo personal autorizado.</p></div></main>;

  // ==========================================
  // VISTA 1: LISTA DE PLAYLISTS
  // ==========================================
  if (vista === "playlists") {
    return (
      <main className="playlist-admin">
        <div className="playlist-admin__content">
          {adminMode && (
            <header className="playlist-admin__header">
              <div>
                <Link href="/" className="playlist-admin__nav-back">← Volver a la biblioteca</Link>
                <h1 className="playlist-admin__title">Admin</h1>
                <p className="playlist-admin__subtitle">Gestiona canciones y playlists</p>
              </div>
            </header>
          )}

          {message && (
            <div className={`playlist-admin__message playlist-admin__message--${message.type}`}>
              {message.text}
            </div>
          )}

          {adminMode && (
            <section className="playlist-admin__section">
              <h2 className="playlist-admin__section-title">
                <PlusIcon size={20} /> Subir Canción
              </h2>

              {!pendingUpload ? (
                <div
                  className={`playlist-admin__upload-section ${dragActive ? "playlist-admin__upload-section--active" : ""}`}
                  onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
                >
                  <label className="playlist-admin__upload-label">
                    <span className="playlist-admin__upload-icon">🎧</span>
                    <span className="playlist-admin__upload-text">Subir nueva canción</span>
                    <span className="playlist-admin__upload-sub">Arrastra un MP3 o haz clic</span>
                    <button className="playlist-admin__upload-btn" onClick={(e) => { e.preventDefault(); document.getElementById("file-upload")?.click(); }}>
                      Seleccionar Archivo
                    </button>
                    <input id="file-upload" type="file" accept="audio/mpeg,audio/mp3" onChange={handleFileUpload} className="playlist-admin__upload-input" />
                  </label>
                </div>
              ) : (
                <div className="playlist-admin__upload-form">
                  <div className="playlist-admin__upload-form-header">
                    <span className="playlist-admin__upload-form-file">🎵 {pendingUpload.name}</span>
                    <button onClick={() => setPendingUpload(null)} className="playlist-admin__upload-form-change">Cambiar</button>
                  </div>

                  <div className="playlist-admin__upload-form-group">
                    <label className="playlist-admin__upload-form-label">Nombre</label>
                    <input type="text" value={uploadNombre} onChange={(e) => setUploadNombre(e.target.value)} className="playlist-admin__upload-form-input" />
                  </div>

                  <div className="playlist-admin__upload-form-group">
                    <label className="playlist-admin__upload-form-label">Variantes / Etiquetas</label>
                    <div className="playlist-admin__chips">
                      {uploadVariantes.map((v, i) => (
                        <span key={i} className="playlist-admin__chip">
                          {v}
                          <button onClick={() => removeVariante(i)} className="playlist-admin__chip-remove">×</button>
                        </span>
                      ))}
                    </div>
                    <div className="playlist-admin__upload-form-row">
                      <input
                        type="text" value={nuevaVarianteInput}
                        onChange={(e) => { setNuevaVarianteInput(e.target.value); setVarianteError(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); anadirVariante(); } }}
                        placeholder="Ej: La base de david"
                        className={`playlist-admin__upload-form-input ${varianteError ? "playlist-admin__upload-form-input--error" : ""}`}
                      />
                      <button onClick={anadirVariante} className="playlist-admin__upload-form-add">Añadir</button>
                    </div>
                    {varianteError && <p className="playlist-admin__upload-form-error">{varianteError}</p>}
                  </div>

                  <button onClick={confirmUpload} disabled={isUploading} className="playlist-admin__upload-btn">
                    {isUploading ? "Subiendo..." : "Subir Canción"}
                  </button>
                </div>
              )}
            </section>
          )}

          {/* Sección Playlists */}
          <section className="playlist-admin__section">
            <div className="playlist-admin__section-header">
              <h2 className="playlist-admin__section-title">
                <LibraryIcon size={20} /> Playlists Globales
              </h2>
              {adminMode && (
                <button onClick={openCreatePlaylist} className="playlist-admin__btn-create">
                  <PlusIcon size={16} /> Nueva Playlist
                </button>
              )}
            </div>

            {loadingPlaylists ? (
              <p className="playlist-admin__empty">Cargando playlists...</p>
            ) : playlists.length === 0 ? (
              <p className="playlist-admin__empty">No hay playlists. ¡Crea una!</p>
            ) : (
              <div className={adminMode ? "playlist-admin__list" : "playlist-admin__grid"}>
                {adminMode && (
                  <div className="playlist-admin__list-header playlist-admin__list-header--playlists">
                    <div>#</div>
                    <div>Playlist</div>
                    <div>Canciones</div>
                    <div style={{ textAlign: "right" }}>Acciones</div>
                  </div>
                )}
                {playlists.map((pl) => (
                  <div
                    key={pl.id}
                    className={adminMode ? "playlist-admin__item playlist-admin__item--playlist" : "playlist-admin__card"}
                    onClick={() => {
                      if (adminMode) {
                        openAdminPlaylistSongs(pl);
                      } else {
                        router.push(`/playlist/${encodeURIComponent(pl.id)}`);
                      }
                    }}
                  >
                    {adminMode ? (
                      <>
                        <div className="playlist-admin__item-index">
                          {pl.iconUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={getMediaUrl(pl.iconUrl)} alt="" className="playlist-admin__playlist-icon" />
                          ) : (
                            <span className="playlist-admin__item-num"><ListMusicIcon size={16} /></span>
                          )}
                        </div>
                        <div className="playlist-admin__item-info">
                          <span className="playlist-admin__item-title">{pl.nombre}</span>
                          <span className="playlist-admin__item-date">URL: /playlist/{pl.id}</span>
                        </div>
                        <div className="playlist-admin__item-date">{pl.numCanciones} canciones</div>
                        <div className="playlist-admin__item-actions">
                          <button
                            className="playlist-admin__item-edit"
                            onClick={(e) => { e.stopPropagation(); openEditPlaylist(pl); }}
                            title="Editar playlist"
                          >
                            <PencilIcon size={16} />
                          </button>
                          <button
                            className="playlist-admin__item-delete"
                            onClick={(e) => { e.stopPropagation(); eliminarPlaylist(pl); }}
                            title="Eliminar playlist"
                          >
                            <TrashIcon size={16} />
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="playlist-admin__card-icon">
                          {pl.iconUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={getMediaUrl(pl.iconUrl)} alt="" className="playlist-admin__playlist-icon playlist-admin__playlist-icon--large" />
                          ) : (
                            <ListMusicIcon size={32} />
                          )}
                        </div>
                        <div className="playlist-admin__card-info">
                          <span className="playlist-admin__card-name">{pl.nombre}</span>
                          <span className="playlist-admin__card-count">{pl.numCanciones} canciones</span>
                        </div>
                        <button
                          className="playlist-admin__card-delete playlist-admin__card-share"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleShare("playlist", pl.id);
                          }}
                          title="Compartir playlist"
                        >
                          <ShareIcon size={16} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {adminMode && (
            <section className="playlist-admin__section">
            <div className="playlist-admin__section-header">
              <h2 className="playlist-admin__section-title">
                🎧 Todas las Canciones ({allCanciones.length})
              </h2>
            </div>

            {/* Buscador */}
            <div className="playlist-admin__search-bar">
              <SearchIcon size={16} />
              <input
                type="text"
                value={searchAllCanciones}
                onChange={(e) => setSearchAllCanciones(e.target.value)}
                placeholder="Buscar canción..."
                className="playlist-admin__search-input"
              />
              {searchAllCanciones && (
                <button onClick={() => setSearchAllCanciones("")} className="playlist-admin__search-clear">
                  <XIcon size={14} />
                </button>
              )}
            </div>

            {loadingAllCanciones ? (
              <p className="playlist-admin__empty">Cargando canciones...</p>
            ) : filteredAllCanciones.length === 0 ? (
              <p className="playlist-admin__empty">{searchAllCanciones ? "Sin resultados." : "No hay canciones en la base de datos."}</p>
            ) : (
              <div className="playlist-admin__list">
                <div className="playlist-admin__list-header">
                  <div>#</div>
                  <div>Título</div>
                  <div style={{ textAlign: "right" }}>Acciones</div>
                </div>
                {filteredAllCanciones.map((track, i) => (
                  <div key={track.id} className="playlist-admin__item">
                    <div className="playlist-admin__item-index">
                      <span className="playlist-admin__item-num">{i + 1}</span>
                    </div>
                    <div className="playlist-admin__item-info">
                      <span className="playlist-admin__item-title">{track.name}</span>
                      {track.variantes && track.variantes.length > 0 && (
                        <span className="playlist-admin__item-date">{track.variantes.join(", ")}</span>
                      )}
                    </div>
                    <div className="playlist-admin__item-actions">
                      <button
                        onClick={() => handleShare('song', track.id)}
                        className="playlist-admin__item-edit"
                        title="Compartir enlace de reproduccion"
                      >
                        <ShareIcon size={16} />
                      </button>
                      <button
                        onClick={() => openEditModal(track)}
                        className="playlist-admin__item-edit"
                        title="Editar canción"
                      >
                        <PencilIcon size={16} />
                      </button>
                      <button
                        onClick={() => handleDeleteFromDB(track)}
                        className="playlist-admin__item-delete"
                        title="Eliminar permanentemente de la BD"
                      >
                        <TrashIcon size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            </section>
          )}

          {adminMode && playlistEditorOpen && (
            <div className="playlist-admin__modal-overlay" onClick={() => setPlaylistEditorOpen(false)}>
              <div className="playlist-admin__modal" onClick={(e) => e.stopPropagation()}>
                <div className="playlist-admin__modal-header">
                  <h3>{editingPlaylist ? "Editar Playlist" : "Crear Playlist"}</h3>
                  <button onClick={() => setPlaylistEditorOpen(false)} className="playlist-admin__btn-cancel-small">✕</button>
                </div>

                <div className="playlist-admin__upload-form-group">
                  <label className="playlist-admin__upload-form-label">Nombre visible</label>
                  <input
                    type="text"
                    value={playlistEditorName}
                    onChange={(e) => setPlaylistEditorName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") savePlaylist(); }}
                    className="playlist-admin__upload-form-input"
                    placeholder="Nombre de la playlist"
                    autoFocus
                  />
                </div>

                <div className="playlist-admin__upload-form-group">
                  <label className="playlist-admin__upload-form-label">Icono</label>
                  <div className="playlist-admin__playlist-icon-editor">
                    <div className="playlist-admin__playlist-icon-preview">
                      {playlistEditorIconPreview ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={playlistEditorIconPreview} alt="" />
                      ) : (
                        <ListMusicIcon size={28} />
                      )}
                    </div>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handlePlaylistIconChange(e.target.files?.[0] ?? null)}
                      className="playlist-admin__upload-form-input"
                    />
                  </div>
                </div>

                {editingPlaylist && (
                  <p className="playlist-admin__item-date">
                    La URL se mantiene: /playlist/{editingPlaylist.id}
                  </p>
                )}

                <button onClick={savePlaylist} disabled={savingPlaylist} className="playlist-admin__upload-btn">
                  {savingPlaylist ? "Guardando..." : editingPlaylist ? "Guardar Cambios" : "Crear Playlist"}
                </button>
              </div>
            </div>
          )}

          {/* Modal de edición */}
          {adminMode && editingTrack && (
            <div className="playlist-admin__modal-overlay" onClick={closeEditModal}>
              <div className="playlist-admin__modal" onClick={(e) => e.stopPropagation()}>
                <div className="playlist-admin__modal-header">
                  <h3>Editar Canción</h3>
                  <button onClick={closeEditModal} className="playlist-admin__btn-cancel-small">✕</button>
                </div>

                <div className="playlist-admin__upload-form-group">
                  <label className="playlist-admin__upload-form-label">Nombre</label>
                  <input
                    type="text"
                    value={editNombre}
                    onChange={(e) => setEditNombre(e.target.value)}
                    className="playlist-admin__upload-form-input"
                  />
                </div>

                <div className="playlist-admin__upload-form-group">
                  <label className="playlist-admin__upload-form-label">Variantes / Etiquetas</label>
                  <div className="playlist-admin__chips">
                    {editVariantes.map((v, i) => (
                      <span key={i} className="playlist-admin__chip">
                        {v}
                        <button onClick={() => setEditVariantes(prev => prev.filter((_, idx) => idx !== i))} className="playlist-admin__chip-remove">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="playlist-admin__upload-form-row">
                    <input
                      type="text"
                      value={editNuevaVariante}
                      onChange={(e) => setEditNuevaVariante(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && editNuevaVariante.trim()) {
                          e.preventDefault();
                          setEditVariantes(prev => [...prev, editNuevaVariante.trim()]);
                          setEditNuevaVariante("");
                        }
                      }}
                      placeholder="Nueva variante..."
                      className="playlist-admin__upload-form-input"
                    />
                    <button
                      onClick={() => {
                        if (editNuevaVariante.trim()) {
                          setEditVariantes(prev => [...prev, editNuevaVariante.trim()]);
                          setEditNuevaVariante("");
                        }
                      }}
                      className="playlist-admin__upload-form-add"
                    >Añadir</button>
                  </div>
                </div>

                <button onClick={saveEdit} disabled={isSaving} className="playlist-admin__upload-btn">
                  {isSaving ? "Guardando..." : "Guardar Cambios"}
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    );
  }

  // ==========================================
  // VISTA 2: REPRODUCTOR DE PLAYLIST
  // ==========================================
  return (
    <main className="playlist-admin">
      <div className="playlist-admin__content">
        <header className="playlist-admin__header">
          <div>
            <button onClick={volverAPlaylists} className="playlist-admin__nav-back">
              <ArrowLeftIcon size={16} /> Volver a Playlists
            </button>
            <h1 className="playlist-admin__title">{currentPlaylist?.nombre ?? playlistActual}</h1>
            <p className="playlist-admin__subtitle">{playlist.length} canciones</p>
          </div>
          <div className="playlist-admin__header-actions">
            <button onClick={() => playlistActual && handleShare('playlist', playlistActual)} className="playlist-admin__btn-action" title="Compartir playlist completa" style={{ background: "transparent", border: "1px solid #1ed760", color: "#1ed760" }}>
              <ShareIcon size={16} /> Compartir Playlist
            </button>
            <button onClick={openSongPicker} className="playlist-admin__btn-action" title="Añadir canción a la playlist">
              <PlusIcon size={16} /> Añadir Canción
            </button>
            <button onClick={() => currentPlaylist && eliminarPlaylist(currentPlaylist)} className="playlist-admin__btn-action playlist-admin__btn-action--danger" title="Eliminar playlist">
              <TrashIcon size={16} /> Eliminar
            </button>
          </div>

          {/* Panel de búsqueda de canciones para añadir */}
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
                <button onClick={() => setShowSongPicker(false)} className="playlist-admin__btn-cancel-small">✕</button>
              </div>
              <div className="playlist-admin__song-picker-list">
                {filteredPickerSongs.length === 0 ? (
                  <p className="playlist-admin__empty">No hay canciones disponibles para añadir.</p>
                ) : (
                  filteredPickerSongs.map((song) => (
                    <div
                      key={song.id}
                      className="playlist-admin__song-picker-item"
                      onClick={() => { addSongToPlaylist(song.name); }}
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
        </header>

        {message && (
          <div className={`playlist-admin__message playlist-admin__message--${message.type}`}>
            {message.text}
          </div>
        )}

        <section className="playlist-admin__list">
          {/* Buscador dentro de playlist */}
          <div className="playlist-admin__search-bar">
            <SearchIcon size={16} />
            <input
              type="text"
              value={searchPlaylistCanciones}
              onChange={(e) => setSearchPlaylistCanciones(e.target.value)}
              placeholder="Buscar en esta playlist..."
              className="playlist-admin__search-input"
            />
            {searchPlaylistCanciones && (
              <button onClick={() => setSearchPlaylistCanciones("")} className="playlist-admin__search-clear">
                <XIcon size={14} />
              </button>
            )}
          </div>

          <div className="playlist-admin__list-header">
            <div>#</div>
            <div>Título</div>
            <div style={{ textAlign: "right" }}>Acciones</div>
          </div>

          {loading ? (
            <p className="playlist-admin__empty">Cargando canciones...</p>
          ) : filteredPlaylist.length === 0 ? (
            <p className="playlist-admin__empty">{searchPlaylistCanciones ? "Sin resultados." : "No hay canciones. ¡Usa \"Añadir Canción\" para llenarla!"}</p>
          ) : (
            filteredPlaylist.map((track, i) => (
              <div
                key={track.id}
                className={`playlist-admin__item ${currentTrack?.id === track.id ? "playlist-admin__item--active" : ""}`}
                onClick={() => playSong(track)}
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
                    onClick={(e) => { e.stopPropagation(); handleShare('song', track.id); }}
                    className="playlist-admin__item-edit"
                    title="Compartir enlace de reproduccion"
                  >
                    <ShareIcon size={16} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRemoveFromPlaylist(track); }}
                    className="playlist-admin__item-delete"
                    title="Quitar de esta playlist"
                  >
                    <TrashIcon size={16} />
                  </button>
                </div>
              </div>
            ))
          )}
        </section>
      </div>

      {/* Reproductor fijo */}
      <div className="playlist-admin__player">
        {/* Izquierda: Canción actual */}
        <div className="playlist-admin__now-playing">
          {currentTrack ? (
            <>
              <span className="playlist-admin__now-playing-title">{currentTrack.name}</span>
              <span className="playlist-admin__now-playing-pitch">Pitch: {playbackPitch.toFixed(2)}x</span>
            </>
          ) : (
            <span className="playlist-admin__now-playing-title" style={{ color: '#666' }}>Sin canción</span>
          )}
        </div>

        {/* Centro: Controles + Barra de progreso */}
        <div className="playlist-admin__player-center">
          <div className="playlist-admin__player-buttons">
            <button
              className={`playlist-admin__control-btn playlist-admin__control-btn--shuffle ${isShuffle ? 'playlist-admin__control-btn--active' : ''}`}
              onClick={() => setIsShuffle(v => !v)}
              title={isShuffle ? 'Aleatorio activado' : 'En orden'}
            >
              {isShuffle ? <ShuffleIcon size={16} /> : <ArrowRightIcon size={16} />}
            </button>
            <button className="playlist-admin__control-btn" onClick={playPrev}>⏮</button>
            <button className="playlist-admin__control-btn playlist-admin__control-btn--play" onClick={togglePlayPause}>
              {isPlaying ? "⏸" : "▶"}
            </button>
            <button className="playlist-admin__control-btn" onClick={playNext}>⏭</button>
          </div>

          {/* Barra de progreso */}
          <div className="playlist-admin__progress">
            <span className="playlist-admin__progress-time">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              value={currentTime}
              onChange={(e) => handleSeek(Number(e.target.value))}
              className="playlist-admin__progress-bar"
            />
            <span className="playlist-admin__progress-time">{formatTime(duration)}</span>
          </div>
        </div>

        {/* Derecha: Pitch + Volumen */}
        <div className="playlist-admin__player-right">
          {/* Pitch slider */}
          <div className="playlist-admin__slider-group">
            <button
              className={`playlist-admin__control-btn playlist-admin__control-btn--pitch-toggle ${autoRandomPitch ? 'playlist-admin__control-btn--active' : ''}`}
              onClick={() => setAutoRandomPitch(v => !v)}
              title={autoRandomPitch ? 'Pitch aleatorio al cambiar canción' : 'Pitch fijo (manual)'}
            >
              <DicesIcon size={16} />
            </button>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.01}
              value={playbackPitch}
              onChange={(e) => handlePitchChange(Number(e.target.value))}
              className="playlist-admin__mini-slider"
              title={`Pitch: ${playbackPitch.toFixed(2)}x`}
            />
          </div>

          {/* Volume slider */}
          <div className="playlist-admin__slider-group">
            <button
              className="playlist-admin__control-btn"
              onClick={() => handleVolumeChange(volume > 0 ? 0 : 0.8)}
              title={volume > 0 ? 'Silenciar' : 'Restaurar volumen'}
            >
              {volume > 0 ? <Volume2Icon size={16} /> : <VolumeXIcon size={16} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              className="playlist-admin__mini-slider"
              title={`Volumen: ${Math.round(volume * 100)}%`}
            />
          </div>
        </div>

        <audio
          ref={audioRef}
          src={currentTrack?.url || undefined}
          onEnded={playNext}
          onPause={() => setIsPlaying(false)}
          onPlay={() => setIsPlaying(true)}
          onTimeUpdate={() => {
            if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
          }}
          onLoadedMetadata={() => {
            if (audioRef.current) {
              setDuration(audioRef.current.duration);
              audioRef.current.volume = volume;
              audioRef.current.preservesPitch = false;
              audioRef.current.playbackRate = playbackPitch;
            }
          }}
          style={{ display: "none" }}
        />
      </div>
    </main>
  );
}
