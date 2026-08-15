"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDownIcon,
  EyeOffIcon,
  FilterIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { onAuthStateChanged } from "firebase/auth";
import SongArtwork from "@/components/SongArtwork";
import {
  useMusicPlayer,
  type MusicPlaylistSource,
  type MusicTrack,
} from "@/components/MusicPlayerProvider";
import { auth } from "@/lib/firebase";
import {
  addFarreoNativeListener,
  getFarreoNativeAudio,
  type FarreoNativeState,
} from "@/lib/nativeAudio";
import {
  getThemeDiscovery,
  getThemeDiscoverySong,
  songCreatedAtMs,
  themeColor,
  type ThemeDiscoveryPayload,
} from "@/lib/themeDiscovery";
import { getMediaUrl, type ApiSong } from "@/lib/radioApi";
import styles from "./MobileThemeSearchEnhancer.module.scss";

const PAGE_SIZE = 30;

const normalize = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim();

const matchesText = (
  song: { name: string; variantes?: string[] },
  query: string,
) => {
  const normalized = normalize(query);
  if (!normalized) return true;
  return [song.name, ...(song.variantes || [])]
    .map(normalize)
    .some((value) => value.includes(normalized));
};

const songToTrack = (song: ApiSong): MusicTrack => ({
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
  createdAt: song.createdAt,
  albumId: song.albumId,
  albumEntryId: song.albumEntryId,
  firstListenPending: song.firstListenPending,
});

export default function MobileThemeSearchEnhancer() {
  const {
    currentTrack,
    isPlaying,
    toggleTrack,
  } = useMusicPlayer();

  const [buttonHost, setButtonHost] = useState<HTMLElement | null>(null);
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [data, setData] = useState<ThemeDiscoveryPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [themeQuery, setThemeQuery] = useState("");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [nativeState, setNativeState] = useState<FarreoNativeState | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const labelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const handleInput = (event: Event) => {
      setQuery((event.target as HTMLInputElement | null)?.value || "");
    };

    const detachInput = () => {
      if (inputRef.current) {
        inputRef.current.removeEventListener("input", handleInput);
      }
      inputRef.current = null;
    };

    const resolve = () => {
      const label = document.querySelector<HTMLElement>("label.mobile-farreo__search");
      const section = label?.closest<HTMLElement>(".mobile-farreo__section") || null;
      const input = label?.querySelector<HTMLInputElement>("input") || null;

      if (!label || !section || !input) {
        detachInput();
        labelRef.current?.classList.remove(styles.searchWithFilter);
        sectionRef.current?.classList.remove(styles.filteredMode);
        labelRef.current = null;
        sectionRef.current = null;
        setButtonHost(null);
        setPanelHost(null);
        return;
      }

      if (inputRef.current !== input) {
        detachInput();
        inputRef.current = input;
        setQuery(input.value || "");
        input.addEventListener("input", handleInput);
      }

      if (labelRef.current !== label) {
        labelRef.current?.classList.remove(styles.searchWithFilter);
        labelRef.current = label;
        label.classList.add(styles.searchWithFilter);
      }

      sectionRef.current = section;

      let nextButtonHost = label.querySelector<HTMLElement>("[data-mobile-theme-filter-button]");
      if (!nextButtonHost) {
        nextButtonHost = document.createElement("span");
        nextButtonHost.dataset.mobileThemeFilterButton = "true";
        nextButtonHost.className = styles.filterButtonHost;
        label.appendChild(nextButtonHost);
      }

      let nextPanelHost = section.querySelector<HTMLElement>("[data-mobile-theme-filter-panel]");
      if (!nextPanelHost) {
        nextPanelHost = document.createElement("div");
        nextPanelHost.dataset.mobileThemeFilterPanel = "true";
        label.insertAdjacentElement("afterend", nextPanelHost);
      }

      setButtonHost(nextButtonHost);
      setPanelHost(nextPanelHost);
    };

    resolve();
    const observer = new MutationObserver(resolve);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      detachInput();
      labelRef.current?.classList.remove(styles.searchWithFilter);
      sectionRef.current?.classList.remove(styles.filteredMode);
    };
  }, []);

  useEffect(() => {
    sectionRef.current?.classList.toggle(styles.filteredMode, selectedIds.size > 0);
  }, [panelHost, selectedIds]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, selectedIds]);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, () => {
      setData(null);
      setSelectedIds(new Set());
      setVisibleCount(PAGE_SIZE);
    });
  }, []);

  useEffect(() => {
    if ((!filterOpen && selectedIds.size === 0) || data || loading) return;

    setLoading(true);
    void getThemeDiscovery()
      .then(setData)
      .catch(() => setData({
        generatedAt: "",
        isAdmin: false,
        themes: [],
        songs: [],
      }))
      .finally(() => setLoading(false));
  }, [data, filterOpen, loading, selectedIds.size]);

  useEffect(() => {
    const native = getFarreoNativeAudio();
    if (!native) return;

    let disposed = false;
    void native.getState()
      .then((state) => {
        if (!disposed) setNativeState(state);
      })
      .catch(() => undefined);

    const sync = (payload: unknown) => {
      if (disposed || !payload || typeof payload !== "object") return;
      setNativeState(payload as FarreoNativeState);
    };

    const handles = [
      addFarreoNativeListener("state", sync),
      addFarreoNativeListener("trackChanged", sync),
      addFarreoNativeListener("ended", sync),
    ];

    return () => {
      disposed = true;
      handles.forEach((promise) => {
        void promise.then((handle) => handle?.remove()).catch(() => undefined);
      });
    };
  }, []);

  const themesById = useMemo(
    () => new Map((data?.themes || []).map((theme) => [theme.id, theme])),
    [data?.themes],
  );

  const filteredThemes = useMemo(() => {
    const normalized = normalize(themeQuery);
    return [...(data?.themes || [])]
      .sort((left, right) => (
        right.count - left.count
        || left.name.localeCompare(right.name, "es", { sensitivity: "base" })
      ))
      .filter((theme) => (
        !normalized || normalize(theme.name).includes(normalized)
      ));
  }, [data?.themes, themeQuery]);

  const matchingSongs = useMemo(() => {
    if (selectedIds.size === 0) return [];

    const required = [...selectedIds];
    return [...(data?.songs || [])]
      .filter((song) => required.every((id) => song.themeIds.includes(id)))
      .filter((song) => matchesText(song, query))
      .sort((left, right) => songCreatedAtMs(right) - songCreatedAtMs(left));
  }, [data?.songs, query, selectedIds]);

  const toggleTheme = (themeId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(themeId)) next.delete(themeId);
      else next.add(themeId);
      return next;
    });
  };

  const activeTrackId = nativeState?.currentTrack?.id || currentTrack?.id || null;
  const activeIsPlaying = nativeState
    ? Boolean(nativeState.isPlaying)
    : isPlaying;

  const playSong = async (songId: string) => {
    if (playingId) return;
    setPlayingId(songId);

    try {
      const native = getFarreoNativeAudio();

      if (native) {
        let state = nativeState;
        if (!state) {
          state = await native.getState().catch(() => null);
        }

        if (state?.currentTrack?.id === songId) {
          const nextState = state.isPlaying
            ? await native.pause()
            : await native.play();
          setNativeState(nextState);
          return;
        }

        const song = await getThemeDiscoverySong(songId);
        const track = songToTrack(song);
        const source: MusicPlaylistSource = {
          id: song.id,
          name: "Canción suelta",
          type: "song",
        };

        const loaded = await native.loadQueue({
          tracks: [track],
          startIndex: 0,
          source,
          shuffle: false,
          autoRandomPitch: state?.autoRandomPitch ?? false,
          pitch: state?.pitch ?? 1,
          volume: state?.volume ?? 1,
        });
        setNativeState(loaded);
        setNativeState(await native.play());
        return;
      }

      const song = await getThemeDiscoverySong(songId);
      const track = songToTrack(song);
      toggleTrack(
        track,
        [track],
        { id: song.id, name: "Canción suelta", type: "song" },
      );
    } finally {
      setPlayingId(null);
    }
  };

  return (
    <>
      {buttonHost && createPortal(
        <button
          type="button"
          className={`${styles.filterButton} ${selectedIds.size > 0 ? styles.filterButtonActive : ""}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setFilterOpen((value) => !value);
          }}
          aria-label="Filtrar canciones por temas"
          title="Filtrar por temas"
        >
          <FilterIcon size={17} />
          {selectedIds.size > 0 && <i>{selectedIds.size}</i>}
        </button>,
        buttonHost,
      )}

      {panelHost && createPortal(
        <div className={styles.portalContent}>
          {filterOpen && (
            <section className={styles.filterPanel}>
              <div className={styles.filterHeader}>
                <div>
                  <strong>Filtrar por temas</strong>
                  <small>La canción debe tener todos los temas seleccionados.</small>
                </div>
                <button
                  type="button"
                  onClick={() => setFilterOpen(false)}
                  aria-label="Cerrar filtros"
                >
                  <XIcon size={16} />
                </button>
              </div>

              <label className={styles.themeSearch}>
                <SearchIcon size={15} />
                <input
                  value={themeQuery}
                  onChange={(event) => setThemeQuery(event.target.value)}
                  placeholder="Buscar tema…"
                />
              </label>

              <div className={styles.themeGrid}>
                {loading ? (
                  <div className={styles.empty}>Cargando temas…</div>
                ) : filteredThemes.map((theme) => (
                  <button
                    type="button"
                    key={theme.id}
                    className={selectedIds.has(theme.id) ? styles.themeSelected : ""}
                    onClick={() => toggleTheme(theme.id)}
                  >
                    <i style={{ background: themeColor(theme.id) }} />
                    <span>{theme.name}</span>
                    <small>{theme.count}</small>
                  </button>
                ))}
              </div>

              {selectedIds.size > 0 && (
                <button
                  type="button"
                  className={styles.clearButton}
                  onClick={() => setSelectedIds(new Set())}
                >
                  Quitar filtros
                </button>
              )}
            </section>
          )}

          {selectedIds.size > 0 && (
            <section className={styles.results}>
              <div className={styles.resultsHeader}>
                <div>
                  <strong>{matchingSongs.length} canciones</strong>
                  <small>
                    {data?.isAdmin
                      ? "Incluye canciones ocultas por ser admin"
                      : "Solo canciones visibles"}
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() => setFilterOpen((value) => !value)}
                >
                  <FilterIcon size={15} />
                  Temas
                </button>
              </div>

              <div className={styles.selectedThemes}>
                {[...selectedIds].map((id) => {
                  const theme = themesById.get(id);
                  if (!theme) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleTheme(id)}
                    >
                      <i style={{ background: themeColor(id) }} />
                      {theme.name}
                      <XIcon size={12} />
                    </button>
                  );
                })}
              </div>

              <div className={styles.songList}>
                {matchingSongs.slice(0, visibleCount).map((song) => {
                  const isCurrent = activeTrackId === song.id;
                  const isLoading = playingId === song.id;
                  return (
                    <article
                      key={song.id}
                      className={`${styles.songResult} ${isCurrent ? styles.songResultActive : ""}`}
                    >
                      <button
                        type="button"
                        className={styles.songButton}
                        onClick={() => void playSong(song.id)}
                        disabled={Boolean(playingId && !isLoading)}
                      >
                        <span className={styles.artworkWrap}>
                          <SongArtwork
                            src={song.iconUrl}
                            alt={song.name}
                            className={styles.artwork}
                          />
                          <span className={styles.playOverlay}>
                            {isCurrent && activeIsPlaying
                              ? <PauseIcon size={16} fill="currentColor" />
                              : <PlayIcon size={16} fill="currentColor" />}
                          </span>
                        </span>

                        <span className={styles.songCopy}>
                          <span className={styles.titleLine}>
                            <strong>{song.name}</strong>
                            {song.hidden && (
                              <em><EyeOffIcon size={11} /> Oculta</em>
                            )}
                          </span>
                          <small>
                            {song.themeIds
                              .map((id) => themesById.get(id)?.name)
                              .filter(Boolean)
                              .slice(0, 3)
                              .join(" · ") || "Sin temas"}
                          </small>
                        </span>
                      </button>
                    </article>
                  );
                })}

                {matchingSongs.length === 0 && (
                  <div className={styles.empty}>
                    No hay canciones con estos temas
                    {query.trim() ? ` y “${query.trim()}”` : ""}.
                  </div>
                )}
              </div>

              {visibleCount < matchingSongs.length && (
                <button
                  type="button"
                  className={styles.loadMore}
                  onClick={() => setVisibleCount((value) => value + PAGE_SIZE)}
                >
                  <ChevronDownIcon size={16} />
                  Cargar más canciones
                </button>
              )}
            </section>
          )}
        </div>,
        panelHost,
      )}
    </>
  );
}
