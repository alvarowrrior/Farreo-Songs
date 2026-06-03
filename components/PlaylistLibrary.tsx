"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TrashIcon, PlusIcon, ListMusicIcon, ArrowLeftIcon, LibraryIcon, SearchIcon, ShuffleIcon, ArrowRightIcon, Volume2Icon, VolumeXIcon, DicesIcon, PencilIcon, XIcon, ShareIcon, PlayIcon, PauseIcon, SkipBackIcon, SkipForwardIcon, LockIcon, GlobeIcon, Mic2Icon, RotateCcwIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { MusicLyricsBar, useMusicPlayer } from "@/components/MusicPlayerProvider";
import {
  addSongToPrivatePlaylist,
  createPrivatePlaylist,
  deletePrivatePlaylist,
  listOwnPrivatePlaylists,
  removeSongFromPrivatePlaylist,
  updatePrivatePlaylist,
  type PrivatePlaylist,
  type PrivatePlaylistVisibility,
} from "@/lib/privatePlaylists";
import { listFollowedGlobalPlaylistIds } from "@/lib/globalPlaylistFollows";
import { useHiddenSongs } from "@/lib/useHiddenSongs";

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
  lyricsSrt?: string | null;
  lyricsUrl?: string | null;
  lyricsFileName?: string | null;
  duration?: number | null;
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
type PlaylistScope = "global" | "private";

interface PlaylistLibraryProps {
  adminMode?: boolean;
}

export default function PlaylistLibrary({ adminMode = false }: PlaylistLibraryProps) {
  const router = useRouter();
  const { isVisible, hiddenIds, hide, unhide } = useHiddenSongs();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(adminMode);
  const [isAuthorized, setIsAuthorized] = useState(!adminMode);

  // Vista actual
  const [vista, setVista] = useState<Vista>("playlists");
  const [playlistActual, setPlaylistActual] = useState<string | null>(null);
  const [playlistScope, setPlaylistScope] = useState<PlaylistScope>("global");

  // Playlists
  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([]);
  const [privatePlaylists, setPrivatePlaylists] = useState<PrivatePlaylist[]>([]);
  const [followedGlobalPlaylistIds, setFollowedGlobalPlaylistIds] = useState<string[]>([]);
  const [loadingPrivatePlaylists, setLoadingPrivatePlaylists] = useState(false);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [playlistEditorOpen, setPlaylistEditorOpen] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistInfo | null>(null);
  const [editingPrivatePlaylist, setEditingPrivatePlaylist] = useState<PrivatePlaylist | null>(null);
  const [playlistEditorName, setPlaylistEditorName] = useState("");
  const [playlistEditorIconFile, setPlaylistEditorIconFile] = useState<File | null>(null);
  const [playlistEditorIconPreview, setPlaylistEditorIconPreview] = useState("");
  const [playlistEditorVisibility, setPlaylistEditorVisibility] = useState<PrivatePlaylistVisibility>("private");
  const [playlistEditorKind, setPlaylistEditorKind] = useState<PlaylistScope>("global");
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
  const [uploadLyricsFile, setUploadLyricsFile] = useState<File | null>(null);
  const [nuevaVarianteInput, setNuevaVarianteInput] = useState("");
  const [varianteError, setVarianteError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [etiquetasExistentes, setEtiquetasExistentes] = useState<Record<string, string>>({});

  // Reproductor
  const {
    currentTrack,
    currentSource,
    isPlaying,
    playbackPitch,
    volume,
    currentTime,
    visualCurrentTime,
    duration,
    isShuffle,
    autoRandomPitch,
    lyricsEnabled,
    toggleTrack,
    playNext,
    playPrev,
    togglePlayPause,
    handleVolumeChange,
    handlePitchChange,
    handleSeek,
    setAutoRandomPitch,
    setIsShuffle,
    setLyricsEnabled,
    stop,
  } = useMusicPlayer();
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
  const [editLyricsFile, setEditLyricsFile] = useState<File | null>(null);
  const [editRemoveLyrics, setEditRemoveLyrics] = useState(false);
  const [editNuevaVariante, setEditNuevaVariante] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Share modal
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareSongTitle, setShareSongTitle] = useState("");
  const [shareSongLink, setShareSongLink] = useState("");
  const [shareInternalLink, setShareInternalLink] = useState("");
  const [copiedLink, setCopiedLink] = useState<'normal' | 'internal' | null>(null);

  useEffect(() => {
    if (!auth) {
      loadPlaylists();
      if (adminMode) setIsAuthorized(false);
      setIsCheckingAuth(false);
      return;
    }

    const unsub = onAuthStateChanged(auth, (u) => {
      setCurrentUser(u);
      const authorized = Boolean(u?.email && ADMIN_EMAILS.includes(u.email));
      if (adminMode) setIsAuthorized(authorized);

      loadPlaylists();
      if (u) {
        loadPrivatePlaylists(u.uid);
        loadFollowedGlobalPlaylists(u.uid);
      } else {
        setPrivatePlaylists([]);
        setFollowedGlobalPlaylistIds([]);
      }

      if (adminMode && authorized) {
        loadEtiquetas();
        loadAllCanciones();
      }

      setIsCheckingAuth(false);
    });

    return () => unsub();
    // loadPlaylists/loadPrivatePlaylists are intentionally triggered from auth state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const loadPrivatePlaylists = async (ownerId = currentUser?.uid) => {
    if (!ownerId) {
      setPrivatePlaylists([]);
      return;
    }

    try {
      setLoadingPrivatePlaylists(true);
      setPrivatePlaylists(await listOwnPrivatePlaylists(ownerId));
    } catch {
      setMessage({ type: "error", text: "No se pudieron cargar tus playlists propias." });
    } finally {
      setLoadingPrivatePlaylists(false);
    }
  };

  const loadFollowedGlobalPlaylists = async (ownerId = currentUser?.uid) => {
    if (!ownerId) {
      setFollowedGlobalPlaylistIds([]);
      return;
    }

    try {
      setFollowedGlobalPlaylistIds(await listFollowedGlobalPlaylistIds(ownerId));
    } catch {
      setFollowedGlobalPlaylistIds([]);
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
    setPlaylistScope("global");
    setPlaylist([]);

    loadPlaylists();
    loadAllCanciones();
    loadPrivatePlaylists();
    loadFollowedGlobalPlaylists();
  };

  const loadPrivatePlaylistCanciones = async (songIds: string[]) => {
    try {
      setLoading(true);
      const res = await fetch(`${TUNNEL_URL}/canciones`);
      if (res.ok) {
        const data = (await res.json()) as PlaylistItem[];
        const songSet = new Set(songIds);
        const absoluteData = data
          .filter((item) => songSet.has(item.id))
          .map((item) => ({
            ...item,
            url: getMediaUrl(item.url),
          }));
        setPlaylist(absoluteData);
      }
    } catch {
      setMessage({ type: "error", text: "No se pudo cargar esta playlist." });
    } finally {
      setLoading(false);
    }
  };

  const openAdminPlaylistSongs = (playlist: PlaylistInfo) => {
    setPlaylistActual(playlist.id);
    setPlaylistScope("global");
    setVista("canciones");
    setSearchPlaylistCanciones("");
    setShowSongPicker(false);
    loadPlaylistCanciones(playlist.id);
  };

  const openPrivatePlaylistSongs = (playlist: PrivatePlaylist) => {
    setPlaylistActual(playlist.id);
    setPlaylistScope("private");
    setVista("canciones");
    setSearchPlaylistCanciones("");
    setShowSongPicker(false);
    loadPrivatePlaylistCanciones(playlist.songIds);
  };

  const openCreatePlaylist = () => {
    setEditingPlaylist(null);
    setEditingPrivatePlaylist(null);
    setPlaylistEditorKind("global");
    setPlaylistEditorName("");
    setPlaylistEditorIconFile(null);
    setPlaylistEditorIconPreview("");
    setPlaylistEditorOpen(true);
  };

  const openCreatePrivatePlaylist = () => {
    if (!currentUser) {
      setMessage({ type: "error", text: "Inicia sesion para crear playlists propias." });
      return;
    }

    setEditingPlaylist(null);
    setEditingPrivatePlaylist(null);
    setPlaylistEditorKind("private");
    setPlaylistEditorVisibility("private");
    setPlaylistEditorName("");
    setPlaylistEditorIconFile(null);
    setPlaylistEditorIconPreview("");
    setPlaylistEditorOpen(true);
  };

  const openEditPlaylist = (playlist: PlaylistInfo) => {
    setEditingPlaylist(playlist);
    setEditingPrivatePlaylist(null);
    setPlaylistEditorKind("global");
    setPlaylistEditorName(playlist.nombre);
    setPlaylistEditorIconFile(null);
    setPlaylistEditorIconPreview(getMediaUrl(playlist.iconUrl));
    setPlaylistEditorOpen(true);
  };

  const openEditPrivatePlaylist = (playlist: PrivatePlaylist) => {
    setEditingPlaylist(null);
    setEditingPrivatePlaylist(playlist);
    setPlaylistEditorKind("private");
    setPlaylistEditorVisibility(playlist.visibility);
    setPlaylistEditorName(playlist.nombre);
    setPlaylistEditorIconFile(null);
    setPlaylistEditorIconPreview(playlist.iconUrl || "");
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
      if (playlistEditorKind === "private") {
        if (!currentUser) throw new Error("Inicia sesion para guardar playlists propias.");

        if (editingPrivatePlaylist) {
          await updatePrivatePlaylist(editingPrivatePlaylist.id, {
            nombre: displayName,
            iconUrl: playlistEditorIconPreview || null,
            visibility: playlistEditorVisibility,
          });
          setMessage({ type: "success", text: "Playlist propia actualizada." });
        } else {
          await createPrivatePlaylist({
            ownerId: currentUser.uid,
            ownerEmail: currentUser.email,
            nombre: displayName,
            iconUrl: playlistEditorIconPreview || null,
            visibility: playlistEditorVisibility,
          });
          setMessage({ type: "success", text: "Playlist propia creada." });
        }

        setPlaylistEditorOpen(false);
        setEditingPrivatePlaylist(null);
        setPlaylistEditorName("");
        setPlaylistEditorIconFile(null);
        setPlaylistEditorIconPreview("");
        loadPrivatePlaylists(currentUser.uid);
        return;
      }

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
      setEditingPrivatePlaylist(null);
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

  const eliminarPrivatePlaylist = async (playlist: PrivatePlaylist) => {
    if (!window.confirm(`¿Eliminar la playlist propia "${playlist.nombre}"?`)) return;
    try {
      await deletePrivatePlaylist(playlist.id);
      setMessage({ type: "success", text: "Playlist propia eliminada." });
      if (playlistActual === playlist.id) volverAPlaylists();
      else loadPrivatePlaylists();
    } catch {
      setMessage({ type: "error", text: "Error eliminando playlist propia." });
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
    if (playlistScope === "private") {
      try {
        await addSongToPrivatePlaylist(playlistActual, nombreCancion);
        const updated = privatePlaylists.map((item) =>
          item.id === playlistActual && !item.songIds.includes(nombreCancion)
            ? { ...item, songIds: [...item.songIds, nombreCancion] }
            : item
        );
        setPrivatePlaylists(updated);
        const active = updated.find((item) => item.id === playlistActual);
        if (active) loadPrivatePlaylistCanciones(active.songIds);
        setMessage({ type: "success", text: "Canción añadida." });
      } catch {
        setMessage({ type: "error", text: "Error añadiendo canción." });
      }
      return;
    }

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
    setUploadLyricsFile(null);
    setNuevaVarianteInput("");
    setVarianteError(null);
  };

  const selectLyricsFile = (file: File | null, setter: (file: File | null) => void) => {
    if (!file) {
      setter(null);
      return;
    }

    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith(".srt") && !lowerName.endsWith(".vtt")) {
      setMessage({ type: "error", text: "Las lyrics deben ser un archivo .srt o .vtt." });
      setter(null);
      return;
    }

    setter(file);
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
    if (uploadLyricsFile) {
      formData.append("lyrics", uploadLyricsFile);
    }
    formData.append("metadata", JSON.stringify({
      nombre: uploadNombre.trim() || pendingUpload.name,
      variantes: uploadVariantes
    }));
    try {
      const res = await fetch(`${TUNNEL_URL}/upload`, { method: 'POST', body: formData });
      if (res.ok) {
        setMessage({ type: "success", text: "¡Canción subida!" });
        setPendingUpload(null);
        setUploadLyricsFile(null);
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
  // REPRODUCTOR (Usando context global)
  // ==========================================

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  };

  // ==========================================
  // COMPARTIR
  // ==========================================
  const handleShare = (type: 'song' | 'playlist', identifier: string) => {
    if (type === "playlist") {
      const url = `${window.location.origin}/playlist/${encodeURIComponent(identifier)}`;
      navigator.clipboard.writeText(url)
        .then(() => setMessage({ type: "success", text: "Enlace copiado al portapapeles." }))
        .catch(() => setMessage({ type: "error", text: "Error copiando el enlace." }));
    } else {
      const song = allSongs.find(s => s.id === identifier) || playlist.find(s => s.id === identifier) || allCanciones.find(s => s.id === identifier);
      if (!song) return;
      setShareSongTitle(song.name);
      setShareSongLink(`${window.location.origin}/play?song=${encodeURIComponent(song.id)}`);
      setShareInternalLink(getMediaUrl(song.url));
      setCopiedLink(null);
      setShareModalOpen(true);
    }
  };

  const handleSharePrivatePlaylist = (playlist: PrivatePlaylist) => {
    if (playlist.visibility !== "public") {
      setMessage({ type: "error", text: "No puedes compartir una playlist privada. Hazla pública primero." });
      return;
    }

    const url = `${window.location.origin}/user-playlist/${encodeURIComponent(playlist.id)}`;
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
    setEditLyricsFile(null);
    setEditRemoveLyrics(false);
    setEditNuevaVariante("");
  };

  const closeEditModal = () => {
    setEditingTrack(null);
    setEditNombre("");
    setEditVariantes([]);
    setEditLyricsFile(null);
    setEditRemoveLyrics(false);
    setEditNuevaVariante("");
  };

  const saveEdit = async () => {
    if (!editingTrack) return;
    setIsSaving(true);
    try {
      const formData = new FormData();
      if (editLyricsFile) {
        formData.append("lyrics", editLyricsFile);
      }
      formData.append("metadata", JSON.stringify({
        nombre: editNombre.trim(),
        variantes: editVariantes,
        removeLyrics: editRemoveLyrics,
      }));

      const res = await fetch(`${TUNNEL_URL}/cancion/${editingTrack.id}`, {
        method: 'PUT',
        body: formData
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

  const toggleHidden = async (track: PlaylistItem) => {
    try {
      if (hiddenIds.has(track.id)) {
        await unhide(track.id);
        setMessage({ type: "success", text: `"${track.name}" ahora es visible para todos.` });
      } else {
        await hide(track.id);
        setMessage({ type: "success", text: `"${track.name}" oculta: solo la verán los admins.` });
      }
    } catch {
      setMessage({ type: "error", text: "No se pudo cambiar la visibilidad." });
    }
  };

  // ==========================================
  // FILTROS DE BÚSQUEDA
  // ==========================================

  const filteredAllCanciones = allCanciones.filter(t => {
    if (!isVisible(t.id)) return false;
    if (!searchAllCanciones.trim()) return true;
    const q = searchAllCanciones.toLowerCase();
    return t.name.toLowerCase().includes(q) ||
      (t.variantes && t.variantes.some(v => v.toLowerCase().includes(q)));
  });

  const filteredPlaylist = playlist.filter(t => {
    if (!isVisible(t.id)) return false;
    if (!searchPlaylistCanciones.trim()) return true;
    const q = searchPlaylistCanciones.toLowerCase();
    return t.name.toLowerCase().includes(q) ||
      (t.variantes && t.variantes.some(v => v.toLowerCase().includes(q)));
  });

  const currentPlaylist = playlistActual
    ? playlists.find((item) => item.id === playlistActual) ?? null
    : null;
  const currentPrivatePlaylist = playlistActual
    ? privatePlaylists.find((item) => item.id === playlistActual) ?? null
    : null;
  const followedGlobalPlaylists = playlists.filter((playlist) =>
    followedGlobalPlaylistIds.includes(playlist.id)
  );
  const progressPercent = duration > 0
    ? Math.min(100, Math.max(0, (visualCurrentTime / duration) * 100))
    : 0;
  const progressFill = progressPercent <= 0
    ? "0%"
    : progressPercent >= 100
      ? "100%"
      : `calc(${progressPercent}% + ${6 - (progressPercent * 0.12)}px)`;
  const shareSongModal = shareModalOpen ? (
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
  ) : null;

  // Borrar canción DE LA BD (mp3 + json + de todas las playlists)
  const handleDeleteFromDB = async (item: PlaylistItem) => {
    if (!window.confirm(`¿BORRAR PERMANENTEMENTE "${item.name}" de la base de datos?`)) return;
    try {
      const res = await fetch(`${TUNNEL_URL}/cancion/${item.id}`, { method: 'DELETE' });
      if (res.ok) {
        setMessage({ type: "success", text: "Canción eliminada de la base de datos." });
        if (currentTrack?.id === item.id) {
          stop();
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
    if (playlistScope === "private") {
      try {
        await removeSongFromPrivatePlaylist(playlistActual, item.id);
        const updated = privatePlaylists.map((playlistItem) =>
          playlistItem.id === playlistActual
            ? { ...playlistItem, songIds: playlistItem.songIds.filter((songId) => songId !== item.id) }
            : playlistItem
        );
        setPrivatePlaylists(updated);
        const active = updated.find((playlistItem) => playlistItem.id === playlistActual);
        if (active) loadPrivatePlaylistCanciones(active.songIds);
        if (currentTrack?.id === item.id) stop();
        setMessage({ type: "success", text: `"${item.name}" quitada de la playlist.` });
      } catch {
        setMessage({ type: "error", text: "Error quitando canción de la playlist." });
      }
      return;
    }

    try {
      const res = await fetch(
        `${TUNNEL_URL}/playlist/${encodeURIComponent(playlistActual)}/song?cancion=${encodeURIComponent(item.name)}`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        setMessage({ type: "success", text: `"${item.name}" quitada de la playlist.` });
        if (currentTrack?.id === item.id) {
          stop();
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
              <Link href="/admin/lyrics" className="playlist-admin__lyrics-editor-link">
                <Mic2Icon size={18} /> Editor de Lyrics
              </Link>
            </section>
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
                    <button onClick={() => { setPendingUpload(null); setUploadLyricsFile(null); }} className="playlist-admin__upload-form-change">Cambiar</button>
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

                  <div className="playlist-admin__upload-form-group">
                    <label className="playlist-admin__upload-form-label">Lyrics SRT/VTT</label>
                    <input
                      type="file"
                      accept=".srt,.vtt,application/x-subrip,text/vtt,text/plain"
                      onChange={(e) => selectLyricsFile(e.target.files?.[0] ?? null, setUploadLyricsFile)}
                      className="playlist-admin__upload-form-input"
                    />
                    <p className="playlist-admin__item-date">
                      {uploadLyricsFile ? `Archivo seleccionado: ${uploadLyricsFile.name}` : "Opcional. Puedes subir SRT o VTT."}
                    </p>
                  </div>

                  <button onClick={confirmUpload} disabled={isUploading} className="playlist-admin__upload-btn">
                    {isUploading ? "Subiendo..." : "Subir Canción"}
                  </button>
                </div>
              )}
            </section>
          )}

          {currentUser && !adminMode && (
            <section className="playlist-admin__section">
              <div className="playlist-admin__section-header">
                <h2 className="playlist-admin__section-title">
                  <LibraryIcon size={20} /> Playlists Propias
                </h2>
                <button onClick={openCreatePrivatePlaylist} className="playlist-admin__btn-create">
                  <PlusIcon size={16} /> Nueva Propia
                </button>
              </div>

              {loadingPrivatePlaylists ? (
                <p className="playlist-admin__empty">Cargando tus playlists...</p>
              ) : privatePlaylists.length === 0 && followedGlobalPlaylists.length === 0 ? (
                <p className="playlist-admin__empty">No tienes playlists propias.</p>
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
                  {privatePlaylists.map((pl) => (
                    <div
                      key={pl.id}
                      className={adminMode ? "playlist-admin__item playlist-admin__item--playlist" : "playlist-admin__card"}
                      onClick={() => {
                        if (adminMode) openPrivatePlaylistSongs(pl);
                        else router.push(`/user-playlist/${encodeURIComponent(pl.id)}`);
                      }}
                    >
                      {adminMode ? (
                        <>
                          <div className="playlist-admin__item-index">
                            {pl.iconUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={pl.iconUrl} alt="" className="playlist-admin__playlist-icon" />
                            ) : (
                              <span className="playlist-admin__item-num"><ListMusicIcon size={16} /></span>
                            )}
                          </div>
                          <div className="playlist-admin__item-info">
                            <span className="playlist-admin__item-title">{pl.nombre}</span>
                            <span className="playlist-admin__item-date">{pl.visibility === "public" ? "Pública" : "Privada"}</span>
                          </div>
                          <div className="playlist-admin__item-date">{pl.songIds.length} canciones</div>
                          <div className="playlist-admin__item-actions">
                            <button className="playlist-admin__item-edit" onClick={(e) => { e.stopPropagation(); handleSharePrivatePlaylist(pl); }} title="Compartir playlist">
                              <ShareIcon size={16} />
                            </button>
                            <button className="playlist-admin__item-edit" onClick={(e) => { e.stopPropagation(); openEditPrivatePlaylist(pl); }} title="Editar playlist">
                              <PencilIcon size={16} />
                            </button>
                            <button className="playlist-admin__item-delete" onClick={(e) => { e.stopPropagation(); eliminarPrivatePlaylist(pl); }} title="Eliminar playlist">
                              <TrashIcon size={16} />
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="playlist-admin__card-icon">
                            {pl.iconUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={pl.iconUrl} alt="" className="playlist-admin__playlist-icon playlist-admin__playlist-icon--large" />
                            ) : (
                              <ListMusicIcon size={32} />
                            )}
                          </div>
                          <div className="playlist-admin__card-info">
                            <span className="playlist-admin__card-name">{pl.nombre}</span>
                            <span className="playlist-admin__card-count">
                              {pl.songIds.length} canciones · {pl.visibility === "public" ? "Pública" : "Privada"}
                            </span>
                          </div>
                          <button
                            className="playlist-admin__card-delete playlist-admin__card-share"
                            onClick={(e) => { e.stopPropagation(); handleSharePrivatePlaylist(pl); }}
                            title="Compartir playlist"
                          >
                            <ShareIcon size={16} />
                          </button>
                          <button
                            className="playlist-admin__card-delete playlist-admin__card-edit"
                            onClick={(e) => { e.stopPropagation(); openEditPrivatePlaylist(pl); }}
                            title="Editar playlist"
                          >
                            <PencilIcon size={16} />
                          </button>
                          <button
                            className="playlist-admin__card-delete playlist-admin__card-remove"
                            onClick={(e) => { e.stopPropagation(); eliminarPrivatePlaylist(pl); }}
                            title="Eliminar playlist"
                          >
                            <TrashIcon size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                  {followedGlobalPlaylists.map((pl) => (
                    <div
                      key={`followed-${pl.id}`}
                      className="playlist-admin__card"
                      onClick={() => router.push(`/playlist/${encodeURIComponent(pl.id)}`)}
                    >
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
                        <span className="playlist-admin__card-count">{pl.numCanciones} canciones · Siguiendo</span>
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
                    </div>
                  ))}
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
                      <span className="playlist-admin__item-title">
                        {track.name}
                        {hiddenIds.has(track.id) && (
                          <span className="playlist-admin__item-hidden-badge">Oculta</span>
                        )}
                      </span>
                      {track.variantes && track.variantes.length > 0 && (
                        <span className="playlist-admin__item-date">{track.variantes.join(", ")}</span>
                      )}
                    </div>
                    <div className="playlist-admin__item-actions">
                      <button
                        onClick={() => toggleHidden(track)}
                        className="playlist-admin__item-edit"
                        title={hiddenIds.has(track.id) ? "Mostrar a todos" : "Ocultar (solo admins la verán)"}
                      >
                        {hiddenIds.has(track.id) ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
                      </button>
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

          {playlistEditorOpen && (adminMode || playlistEditorKind === "private") && (
            <div className="playlist-admin__modal-overlay" onClick={() => setPlaylistEditorOpen(false)}>
              <div className="playlist-admin__modal" onClick={(e) => e.stopPropagation()}>
                <div className="playlist-admin__modal-header">
                  <h3>{editingPlaylist || editingPrivatePlaylist ? "Editar Playlist" : "Crear Playlist"}</h3>
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

                {playlistEditorKind === "private" && (
                  <div className="playlist-admin__upload-form-group">
                    <label className="playlist-admin__upload-form-label">Visibilidad</label>
                    <div className="playlist-admin__chips">
                      <button
                        type="button"
                        className={`playlist-admin__chip ${playlistEditorVisibility === "private" ? "" : "playlist-admin__chip--muted"}`}
                        onClick={() => setPlaylistEditorVisibility("private")}
                      >
                        <LockIcon size={14} /> Privada
                      </button>
                      <button
                        type="button"
                        className={`playlist-admin__chip ${playlistEditorVisibility === "public" ? "" : "playlist-admin__chip--muted"}`}
                        onClick={() => setPlaylistEditorVisibility("public")}
                      >
                        <GlobeIcon size={14} /> Pública
                      </button>
                    </div>
                  </div>
                )}

                {editingPlaylist && (
                  <p className="playlist-admin__item-date">
                    La URL se mantiene: /playlist/{editingPlaylist.id}
                  </p>
                )}

                {editingPrivatePlaylist && (
                  <p className="playlist-admin__item-date">
                    La URL se mantiene: /user-playlist/{editingPrivatePlaylist.id}
                  </p>
                )}

                <button onClick={savePlaylist} disabled={savingPlaylist} className="playlist-admin__upload-btn">
                  {savingPlaylist ? "Guardando..." : editingPlaylist || editingPrivatePlaylist ? "Guardar Cambios" : "Crear Playlist"}
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

                <div className="playlist-admin__upload-form-group">
                  <label className="playlist-admin__upload-form-label">Lyrics SRT/VTT</label>
                  <input
                    type="file"
                    accept=".srt,.vtt,application/x-subrip,text/vtt,text/plain"
                    onChange={(e) => {
                      const file = e.target.files?.[0] ?? null;
                      selectLyricsFile(file, setEditLyricsFile);
                      if (file) setEditRemoveLyrics(false);
                    }}
                    className="playlist-admin__upload-form-input"
                  />
                  <p className="playlist-admin__item-date">
                    {editLyricsFile
                      ? `Nuevo archivo: ${editLyricsFile.name}`
                      : editingTrack.lyricsSrt
                        ? `Lyrics actuales: ${editingTrack.lyricsFileName || "archivo cargado"}`
                        : "Sin lyrics cargadas."}
                  </p>
                  {editingTrack.lyricsSrt && (
                    <button
                      type="button"
                      onClick={() => { setEditRemoveLyrics((value) => !value); setEditLyricsFile(null); }}
                      className={`playlist-admin__chip ${editRemoveLyrics ? "" : "playlist-admin__chip--muted"}`}
                    >
                      {editRemoveLyrics ? "Se quitaran al guardar" : "Quitar lyrics"}
                    </button>
                  )}
                </div>

                <button onClick={saveEdit} disabled={isSaving} className="playlist-admin__upload-btn">
                  {isSaving ? "Guardando..." : "Guardar Cambios"}
                </button>
              </div>
            </div>
          )}
          {shareSongModal}
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
            <h1 className="playlist-admin__title">{currentPlaylist?.nombre ?? currentPrivatePlaylist?.nombre ?? playlistActual}</h1>
            <p className="playlist-admin__subtitle">{playlist.length} canciones</p>
          </div>
          <div className="playlist-admin__header-actions">
            <button
              onClick={() => {
                if (playlistScope === "private" && currentPrivatePlaylist) handleSharePrivatePlaylist(currentPrivatePlaylist);
                else if (playlistActual) handleShare('playlist', playlistActual);
              }}
              className="playlist-admin__btn-action"
              title="Compartir playlist completa"
              style={{ background: "transparent", border: "1px solid #1ed760", color: "#1ed760" }}
            >
              <ShareIcon size={16} /> Compartir Playlist
            </button>
            <button onClick={openSongPicker} className="playlist-admin__btn-action" title="Añadir canción a la playlist">
              <PlusIcon size={16} /> Añadir Canción
            </button>
            <button
              onClick={() => {
                if (playlistScope === "private" && currentPrivatePlaylist) eliminarPrivatePlaylist(currentPrivatePlaylist);
                else if (currentPlaylist) eliminarPlaylist(currentPlaylist);
              }}
              className="playlist-admin__btn-action playlist-admin__btn-action--danger"
              title="Eliminar playlist"
            >
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
                      onClick={() => { addSongToPlaylist(playlistScope === "private" ? song.id : song.name); }}
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
                onClick={() => toggleTrack(track, playlist, playlistScope === "private" && currentPrivatePlaylist ? {
                  id: currentPrivatePlaylist.id,
                  name: currentPrivatePlaylist.nombre,
                  type: "private",
                } : currentPlaylist ? {
                  id: currentPlaylist.id,
                  name: currentPlaylist.nombre,
                  type: "admin",
                } : null)}
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
      <MusicLyricsBar />
      <div className="playlist-admin__player">
        {/* Izquierda: Canción actual */}
        <div className="playlist-admin__now-playing">
          {currentTrack ? (
            <>
              <span className="playlist-admin__now-playing-title">{currentTrack.name}</span>
              {currentSource && (
                <span className="playlist-admin__now-playing-source">{currentSource.name}</span>
              )}
              <span className="playlist-admin__now-playing-pitch-row">
                <span className="playlist-admin__now-playing-pitch">Pitch: {playbackPitch.toFixed(2)}x</span>
                <button
                  className="playlist-admin__pitch-reset"
                  onClick={() => handlePitchChange(1)}
                  title="Restaurar pitch a 1x"
                >
                  <RotateCcwIcon size={11} />
                </button>
              </span>
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
            <button className="playlist-admin__control-btn" onClick={playPrev} title="Anterior"><SkipBackIcon size={16} /></button>
            <button className="playlist-admin__control-btn playlist-admin__control-btn--play" onClick={togglePlayPause} title={isPlaying ? 'Pausar' : 'Reproducir'}>
              {isPlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
            </button>
            <button className="playlist-admin__control-btn" onClick={playNext} title="Siguiente"><SkipForwardIcon size={16} /></button>
            <button
              className={`playlist-admin__control-btn playlist-admin__control-btn--lyrics ${lyricsEnabled ? 'playlist-admin__control-btn--active' : ''}`}
              onClick={() => setLyricsEnabled(v => !v)}
              title={lyricsEnabled ? 'Lyrics activadas' : 'Lyrics desactivadas'}
            >
              <Mic2Icon size={16} />
            </button>
          </div>

          {/* Barra de progreso */}
          <div className="playlist-admin__progress">
            <span className="playlist-admin__progress-time">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step="any"
              value={visualCurrentTime}
              onChange={(e) => handleSeek(Number(e.target.value))}
              className="playlist-admin__progress-bar"
              style={{ background: `linear-gradient(to right, #fff 0%, #fff ${progressFill}, #535353 ${progressFill}, #535353 100%)` }}
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
