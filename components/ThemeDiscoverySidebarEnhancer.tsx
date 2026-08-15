"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { FilterIcon, PlayIcon, SearchIcon, XIcon } from "lucide-react";
import SongArtwork from "@/components/SongArtwork";
import { auth } from "@/lib/firebase";
import { useMusicPlayer, type MusicTrack } from "@/components/MusicPlayerProvider";
import {
  getThemeDiscovery,
  getThemeDiscoverySong,
  songCreatedAtMs,
  themeColor,
  type ThemeDiscoveryPayload,
} from "@/lib/themeDiscovery";
import { getMediaUrl, type ApiSong } from "@/lib/radioApi";
import styles from "./ThemeDiscoverySidebarEnhancer.module.scss";

const PAGE_SIZE = 12;

const normalize = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim();

const textMatches = (song: { name: string; variantes?: string[] }, query: string) => {
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
});

function PieGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M11 3a8 8 0 1 0 8 8h-8V3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M15 3.7A8 8 0 0 1 20.3 9H15V3.7Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export default function ThemeDiscoverySidebarEnhancer() {
  const pathname = usePathname();
  const { currentTrack, isPlaying, togglePlayPause, toggleTrack } = useMusicPlayer();
  const [navHost, setNavHost] = useState<HTMLElement | null>(null);
  const [buttonHost, setButtonHost] = useState<HTMLElement | null>(null);
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [data, setData] = useState<ThemeDiscoveryPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [themeQuery, setThemeQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const searchContainerRef = useRef<HTMLElement | null>(null);
  const searchFormRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let observer: MutationObserver | null = null;

    const ensureHosts = () => {
      const sidebar = document.querySelector(".app-sidebar");
      if (!sidebar) return;

      const radioLink = sidebar.querySelector<HTMLElement>('.app-sidebar__dock a[href="/radio"]');
      if (radioLink && (!navHost || !navHost.isConnected)) {
        let host = sidebar.querySelector<HTMLElement>("[data-theme-stats-nav-host]");
        if (!host) {
          host = document.createElement("div");
          host.dataset.themeStatsNavHost = "true";
          host.style.display = "contents";
          radioLink.insertAdjacentElement("afterend", host);
        }
        setNavHost(host);
      }

      const form = sidebar.querySelector<HTMLFormElement>(".app-sidebar__search-form");
      const searchContainer = sidebar.querySelector<HTMLElement>(".app-sidebar__search");
      if (!form || !searchContainer) {
        setButtonHost(null);
        setPanelHost(null);
        searchFormRef.current = null;
        searchContainerRef.current = null;
        inputRef.current = null;
        return;
      }

      searchFormRef.current = form;
      searchContainerRef.current = searchContainer;
      const input = form.querySelector<HTMLInputElement>('input[type="search"]');
      if (inputRef.current !== input) {
        inputRef.current?.removeEventListener("input", handleInput);
        inputRef.current = input;
        if (input) {
          setQuery(input.value || "");
          input.addEventListener("input", handleInput);
        }
      }

      let nextButtonHost = form.querySelector<HTMLElement>("[data-theme-filter-button-host]");
      if (!nextButtonHost) {
        nextButtonHost = document.createElement("div");
        nextButtonHost.dataset.themeFilterButtonHost = "true";
        nextButtonHost.className = styles.filterButtonHost;
        form.appendChild(nextButtonHost);
      }
      form.classList.add(styles.searchFormWithFilter);
      if (!buttonHost || buttonHost !== nextButtonHost) setButtonHost(nextButtonHost);

      let nextPanelHost = searchContainer.querySelector<HTMLElement>("[data-theme-filter-panel-host]");
      if (!nextPanelHost) {
        nextPanelHost = document.createElement("div");
        nextPanelHost.dataset.themeFilterPanelHost = "true";
        searchContainer.appendChild(nextPanelHost);
      }
      if (!panelHost || panelHost !== nextPanelHost) setPanelHost(nextPanelHost);
    };

    function handleInput(event: Event) {
      setQuery((event.target as HTMLInputElement | null)?.value || "");
    }

    ensureHosts();
    observer = new MutationObserver(ensureHosts);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer?.disconnect();
      inputRef.current?.removeEventListener("input", handleInput);
      searchFormRef.current?.classList.remove(styles.searchFormWithFilter);
      searchContainerRef.current?.classList.remove(styles.themeFilterActive);
    };
    // Hosts are DOM integration points and deliberately not effect dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, () => {
      // Discovery is role-aware. Dropping the mounted dataset on an auth
      // transition guarantees that admin/public counts can never bleed into
      // each other in the sidebar filter.
      setData(null);
    });
  }, []);

  useEffect(() => {
    const container = searchContainerRef.current;
    if (!container) return;
    container.classList.toggle(styles.themeFilterActive, selectedIds.size > 0);
  }, [selectedIds, panelHost]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, selectedIds]);

  useEffect(() => {
    if (!filterOpen && selectedIds.size === 0) return;
    if (data || loading) return;
    setLoading(true);
    void getThemeDiscovery()
      .then(setData)
      .catch(() => setData({ generatedAt: "", isAdmin: false, themes: [], songs: [] }))
      .finally(() => setLoading(false));
  }, [data, filterOpen, loading, selectedIds.size]);

  const filteredThemes = useMemo(() => {
    const normalized = normalize(themeQuery);
    return [...(data?.themes || [])]
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "es", { sensitivity: "base" }))
      .filter((theme) => !normalized || normalize(theme.name).includes(normalized));
  }, [data?.themes, themeQuery]);

  const filteredSongs = useMemo(() => {
    if (selectedIds.size === 0) return [];
    const required = [...selectedIds];
    return [...(data?.songs || [])]
      .filter((song) => required.every((id) => song.themeIds.includes(id)))
      .filter((song) => textMatches(song, query))
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

  const playSong = async (songId: string) => {
    if (currentTrack?.id === songId) {
      togglePlayPause();
      return;
    }

    setPlayingId(songId);
    try {
      const song = await getThemeDiscoverySong(songId);
      const track = songToTrack(song);
      toggleTrack(track, [track], { id: song.id, name: "Canción suelta", type: "song" });
    } finally {
      setPlayingId(null);
    }
  };

  return (
    <>
      {navHost && createPortal(
        <Link
          href="/estadisticas"
          className={`app-sidebar__nav-item ${styles.statsNav} ${pathname.startsWith("/estadisticas") ? "app-sidebar__nav-item--active" : ""}`}
          title="Estadísticas"
        >
          <PieGlyph size={20} />
          <span>Estadísticas</span>
        </Link>,
        navHost,
      )}

      {buttonHost && createPortal(
        <button
          type="button"
          className={`${styles.filterButton} ${selectedIds.size > 0 ? styles.filterButtonActive : ""}`}
          title="Filtrar por temas"
          aria-label="Filtrar búsqueda por temas"
          onClick={() => setFilterOpen((value) => !value)}
        >
          <FilterIcon size={15} />
          {selectedIds.size > 0 && <i>{selectedIds.size}</i>}
        </button>,
        buttonHost,
      )}

      {panelHost && createPortal(
        <>
          {filterOpen && (
            <section className={styles.filterPanel}>
              <div className={styles.filterPanelHeader}>
                <div>
                  <strong>Temas</strong>
                  <small>Los temas seleccionados deben coincidir todos.</small>
                </div>
                <button type="button" onClick={() => setFilterOpen(false)} aria-label="Cerrar filtros">
                  <XIcon size={14} />
                </button>
              </div>

              <label className={styles.themeSearch}>
                <SearchIcon size={14} />
                <input
                  value={themeQuery}
                  onChange={(event) => setThemeQuery(event.target.value)}
                  placeholder="Buscar tema…"
                />
              </label>

              <div className={styles.themeGrid}>
                {loading ? (
                  <span className={styles.filterEmpty}>Cargando temas…</span>
                ) : filteredThemes.map((theme) => (
                  <button
                    type="button"
                    key={theme.id}
                    className={selectedIds.has(theme.id) ? styles.themeSelected : ""}
                    onClick={() => toggleTheme(theme.id)}
                    title={`${theme.name} · ${theme.count} canciones`}
                  >
                    <i style={{ background: themeColor(theme.id) }} />
                    <span>{theme.name}</span>
                    <small>{theme.count}</small>
                  </button>
                ))}
              </div>

              {selectedIds.size > 0 && (
                <button type="button" className={styles.clearFilters} onClick={() => setSelectedIds(new Set())}>
                  Quitar filtros
                </button>
              )}
            </section>
          )}

          {selectedIds.size > 0 && (
            <section className={styles.filteredResults} aria-label="Resultados filtrados por tema">
              <div className={styles.resultsMeta}>
                <span>{filteredSongs.length} coincidencias</span>
                {query.trim() && <small>+ nombre “{query.trim()}”</small>}
              </div>

              {filteredSongs.length === 0 ? (
                <span className="app-sidebar__empty">Sin canciones encontradas</span>
              ) : (
                <>
                  {filteredSongs.slice(0, visibleCount).map((song) => (
                    <button
                      type="button"
                      key={song.id}
                      className={`app-sidebar__song-result ${styles.resultButton} ${currentTrack?.id === song.id ? "app-sidebar__song-result--active" : ""}`}
                      onClick={() => void playSong(song.id)}
                      disabled={playingId === song.id}
                      title="Reproducir canción"
                    >
                      <span className="app-sidebar__song-thumb">
                        <SongArtwork src={song.iconUrl} alt={song.name} className="app-sidebar__song-artwork" />
                        <span className="app-sidebar__song-play"><PlayIcon size={12} /></span>
                      </span>
                      <div className="app-sidebar__song-result-text">
                        <span title={song.name}>{song.name}</span>
                        <small>
                          {playingId === song.id
                            ? "Cargando…"
                            : `${song.hidden ? "Oculta · " : ""}${song.themeIds.filter((id) => selectedIds.has(id)).length}/${selectedIds.size} temas · ${currentTrack?.id === song.id ? (isPlaying ? "sonando" : "pausada") : "más reciente primero"}`}
                        </small>
                      </div>
                      <PlayIcon size={14} className={styles.resultAction} />
                    </button>
                  ))}

                  {visibleCount < filteredSongs.length && (
                    <button
                      type="button"
                      className={styles.loadMore}
                      onClick={() => setVisibleCount((value) => value + PAGE_SIZE)}
                    >
                      Cargar más
                    </button>
                  )}
                </>
              )}
            </section>
          )}
        </>,
        panelHost,
      )}
    </>
  );
}
