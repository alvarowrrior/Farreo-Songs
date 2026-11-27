"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CloudDownloadIcon,
  DicesIcon,
  DownloadIcon,
  HardDriveIcon,
  ListMusicIcon,
  LoaderCircleIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  Trash2Icon,
  Volume2Icon,
  VolumeXIcon,
  WifiIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import { MUSIC_API_URL, type ApiPlaylistInfo, type ApiSong } from "@/lib/radioApi";
import {
  canDownloadSong,
  deleteOfflinePlaylist,
  deleteOfflineSong,
  downloadSong,
  formatBytes,
  getOfflineSong,
  getStorageEstimate,
  listOfflinePlaylists,
  listOfflineSongs,
  requestPersistentStorage,
  saveOfflinePlaylist,
  setNativeOfflineBackend,
  type OfflinePlaylist,
  type OfflineSongMeta,
} from "@/lib/offlineStore";
import { cacheLoadedResources } from "@/components/OfflineServiceWorker";
import { getNativeOfflineAudio, type FarreoNativeState } from "@/lib/nativeAudio";

type NativePlugin = NonNullable<Awaited<ReturnType<typeof getNativeOfflineAudio>>>;
const OFFLINE_SOURCE = { id: "offline", name: "Farreo sin conexion", type: "global" as const };
import styles from "./Offline.module.scss";

type View = "library" | "download";
const ALL = "__all__";
const PREFS_KEY = "farreo-offline-prefs";

interface Prefs {
  volume: number;
  shuffle: boolean;
  autoPitch: boolean;
}

interface DownloadJob {
  label: string;
  done: number;
  total: number;
  failed: number;
}

const matches = (song: { name: string; variantes?: string[] }, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return song.name.toLowerCase().includes(q) || (song.variantes || []).some((v) => v.toLowerCase().includes(q));
};

const formatTime = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? "0" : ""}${sec}`;
};

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

function SongIcon({ id, hasIcon }: { id: string; hasIcon: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!hasIcon) return;
    let url: string | null = null;
    let cancelled = false;
    void getOfflineSong(id).then((song) => {
      if (cancelled || !song?.icon) return;
      url = URL.createObjectURL(song.icon);
      setSrc(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, hasIcon]);

  return (
    <span className={styles.artwork}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt="" /> : <MusicIcon size={18} />}
    </span>
  );
}

function OfflineContent() {
  const searchParams = useSearchParams();
  const online = useOnline();
  // navigator.onLine miente con poca cobertura: si el service worker nos trajo
  // aqui por falta de red, se muestra como sin conexion hasta que vuelva la red.
  const [cameOffline, setCameOffline] = useState(searchParams.get("sinconexion") === "1");
  useEffect(() => {
    const clear = () => setCameOffline(false);
    window.addEventListener("online", clear);
    return () => window.removeEventListener("online", clear);
  }, []);
  const offlineMode = !online || cameOffline;

  const [view, setView] = useState<View>("library");
  const [songs, setSongs] = useState<OfflineSongMeta[]>([]);
  const [playlists, setPlaylists] = useState<OfflinePlaylist[]>([]);
  const [activePlaylist, setActivePlaylist] = useState<string>(ALL);
  const [query, setQuery] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [storage, setStorage] = useState({ usage: 0, quota: 0 });
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  // Descargas
  const [remotePlaylists, setRemotePlaylists] = useState<ApiPlaylistInfo[] | null>(null);
  const [remoteSongs, setRemoteSongs] = useState<ApiSong[] | null>(null);
  const [remoteQuery, setRemoteQuery] = useState("");
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [job, setJob] = useState<DownloadJob | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reproductor
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [current, setCurrent] = useState<OfflineSongMeta | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [pitch, setPitch] = useState(1);
  const [prefs, setPrefs] = useState<Prefs>({ volume: 0.8, shuffle: true, autoPitch: true });
  const historyRef = useRef<string[]>([]);

  // En la APK (build >= 23) las canciones guardadas como archivo se reproducen
  // con el reproductor nativo: sigue sonando con la pantalla bloqueada.
  const nativeRef = useRef<NativePlugin | null>(null);
  const nativeActiveRef = useRef(false);
  const [hasNative, setHasNative] = useState(false);
  const songsRef = useRef<OfflineSongMeta[]>([]);

  // ---------- Carga de la biblioteca local ----------
  const refreshLibrary = useCallback(async () => {
    try {
      const [s, p, est] = await Promise.all([listOfflineSongs(), listOfflinePlaylists(), getStorageEstimate()]);
      setSongs(s);
      setPlaylists(p);
      setStorage(est);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo leer la musica guardada." });
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshLibrary();
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "null") as Partial<Prefs> | null;
      if (saved) setPrefs((prev) => ({ ...prev, ...saved }));
    } catch {
      /* preferencias corruptas: se usan las de por defecto */
    }
    // Guarda esta pagina y su codigo para poder abrirla sin red.
    cacheLoadedResources(["/offline"]);
  }, [refreshLibrary]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* almacenamiento lleno o bloqueado */
    }
    if (audioRef.current) audioRef.current.volume = prefs.volume;
    const plugin = nativeRef.current;
    if (plugin && nativeActiveRef.current) {
      void plugin.setVolume({ volume: prefs.volume }).catch(() => undefined);
      void plugin.setShuffle({ shuffle: prefs.shuffle }).catch(() => undefined);
      void plugin.setAutoRandomPitch?.({ enabled: prefs.autoPitch }).catch(() => undefined);
    }
  }, [prefs]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const playlistSongIds = useMemo(() => {
    if (activePlaylist === ALL) return null;
    return playlists.find((p) => p.id === activePlaylist)?.songIds ?? [];
  }, [activePlaylist, playlists]);

  // Cola = lo que se ve (playlist activa + busqueda)
  const queue = useMemo(() => {
    const byId = new Map(songs.map((s) => [s.id, s]));
    const base = playlistSongIds
      ? playlistSongIds.map((id) => byId.get(id)).filter((s): s is OfflineSongMeta => Boolean(s))
      : songs;
    return base.filter((s) => matches(s, query));
  }, [songs, playlistSongIds, query]);

  useEffect(() => {
    songsRef.current = songs;
  }, [songs]);

  const applyNative = (state: FarreoNativeState | null | undefined) => {
    if (!state) return;
    const url = state.currentTrack?.url || "";
    if (!url.startsWith("file://")) {
      if (state.currentTrack) nativeActiveRef.current = false;
      return;
    }
    nativeActiveRef.current = true;
    setIsPlaying(Boolean(state.isPlaying));
    setCurrentTime(state.position || 0);
    setDuration(state.duration || 0);
    if (state.pitch) setPitch(state.pitch);
    const song = songsRef.current.find((s) => s.id === state.currentTrack?.id);
    if (song) setCurrent(song);
  };
  const applyNativeRef = useRef(applyNative);
  useEffect(() => {
    applyNativeRef.current = applyNative;
  });

  useEffect(() => {
    let cancelled = false;
    const handles: Array<{ remove: () => unknown }> = [];
    void (async () => {
      const plugin = await getNativeOfflineAudio();
      if (cancelled || !plugin) return;
      nativeRef.current = plugin;
      setNativeOfflineBackend(plugin);
      setHasNative(true);
      const onState = (payload: unknown) => applyNativeRef.current(payload as FarreoNativeState);
      handles.push(await plugin.addListener("state", onState));
      handles.push(await plugin.addListener("trackChanged", onState));
      handles.push(await plugin.addListener("progress", (payload) => {
        if (!nativeActiveRef.current) return;
        const { position, duration: total } = payload as { position?: number; duration?: number };
        setCurrentTime((prev) => (Math.floor(prev) === Math.floor(position || 0) ? prev : position || 0));
        if (total) setDuration(total);
      }));
      // Si ya estaba sonando musica descargada (p. ej. al volver a la app), se muestra.
      applyNativeRef.current(await plugin.getState().catch(() => null));
    })();
    return () => {
      cancelled = true;
      handles.forEach((handle) => void handle.remove());
      setNativeOfflineBackend(null);
    };
  }, []);

  const runNative = async (action: (plugin: NativePlugin) => Promise<FarreoNativeState>) => {
    const plugin = nativeRef.current;
    if (!plugin) return;
    try {
      applyNative(await action(plugin));
    } catch {
      setNotice({ type: "error", text: "El reproductor del movil no respondio." });
    }
  };

  const startNative = async (plugin: NativePlugin, song: OfflineSongMeta) => {
    audioRef.current?.pause();
    const nativeQueue = queue.filter((s) => s.nativeUri);
    const list = nativeQueue.some((s) => s.id === song.id) ? nativeQueue : [song];
    const tracks = list.map((s) => ({ id: s.id, name: s.name, url: s.nativeUri || "", variantes: s.variantes }));
    try {
      nativeActiveRef.current = true;
      applyNative(await plugin.loadQueue({
        tracks,
        startIndex: Math.max(0, list.findIndex((s) => s.id === song.id)),
        source: OFFLINE_SOURCE,
        shuffle: prefs.shuffle,
        autoRandomPitch: prefs.autoPitch,
        pitch,
        volume: prefs.volume,
      }));
      applyNative(await plugin.play());
      setCurrent(song);
    } catch {
      nativeActiveRef.current = false;
      setNotice({ type: "error", text: `No se pudo reproducir "${song.name}".` });
    }
  };

  const totalSize = useMemo(() => songs.reduce((acc, s) => acc + s.size, 0), [songs]);
  const savedIds = useMemo(() => new Set(songs.map((s) => s.id)), [songs]);

  // ---------- Reproductor ----------
  const updateMediaSession = (song: OfflineSongMeta) => {
    if (!("mediaSession" in navigator)) return;
    const album = playlists.find((p) => p.id === activePlaylist)?.nombre || "Farreo sin conexion";
    navigator.mediaSession.metadata = new MediaMetadata({ title: song.name, artist: "Farreo", album });
  };

  const startSong = async (song: OfflineSongMeta) => {
    const plugin = nativeRef.current;
    if (plugin && song.nativeUri) {
      await startNative(plugin, song);
      return;
    }
    if (nativeActiveRef.current) {
      nativeActiveRef.current = false;
      void plugin?.pause().catch(() => undefined);
    }
    const audio = audioRef.current;
    if (!audio) return;
    const record = await getOfflineSong(song.id);
    if (!record) {
      setNotice({ type: "error", text: `"${song.name}" ya no esta guardada.` });
      void refreshLibrary();
      return;
    }

    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(record.audio);
    objectUrlRef.current = url;

    let nextPitch = pitch;
    if (prefs.autoPitch) {
      nextPitch = Math.random() * (1.2 - 0.8) + 0.8;
      setPitch(nextPitch);
    }

    audio.src = url;
    audio.preservesPitch = false;
    audio.defaultPlaybackRate = nextPitch;
    audio.playbackRate = nextPitch;
    audio.volume = prefs.volume;
    audio.play().catch(() => setIsPlaying(false));

    if (current && current.id !== song.id) historyRef.current = [...historyRef.current.slice(-50), current.id];
    setCurrent(song);
    setCurrentTime(0);
    setIsPlaying(true);
    updateMediaSession(song);
  };

  const playSong = (song: OfflineSongMeta) => {
    if (nativeActiveRef.current && current?.id === song.id) {
      togglePlay();
      return;
    }
    const audio = audioRef.current;
    if (current?.id === song.id && audio?.src) {
      if (audio.paused) void audio.play();
      else audio.pause();
      return;
    }
    void startSong(song);
  };

  const playNext = () => {
    if (nativeActiveRef.current) {
      void runNative((plugin) => plugin.next());
      return;
    }
    if (queue.length === 0) return;
    if (prefs.shuffle) {
      const pool = queue.length > 1 && current ? queue.filter((s) => s.id !== current.id) : queue;
      void startSong(pool[Math.floor(Math.random() * pool.length)]);
      return;
    }
    const idx = current ? queue.findIndex((s) => s.id === current.id) : -1;
    void startSong(queue[(idx + 1) % queue.length]);
  };

  const playPrev = () => {
    if (nativeActiveRef.current) {
      void runNative((plugin) => plugin.previous());
      return;
    }
    const audio = audioRef.current;
    if (audio && audio.currentTime > 4) {
      audio.currentTime = 0;
      return;
    }
    if (prefs.shuffle) {
      const prevId = historyRef.current.pop();
      const prev = songs.find((s) => s.id === prevId);
      if (prev) {
        void startSong(prev).then(() => { historyRef.current.pop(); });
        return;
      }
      playNext();
      return;
    }
    if (queue.length === 0) return;
    const idx = current ? queue.findIndex((s) => s.id === current.id) : 0;
    void startSong(queue[(idx - 1 + queue.length) % queue.length]);
  };

  const togglePlay = () => {
    if (nativeActiveRef.current) {
      void runNative((plugin) => (isPlaying ? plugin.pause() : plugin.play()));
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.src) {
      if (current) void startSong(current);
      else playNext();
      return;
    }
    if (audio.paused) void audio.play();
    else audio.pause();
  };

  const nextRef = useRef(playNext);
  const prevRef = useRef(playPrev);
  useEffect(() => {
    nextRef.current = playNext;
    prevRef.current = playPrev;
  });

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => { void audioRef.current?.play(); });
    ms.setActionHandler("pause", () => { audioRef.current?.pause(); });
    ms.setActionHandler("nexttrack", () => nextRef.current());
    ms.setActionHandler("previoustrack", () => prevRef.current());
    return () => {
      ms.setActionHandler("play", null);
      ms.setActionHandler("pause", null);
      ms.setActionHandler("nexttrack", null);
      ms.setActionHandler("previoustrack", null);
    };
  }, []);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const changePitch = (value: number) => {
    setPitch(value);
    if (nativeActiveRef.current) void nativeRef.current?.setPitch({ pitch: value }).catch(() => undefined);
    if (audioRef.current) {
      audioRef.current.preservesPitch = false;
      audioRef.current.playbackRate = value;
    }
  };

  // ---------- Borrar ----------
  const removeSong = async (song: OfflineSongMeta) => {
    if (!window.confirm(`¿Quitar "${song.name}" del movil? Podras volver a descargarla con conexion.`)) return;
    if (current?.id === song.id) {
      if (nativeActiveRef.current) {
        nativeActiveRef.current = false;
        await nativeRef.current?.pause().catch(() => undefined);
        setIsPlaying(false);
      }
      audioRef.current?.pause();
      audioRef.current?.removeAttribute("src");
      setCurrent(null);
    }
    await deleteOfflineSong(song.id);
    await refreshLibrary();
  };

  const removePlaylist = async (pl: OfflinePlaylist) => {
    if (!window.confirm(`¿Quitar la playlist "${pl.nombre}" del movil? Se borran las canciones que no esten en otra playlist descargada.`)) return;
    await deleteOfflinePlaylist(pl.id);
    if (activePlaylist === pl.id) setActivePlaylist(ALL);
    await refreshLibrary();
  };

  // ---------- Descargas ----------
  const loadRemote = useCallback(async () => {
    setRemoteError(null);
    try {
      const res = await fetch(`${MUSIC_API_URL}/playlists`);
      if (!res.ok) throw new Error();
      setRemotePlaylists(await res.json());
    } catch {
      setRemoteError("No se pudo conectar con el servidor de musica.");
    }
  }, []);

  const loadRemoteSongs = async () => {
    try {
      const res = await fetch(`${MUSIC_API_URL}/canciones`);
      if (!res.ok) throw new Error();
      const list = (await res.json()) as ApiSong[];
      setRemoteSongs(list.filter(canDownloadSong));
    } catch {
      setRemoteError("No se pudo cargar la lista de canciones.");
    }
  };

  useEffect(() => {
    if (view === "download" && online && !remotePlaylists) void loadRemote();
  }, [view, online, remotePlaylists, loadRemote]);

  const runDownloads = async (label: string, list: ApiSong[], after?: (okIds: string[]) => Promise<void>) => {
    if (job) return;
    void requestPersistentStorage();
    const controller = new AbortController();
    abortRef.current = controller;
    const downloadable = list.filter(canDownloadSong);
    const okIds: string[] = [];
    let failed = 0;
    setJob({ label, done: 0, total: downloadable.length, failed: 0 });

    for (const song of downloadable) {
      if (controller.signal.aborted) break;
      try {
        await downloadSong(song, controller.signal);
        okIds.push(song.id);
      } catch (error) {
        if (controller.signal.aborted) break;
        failed += 1;
        console.warn("Fallo descargando", song.name, error);
        if (error instanceof DOMException && error.name === "QuotaExceededError") {
          setNotice({ type: "error", text: "El movil se ha quedado sin espacio para mas canciones." });
          break;
        }
      }
      setJob({ label, done: okIds.length + failed, total: downloadable.length, failed });
    }

    if (after && okIds.length > 0) await after(okIds);
    abortRef.current = null;
    setJob(null);
    await refreshLibrary();
    const skipped = list.length - downloadable.length;
    if (controller.signal.aborted) setNotice({ type: "error", text: `Descarga cancelada (${okIds.length} guardadas).` });
    else setNotice({
      type: failed ? "error" : "ok",
      text: `${okIds.length} canciones listas sin conexion${failed ? `, ${failed} fallaron` : ""}${skipped ? `, ${skipped} de YouTube no se pueden guardar` : ""}.`,
    });
  };

  const downloadPlaylist = async (info: ApiPlaylistInfo) => {
    try {
      const res = await fetch(`${MUSIC_API_URL}/playlist/${encodeURIComponent(info.id)}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { id: string; nombre: string; canciones: ApiSong[] };
      await runDownloads(data.nombre, data.canciones, async (okIds) => {
        const existing = playlists.find((p) => p.id === data.id);
        const order = data.canciones.map((c) => c.id);
        const ids = new Set([...(existing?.songIds || []), ...okIds]);
        await saveOfflinePlaylist({
          id: data.id,
          nombre: data.nombre,
          songIds: order.filter((id) => ids.has(id)),
          savedAt: Date.now(),
        });
      });
    } catch {
      setNotice({ type: "error", text: `No se pudo abrir la playlist "${info.nombre}".` });
    }
  };

  const filteredRemoteSongs = useMemo(
    () => (remoteSongs || []).filter((s) => matches(s, remoteQuery)).slice(0, 80),
    [remoteSongs, remoteQuery],
  );

  const quotaText = storage.quota ? ` de ${formatBytes(storage.quota)} disponibles` : "";

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          {online ? (
            // Recarga completa a proposito: la app normal necesita red.
            // eslint-disable-next-line @next/next/no-html-link-for-pages
            <a href="/" className={styles.back}>
              <ArrowLeftIcon size={16} /> Farreo
            </a>
          ) : <span />}
          <span className={offlineMode ? styles.statusOffline : styles.statusOnline}>
            {offlineMode ? <WifiOffIcon size={14} /> : <WifiIcon size={14} />}
            {offlineMode ? "Sin conexion" : "Con conexion"}
          </span>
        </div>
        <h1 className={styles.title}>Farreo sin conexion</h1>
        <p className={styles.subtitle}>
          {songs.length} canciones guardadas en este dispositivo · {formatBytes(totalSize)}
        </p>
        {offlineMode && songs.length > 0 && (
          <p className={styles.banner}>No hay datos ni wifi: aqui tienes la musica que descargaste.</p>
        )}
      </header>

      <nav className={styles.tabs}>
        <button type="button" className={view === "library" ? styles.tabActive : styles.tab} onClick={() => setView("library")}>
          <HardDriveIcon size={16} /> Mi musica
        </button>
        <button type="button" className={view === "download" ? styles.tabActive : styles.tab} onClick={() => setView("download")}>
          <CloudDownloadIcon size={16} /> Descargar
        </button>
      </nav>

      {notice && <div className={notice.type === "ok" ? styles.noticeOk : styles.noticeError}>{notice.text}</div>}

      {job && (
        <div className={styles.job}>
          <div className={styles.jobText}>
            <LoaderCircleIcon size={16} className={styles.spin} />
            <span>Descargando {job.label}: {job.done}/{job.total}{job.failed ? ` (${job.failed} fallos)` : ""}</span>
            <button type="button" onClick={() => abortRef.current?.abort()} className={styles.jobCancel}>Cancelar</button>
          </div>
          <div className={styles.jobBar}><span style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%` }} /></div>
        </div>
      )}

      {view === "library" ? (
        <section className={styles.section}>
          {playlists.length > 0 && (
            <div className={styles.chips}>
              <button type="button" className={activePlaylist === ALL ? styles.chipActive : styles.chip} onClick={() => setActivePlaylist(ALL)}>
                Todas
              </button>
              {playlists.map((pl) => (
                <span key={pl.id} className={activePlaylist === pl.id ? styles.chipActive : styles.chip}>
                  <button type="button" onClick={() => setActivePlaylist(pl.id)}>
                    <ListMusicIcon size={14} /> {pl.nombre} <small>{pl.songIds.length}</small>
                  </button>
                  {activePlaylist === pl.id && (
                    <button type="button" onClick={() => void removePlaylist(pl)} title="Quitar playlist del movil" className={styles.chipRemove}>
                      <XIcon size={14} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

          <label className={styles.search}>
            <SearchIcon size={16} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar en tu musica guardada..." />
            {query && <button type="button" onClick={() => setQuery("")}><XIcon size={14} /></button>}
          </label>

          {libraryLoading ? (
            <p className={styles.empty}>Cargando...</p>
          ) : songs.length === 0 ? (
            <div className={styles.emptyCard}>
              <WifiOffIcon size={28} />
              <h2>Aun no tienes musica sin conexion</h2>
              <p>Con wifi o datos, entra en <strong>Descargar</strong> y guarda tus playlists. Despues podras escucharlas aqui sin internet.</p>
              {online && (
                <button type="button" className={styles.primary} onClick={() => setView("download")}>
                  <DownloadIcon size={16} /> Descargar musica
                </button>
              )}
            </div>
          ) : queue.length === 0 ? (
            <p className={styles.empty}>Sin resultados.</p>
          ) : (
            <ol className={styles.list}>
              {queue.map((song, i) => (
                <li key={song.id} className={current?.id === song.id ? styles.rowActive : styles.row}>
                  <button type="button" className={styles.rowMain} onClick={() => playSong(song)}>
                    <span className={styles.index}>
                      {current?.id === song.id && isPlaying ? <PauseIcon size={14} /> : <span>{i + 1}</span>}
                    </span>
                    <SongIcon id={song.id} hasIcon={song.hasIcon} />
                    <span className={styles.rowInfo}>
                      <strong>{song.name}</strong>
                      {song.variantes.length > 0 && <small>{song.variantes.join(", ")}</small>}
                    </span>
                  </button>
                  <button type="button" className={styles.iconBtn} onClick={() => void removeSong(song)} title="Quitar del movil">
                    <Trash2Icon size={16} />
                  </button>
                </li>
              ))}
            </ol>
          )}

          <p className={styles.storage}>
            <HardDriveIcon size={14} />
            {hasNative
              ? "Las canciones nuevas se guardan en la app y suenan tambien con la pantalla bloqueada."
              : `Farreo usa ${formatBytes(storage.usage)}${quotaText} en este dispositivo.`}
          </p>
        </section>
      ) : (
        <section className={styles.section}>
          {!online ? (
            <div className={styles.emptyCard}>
              <WifiOffIcon size={28} />
              <h2>Necesitas conexion para descargar</h2>
              <p>Conectate a wifi o datos para guardar nuevas canciones. Mientras tanto, escucha lo que ya tienes en <strong>Mi musica</strong>.</p>
            </div>
          ) : (
            <>
              <p className={styles.hint}>Consejo: descarga con wifi. Cada cancion ocupa unos 3-8 MB.</p>
              {remoteError && (
                <div className={styles.noticeError}>
                  {remoteError} <button type="button" className={styles.linkBtn} onClick={() => void loadRemote()}>Reintentar</button>
                </div>
              )}

              <h2 className={styles.sectionTitle}><ListMusicIcon size={18} /> Playlists</h2>
              {!remotePlaylists && !remoteError ? (
                <p className={styles.empty}>Cargando playlists...</p>
              ) : (
                <ul className={styles.list}>
                  {(remotePlaylists || []).map((pl) => {
                    const local = playlists.find((p) => p.id === pl.id);
                    return (
                      <li key={pl.id} className={styles.row}>
                        <span className={styles.rowMain}>
                          <span className={styles.artwork}><ListMusicIcon size={18} /></span>
                          <span className={styles.rowInfo}>
                            <strong>{pl.nombre}</strong>
                            <small>
                              {pl.numCanciones} canciones
                              {local ? ` · ${local.songIds.length} guardadas` : ""}
                            </small>
                          </span>
                        </span>
                        <button
                          type="button"
                          className={local ? styles.secondary : styles.primary}
                          disabled={Boolean(job)}
                          onClick={() => void downloadPlaylist(pl)}
                        >
                          {local ? <><CheckIcon size={14} /> Actualizar</> : <><DownloadIcon size={14} /> Descargar</>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              <h2 className={styles.sectionTitle}><MusicIcon size={18} /> Canciones sueltas</h2>
              {!remoteSongs ? (
                <button type="button" className={styles.secondary} onClick={() => void loadRemoteSongs()}>
                  <SearchIcon size={14} /> Buscar canciones para descargar
                </button>
              ) : (
                <>
                  <label className={styles.search}>
                    <SearchIcon size={16} />
                    <input value={remoteQuery} onChange={(e) => setRemoteQuery(e.target.value)} placeholder="Buscar cancion..." autoFocus />
                    {remoteQuery && <button type="button" onClick={() => setRemoteQuery("")}><XIcon size={14} /></button>}
                  </label>
                  <ul className={styles.list}>
                    {filteredRemoteSongs.map((song) => {
                      const saved = savedIds.has(song.id);
                      return (
                        <li key={song.id} className={styles.row}>
                          <span className={styles.rowMain}>
                            <span className={styles.rowInfo}>
                              <strong>{song.name}</strong>
                              {song.variantes && song.variantes.length > 0 && <small>{song.variantes.join(", ")}</small>}
                            </span>
                          </span>
                          {saved ? (
                            <span className={styles.saved}><CheckIcon size={14} /> Guardada</span>
                          ) : (
                            <button
                              type="button"
                              className={styles.iconBtn}
                              disabled={Boolean(job)}
                              onClick={() => void runDownloads(song.name, [song])}
                              title="Descargar"
                            >
                              <DownloadIcon size={16} />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {filteredRemoteSongs.length === 80 && <p className={styles.empty}>Mostrando 80 resultados. Afina la busqueda.</p>}
                </>
              )}
            </>
          )}
        </section>
      )}

      <div className={styles.player}>
        <div className={styles.nowPlaying}>
          {current ? (
            <>
              <strong>{current.name}</strong>
              <small>Pitch {pitch.toFixed(2)}x</small>
            </>
          ) : (
            <small>Elige una cancion</small>
          )}
        </div>

        <div className={styles.controls}>
          <button
            type="button"
            className={prefs.shuffle ? styles.ctrlActive : styles.ctrl}
            onClick={() => setPrefs((p) => ({ ...p, shuffle: !p.shuffle }))}
            title={prefs.shuffle ? "Aleatorio" : "En orden"}
          >
            {prefs.shuffle ? <ShuffleIcon size={18} /> : <ArrowRightIcon size={18} />}
          </button>
          <button type="button" className={styles.ctrl} onClick={playPrev} title="Anterior"><SkipBackIcon size={20} /></button>
          <button type="button" className={styles.playBtn} onClick={togglePlay} title={isPlaying ? "Pausa" : "Reproducir"}>
            {isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
          </button>
          <button type="button" className={styles.ctrl} onClick={playNext} title="Siguiente"><SkipForwardIcon size={20} /></button>
          <button
            type="button"
            className={prefs.autoPitch ? styles.ctrlActive : styles.ctrl}
            onClick={() => setPrefs((p) => ({ ...p, autoPitch: !p.autoPitch }))}
            title={prefs.autoPitch ? "Pitch aleatorio" : "Pitch fijo"}
          >
            <DicesIcon size={18} />
          </button>
        </div>

        <div className={styles.progress}>
          <span>{formatTime(currentTime)}</span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.5}
            value={Math.min(currentTime, duration || 0)}
            onChange={(e) => {
              const t = Number(e.target.value);
              if (nativeActiveRef.current) void nativeRef.current?.seek({ position: t }).catch(() => undefined);
              else if (audioRef.current) audioRef.current.currentTime = t;
              setCurrentTime(t);
            }}
          />
          <span>{formatTime(duration)}</span>
        </div>

        <div className={styles.sliders}>
          <label title={`Pitch ${pitch.toFixed(2)}x`}>
            <span>Pitch</span>
            <input type="range" min={0.5} max={1.5} step={0.01} value={pitch} onChange={(e) => changePitch(Number(e.target.value))} />
          </label>
          <label title={`Volumen ${Math.round(prefs.volume * 100)}%`}>
            <button type="button" onClick={() => setPrefs((p) => ({ ...p, volume: p.volume > 0 ? 0 : 0.8 }))}>
              {prefs.volume > 0 ? <Volume2Icon size={16} /> : <VolumeXIcon size={16} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={prefs.volume}
              onChange={(e) => setPrefs((p) => ({ ...p, volume: Number(e.target.value) }))}
            />
          </label>
        </div>

        <audio
          ref={audioRef}
          onEnded={() => nextRef.current()}
          onPlay={() => {
            setIsPlaying(true);
            if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
          }}
          onPause={() => {
            setIsPlaying(false);
            if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
          }}
          onTimeUpdate={() => {
            const t = audioRef.current?.currentTime ?? 0;
            setCurrentTime((prev) => (Math.floor(prev) === Math.floor(t) ? prev : t));
          }}
          onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
          hidden
        />
      </div>
    </main>
  );
}

export default function OfflinePage() {
  return (
    <Suspense fallback={<main className={styles.page}><p className={styles.empty}>Cargando...</p></main>}>
      <OfflineContent />
    </Suspense>
  );
}
