"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { onAuthStateChanged } from "firebase/auth";
import { ListMusicIcon, Music2Icon, PlusIcon, RadioIcon, Share2Icon, XIcon } from "lucide-react";
import FarreoContextMenu, { type FarreoContextMenuItem } from "@/components/FarreoContextMenu";
import {
  useMusicPlayer,
  type MusicPlaylistSource,
  type MusicTrack,
  type PlaybackQueuePitch,
  type PlaybackQueuePosition,
} from "@/components/MusicPlayerProvider";
import { auth } from "@/lib/firebase";
import { getThemeDiscovery, getThemeDiscoverySong, type ThemeDiscoverySong } from "@/lib/themeDiscovery";
import { getMediaUrl } from "@/lib/radioApi";
import { lookupYoutubeTracks } from "@/lib/youtubeTracks";
import { addSongToPrivatePlaylist, listOwnPrivatePlaylists, type PrivatePlaylist } from "@/lib/privatePlaylists";
import { addSongToRadioQueue } from "@/lib/radioSongActions";
import styles from "./DesktopSongRadioContextEnhancer.module.scss";

const STRICT_HOSTS = [
  ".playlist-song-table__row",
  ".album-track",
  ".app-sidebar__song-result",
  ".song-discovery__row",
  ".playlist-admin__recommendation-card--daily",
  ".playlist-admin__now-playing-title",
].join(",");
const HOSTS = [STRICT_HOSTS,
  "[class*='songResult']", "[class*='songRow']", "[class*='songCard']",
  "[class*='SongResult']", "[class*='SongRow']", "[class*='SongCard']",
].join(",");
// PlaylistSongTable includes the queue action in its own React menu.
// The enhancer only augments other legacy menu implementations.
const MENU_SELECTOR = ".farreo-context-menu";
const OPEN_COMPOSER_EVENT = "farreo:open-song-queue-composer";

const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const clamp = (n: number) => Math.max(0.5, Math.min(1.5, Number.isFinite(n) ? n : 1));

type SelectedSong = MusicTrack & { url: string };
type MenuPoint = { x: number; y: number; song: SelectedSong; source: MusicPlaylistSource | null };
type PendingContext = {
  x: number;
  y: number;
  source: MusicPlaylistSource | null;
  host: HTMLElement;
  serial: number;
};

function getCandidateNames(host: HTMLElement) {
  const selectors = [".playlist-song-table__song-title", ".album-track__copy strong",
    ".app-sidebar__song-result-text > span", ".song-discovery__play-row strong",
    ".playlist-admin__recommendation-copy small", "strong"];
  const names = new Set<string>();
  if (host.matches(".playlist-admin__now-playing-title")) names.add(host.textContent?.trim() || "");
  host.querySelectorAll<HTMLImageElement>("img[alt]").forEach((img) => names.add(img.alt.trim()));
  selectors.forEach((selector) => host.querySelectorAll<HTMLElement>(selector)
    .forEach((el) => names.add(el.textContent?.trim() || "")));
  return [...names].filter((name) => name.length > 0 && name.length <= 180);
}
function getVisibleMenus() {
  return [...document.querySelectorAll<HTMLElement>(MENU_SELECTOR)].filter((menu) => {
    const style = window.getComputedStyle(menu);
    return style.visibility !== "hidden" && style.display !== "none";
  });
}
function sourceFromPage(path: string): MusicPlaylistSource | null {
  const match = path.match(/^\/(playlist|user-playlist|album|recommendation)\/([^/?#]+)/);
  if (!match) return null;
  const [, type, id] = match;
  const name = document.querySelector<HTMLElement>("h1")?.textContent?.trim();
  return { id: type === "recommendation" ? `recommendation:${decodeURIComponent(id)}` : decodeURIComponent(id),
    name: name || (type === "recommendation" ? "Recomendaciones" : "Playlist"),
    type: type === "playlist" ? "global" : type === "user-playlist" ? "private" : type === "album" ? "album" : "song" };
}

function QueueComposer({ target, radio, busy, defaultRandomPitch, defaultPitch, onClose, onSubmit }: {
  target: MenuPoint;
  radio: boolean;
  busy: boolean;
  defaultRandomPitch: boolean;
  defaultPitch: number;
  onClose: () => void;
  onSubmit: (position: PlaybackQueuePosition, pitch: PlaybackQueuePitch) => void;
}) {
  const [position, setPosition] = useState<PlaybackQueuePosition>("next");
  // Inherit the actual player's pitch preference, not a hard-coded random.
  const [pitchMode, setPitchMode] = useState<"random" | "normal" | "custom">(() =>
    defaultRandomPitch ? "random" : Math.abs(defaultPitch - 1) < 0.005 ? "normal" : "custom");
  const [pitch, setPitch] = useState(() => clamp(defaultPitch).toFixed(2));
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose]);
  const width = Math.min(334, window.innerWidth - 24);
  const style: CSSProperties = {
    left: Math.max(12, Math.min(target.x, window.innerWidth - width - 12)),
    top: Math.max(12, Math.min(target.y, window.innerHeight - 374)),
    width,
  };
  return createPortal(
    <div className={styles.composerBackdrop} onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className={styles.composer} style={style} role="dialog" aria-modal="true"
        aria-label={`Añadir ${radio ? "a la radio" : "a la cola"}`} onPointerDown={(event) => event.stopPropagation()}>
        <div className={styles.composerHeader}>
          <div className={styles.composerIcon}>{radio ? <RadioIcon size={17}/> : <ListMusicIcon size={17}/>}</div>
          <div className={styles.composerTitle}>
            <h3>{radio ? "Añadir a la radio" : "Añadir a la cola"}</h3>
            <p title={target.song.name}>{target.song.name}</p>
          </div>
          <button className={styles.close} type="button" onClick={onClose} aria-label="Cerrar"><XIcon size={17}/></button>
        </div>
        <div className={styles.composerSection}>
          <span className={styles.caption}>ORDEN DE REPRODUCCIÓN</span>
          <div className={styles.segmented}>
            {([
              ["next", "Siguiente"], ["last", "Al final"], ["now", "Ahora"],
            ] as const).map(([value,label]) => (
              <button type="button" key={value} onClick={() => setPosition(value)}
                className={position === value ? styles.selected : ""} aria-pressed={position === value}>{label}</button>
            ))}
          </div>
        </div>
        <div className={styles.composerSection}>
          <span className={styles.caption}>PITCH</span>
          <div className={styles.pitchChoices}>
            {([
              ["random", "🎲 Aleatorio"], ["normal", "1× Original"], ["custom", "Personalizado"],
            ] as const).map(([value,label]) => (
              <button type="button" key={value} onClick={() => setPitchMode(value)}
                className={pitchMode === value ? styles.selected : ""} aria-pressed={pitchMode === value}>{label}</button>
            ))}
          </div>
          {pitchMode === "custom" ? (
            <div className={styles.pitchCustom}>
              <input type="range" aria-label="Velocidad" min={0.5} max={1.5} step={0.01}
                value={clamp(Number(pitch))} onChange={(event) => setPitch(Number(event.target.value).toFixed(2))}/>
              <span>×</span>
              <input type="number" min={0.5} max={1.5} step={0.01} aria-label="Pitch personalizado"
                value={pitch} onChange={(event) => setPitch(event.target.value)}/>
            </div>
          ) : null}
        </div>
        <button type="button" className={styles.submit} disabled={busy} onClick={() => onSubmit(position,
          pitchMode === "random" ? { kind: "random" } : { kind: "fixed", pitch: pitchMode === "normal" ? 1 : clamp(Number(pitch)) },
        )}>
          <PlusIcon size={17}/>{busy ? "Añadiendo…" : radio ? "Añadir a la radio" : "Añadir a mi cola"}
        </button>
      </div>
    </div>, document.body,
  );
}

export default function DesktopSongRadioContextEnhancer() {
  const {
    currentTrack, currentSource, playbackUpcoming, playbackHistory,
    playerMode, playbackPitch, autoRandomPitch, addToPlaybackQueue,
  } = useMusicPlayer();
  const modeRef = useRef(playerMode);
  const playerTracksRef = useRef({currentTrack, currentSource, playbackUpcoming, playbackHistory});
  modeRef.current = playerMode;
  playerTracksRef.current = {currentTrack, currentSource, playbackUpcoming, playbackHistory};

  const songsRef = useRef<SelectedSong[] | null>(null);
  const fetchingRef = useRef<Promise<SelectedSong[]> | null>(null);
  const serialRef = useRef(0);
  const pendingContextRef = useRef<PendingContext | null>(null);
  const [fallback, setFallback] = useState<MenuPoint | null>(null);
  const [composer, setComposer] = useState<MenuPoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [playlists, setPlaylists] = useState<PrivatePlaylist[]>([]);
  const [notice, setNotice] = useState("");
  const notify = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((old) => old === message ? "" : old), 3200);
  };

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, (user) => {
      songsRef.current = null;
      fetchingRef.current = null;
      if (!user) { setPlaylists([]); return; }
      void listOwnPrivatePlaylists(user.uid).then(setPlaylists).catch(() => setPlaylists([]));
    });
  }, []);

  const loadSongs = () => {
    if (songsRef.current) return Promise.resolve(songsRef.current);
    if (fetchingRef.current) return fetchingRef.current;
    const request = getThemeDiscovery().then((payload) => {
      songsRef.current = payload.songs;
      return payload.songs;
    }).finally(() => { fetchingRef.current = null; });
    fetchingRef.current = request;
    return request;
  };

  const resolve = async (host: HTMLElement): Promise<SelectedSong | null> => {
    const names = getCandidateNames(host).map(normalize);
    const player = playerTracksRef.current;
    const local: MusicTrack[] = [player.currentTrack, ...player.playbackUpcoming.map((item) => item.track),
      ...player.playbackHistory.map((item) => item.track)].filter((song): song is MusicTrack => !!song);
    const directId = host.getAttribute("data-farreo-song-id") || host.getAttribute("data-song-id");
    const localById = directId ? local.find((song) => song.id === directId) : null;
    if (localById?.url) return localById as SelectedSong;
    if (directId?.startsWith("youtube:")) {
      const found = await lookupYoutubeTracks([directId]);
      if (found[0]?.url) return found[0];
    }
    const all = await loadSongs();
    if (directId) {
      const byId = all.find((song) => song.id === directId);
      if (byId) return byId;
    }
    const localByName = local.find((song) => names.includes(normalize(song.name)));
    if (localByName?.url) return localByName as SelectedSong;
    for (const name of names) {
      const matches = all.filter((song) => normalize(song.name) === name);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        const img = host.querySelector<HTMLImageElement>("img[alt]");
        const icon = img?.currentSrc || img?.src;
        const chosen = matches.find((song) => {
          try { return new URL(getMediaUrl(song.iconUrl || ""), window.location.href).pathname ===
            new URL(icon || "", window.location.href).pathname; } catch { return false; }
        });
        if (chosen) return chosen;
        return matches[0];
      }
    }
    return null;
  };

  // Context menus previously forwarded raw /youtube-tracks/... or /canciones/...
  // paths from discovery straight to <audio>. Those paths point at the Next.js
  // origin instead of the music API! Automatically queued songs already have
  // their URLs normalized, which is why only manual inserts were failing.
  const normalizeAudioTrack = (song: SelectedSong): MusicTrack => ({
    ...song,
    url: getMediaUrl(song.url),
  });

  const enrichSelectedSong = async (song: SelectedSong): Promise<SelectedSong> => {
    // Preserve full metadata when it is available. Discovery rows are only
    // summaries and omit optional advanced video cover fields.
    try {
      const full = song.id.startsWith("youtube:")
        ? (await lookupYoutubeTracks([song.id]))[0]
        : await getThemeDiscoverySong(song.id);
      if (full?.url) return { ...song, ...full, url: getMediaUrl(full.url) };
    } catch { /* The base track is still usable without optional metadata. */ }
    return { ...song, url: getMediaUrl(song.url) };
  };

  const submit = async (target: MenuPoint, position: PlaybackQueuePosition, pitch: PlaybackQueuePitch) => {
    if (busy) return;
    setBusy(true);
    try {
      if (modeRef.current === "radio") {
        await addSongToRadioQueue(target.song.id, { insertAt: position, pitch });
        notify(`“${target.song.name}” añadida a la radio.`);
      } else {
        addToPlaybackQueue(normalizeAudioTrack(target.song), position, pitch, target.source);
        notify(`“${target.song.name}” añadida a tu cola.`);
      }
      setComposer(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : "No se pudo añadir la canción.");
    } finally {
      setBusy(false);
    }
  };

  // Inject the entry immediately, with no song lookup on the contextmenu
  // path. Previously resolve() fetched the whole discovery catalogue BEFORE
  // appending a button, so a rapid right-click showed an incomplete menu.
  // Lookup now runs only after a user clicks the extra action.
  const inject = (menu: HTMLElement, request: PendingContext) => {
    const previous = menu.querySelector<HTMLElement>("[data-farreo-song-queue-entry]");
    if (previous?.dataset.farreoSongQueueEntry === String(request.serial)) return;
    previous?.remove();
    const parent = document.createElement("div");
    parent.dataset.farreoSongQueueEntry = String(request.serial);
    parent.className = styles.injectedEntry;
    const button = document.createElement("button");
    button.type = "button";
    button.className = styles.injectedButton;
    button.innerHTML = `<span aria-hidden="true">${modeRef.current === "radio" ? "◉" : "☷"}</span><span>${modeRef.current === "radio" ? "Añadir a la radio…" : "Añadir a la cola…"}</span><span aria-hidden="true">›</span>`;
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Clicking a menu option dismisses the original context menu. Resolve
      // from the DOM row captured on right-click, not from whatever row is
      // currently under the pointer.
      window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      setFallback(null);
      const selection = ++serialRef.current;
      void resolve(request.host).then(async (song) => {
        if (serialRef.current !== selection) return;
        if (!song?.url) {
          notify("No se pudo encontrar esta canción. Prueba a recargar la página.");
          return;
        }
        // The compositor can open immediately with the song, while optional
        // cover metadata is enhanced asynchronously before the user submits.
        const normalized = { ...song, url: getMediaUrl(song.url) };
        setComposer({ x: request.x, y: request.y, song: normalized, source: request.source });
        const rich = await enrichSelectedSong(normalized);
        if (serialRef.current === selection) {
          setComposer((current) => current?.song.id === rich.id
            ? { ...current, song: rich } : current);
        }
      }).catch(() => {
        if (serialRef.current === selection) notify("No se pudieron cargar los datos de la canción.");
      });
    });
    parent.appendChild(button);
    menu.appendChild(parent);
  };

  useEffect(() => {
    const openFromNativeMenu = (event: Event) => {
      const detail = (event as CustomEvent<MenuPoint>).detail;
      if (!detail?.song?.id || !detail.song.url) return;
      serialRef.current += 1;
      pendingContextRef.current = null;
      setFallback(null);
      // PlaylistSongTable already has the complete MusicTrack, including
      // video/cover metadata; do not degrade it to discovery catalogue data.
      setComposer({ ...detail, song: { ...detail.song, url: getMediaUrl(detail.song.url) } });
    };
    const context = (event: MouseEvent) => {
      setFallback(null);
      if (!(event.target instanceof Element) || event.target.closest(`${MENU_SELECTOR}, [role='dialog'], [aria-label='Cola de reproducción']`)) return;
      const host = event.target.closest<HTMLElement>(HOSTS);
      if (!host || host.closest(".playlist-admin__recommendation-card--concealed")) return;
      const strict = Boolean(event.target.closest(STRICT_HOSTS));
      if (strict) event.preventDefault();
      const serial = ++serialRef.current;
      const source = host.closest(".app-sidebar__song-result")
        ? { id: "search", name: "Resultados de búsqueda", type: "song" as const }
        : sourceFromPage(location.pathname);
      const request: PendingContext = {
        x: event.clientX, y: event.clientY, source, host, serial,
      };
      pendingContextRef.current = request;
      // The playlist table renders this entry natively in its own menu.
      if (host.matches(".playlist-song-table__row")) return;
      getVisibleMenus().forEach((menu) => menu.querySelectorAll("[data-farreo-song-queue-entry]")
        .forEach((entry) => entry.remove()));
      let found = false;
      const tryInject = () => {
        if (serial !== serialRef.current) return;
        const menu = getVisibleMenus().find((node) => {
          const rect = node.getBoundingClientRect();
          return Math.abs(rect.left - request.x) < 400
            && Math.abs(rect.top - request.y) < 400;
        });
        if (!menu) return;
        inject(menu, request);
        found = true;
      };
      // React typically commits the menu during this event. Observe its first
      // DOM insertion and inject the action before the browser's next paint.
      const observer = new MutationObserver(tryInject);
      observer.observe(document.body, { subtree: true, childList: true });
      queueMicrotask(tryInject);
      const frame = window.requestAnimationFrame(tryInject);
      window.setTimeout(() => {
        observer.disconnect();
        window.cancelAnimationFrame(frame);
        if (serial !== serialRef.current) return;
        tryInject();
        if (found || !strict) return;
        // Some third-party lists have no native context menu; for these only,
        // resolve lazily and display a complete Farreo fallback menu.
        void resolve(request.host).then((song) => {
          if (song?.url && serial === serialRef.current) {
            setFallback({ x: request.x, y: request.y, song, source });
          }
        }).catch(() => undefined);
      }, 160);
    };
    const dismissPending = (event: PointerEvent) => {
      if (event.button !== 2) serialRef.current += 1;
    };
    window.addEventListener(OPEN_COMPOSER_EVENT, openFromNativeMenu);
    window.addEventListener("contextmenu", context, true);
    window.addEventListener("pointerdown", dismissPending, true);
    return () => {
      window.removeEventListener(OPEN_COMPOSER_EVENT, openFromNativeMenu);
      window.removeEventListener("contextmenu", context, true);
      window.removeEventListener("pointerdown", dismissPending, true);
    };
    // The handler reads current player/radio state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fallbackItems: FarreoContextMenuItem[] = fallback ? [
    { label: "Compartir canción", icon: <Share2Icon size={15}/>, onSelect: () => {
      void navigator.clipboard.writeText(`${location.origin}/play?song=${encodeURIComponent(fallback.song.id)}`)
        .then(() => notify("Enlace de la canción copiado."))
        .catch(() => notify("No se pudo copiar el enlace."));
    }},
    { label: "Añadir a playlist", icon: <Music2Icon size={15}/>, disabled: !playlists.length,
      onSelect: () => undefined,
      children: playlists.map((playlist) => ({ label: playlist.nombre,
        onSelect: () => void addSongToPrivatePlaylist(playlist.id, fallback.song.id)
          .then(() => notify(`Añadida a ${playlist.nombre}.`))
          .catch(() => notify("No se pudo añadir a la playlist.")),
      })),
    },
    { label: playerMode === "radio" ? "Añadir a la radio…" : "Añadir a la cola…",
      icon: playerMode === "radio" ? <RadioIcon size={15}/> : <ListMusicIcon size={15}/> ,
      onSelect: () => setComposer(fallback),
    },
  ] : [];

  return <>
    {fallback ? <FarreoContextMenu x={fallback.x} y={fallback.y} items={fallbackItems} onClose={() => setFallback(null)} /> : null}
    {composer ? <QueueComposer key={`${composer.song.id}:${playerMode}:${autoRandomPitch}:${playbackPitch.toFixed(2)}`}
      target={composer} radio={playerMode === "radio"} defaultRandomPitch={autoRandomPitch}
      defaultPitch={playbackPitch} busy={busy} onClose={() => setComposer(null)}
      onSubmit={(position,pitch) => void submit(composer,position,pitch)}/> : null}
    {notice ? <div className={styles.notice} role="status" onClick={() => setNotice("")}>{notice}</div> : null}
  </>;
}
