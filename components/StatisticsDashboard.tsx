"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LibraryIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Share2Icon,
  ShieldCheckIcon,
} from "lucide-react";
import { onAuthStateChanged, type User } from "firebase/auth";
import FarreoContextMenu, { type FarreoContextMenuItem } from "@/components/FarreoContextMenu";
import SongArtwork from "@/components/SongArtwork";
import SongThemeSelector from "@/components/SongThemeSelector";
import { useMusicPlayer, type MusicTrack } from "@/components/MusicPlayerProvider";
import { auth } from "@/lib/firebase";
import {
  addSongToPrivatePlaylist,
  listOwnPrivatePlaylists,
  type PrivatePlaylist,
} from "@/lib/privatePlaylists";
import {
  createSongTheme,
  deleteSongTheme,
  listSongThemes,
  type SongTheme,
} from "@/lib/songThemes";
import {
  getThemeDiscovery,
  getThemeDiscoverySong,
  songCreatedAtMs,
  themeColor,
  updateThemeDiscoverySongThemes,
  type PublicSongTheme,
  type ThemeDiscoveryPayload,
  type ThemeDiscoverySong,
} from "@/lib/themeDiscovery";
import { getMediaUrl, type ApiSong } from "@/lib/radioApi";
import styles from "./StatisticsDashboard.module.scss";

type FilterMode = "blacklist" | "whitelist";

interface SongContextState {
  x: number;
  y: number;
  song: ThemeDiscoverySong;
}

const normalize = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim();

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

const polar = (cx: number, cy: number, radius: number, angle: number) => {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
};

const piePath = (cx: number, cy: number, radius: number, startAngle: number, endAngle: number) => {
  const start = polar(cx, cy, radius, endAngle);
  const end = polar(cx, cy, radius, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return [
    `M ${cx} ${cy}`,
    `L ${start.x} ${start.y}`,
    `A ${radius} ${radius} 0 ${largeArc} 0 ${end.x} ${end.y}`,
    "Z",
  ].join(" ");
};

export default function StatisticsDashboard() {
  const {
    currentTrack,
    isPlaying,
    togglePlayPause,
    toggleTrack,
  } = useMusicPlayer();

  const [data, setData] = useState<ThemeDiscoveryPayload | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<FilterMode>("blacklist");
  const [filterIds, setFilterIds] = useState<Set<string>>(new Set());
  const [legendQuery, setLegendQuery] = useState("");
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [playingLoadingId, setPlayingLoadingId] = useState<string | null>(null);

  const [songContext, setSongContext] = useState<SongContextState | null>(null);
  const [privatePlaylists, setPrivatePlaylists] = useState<PrivatePlaylist[] | null>(null);
  const [privatePlaylistsLoading, setPrivatePlaylistsLoading] = useState(false);

  const [editingSong, setEditingSong] = useState<ThemeDiscoverySong | null>(null);
  const [editThemeIds, setEditThemeIds] = useState<string[]>([]);
  const [editThemes, setEditThemes] = useState<SongTheme[]>([]);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);

  const refreshDiscovery = useCallback(async (force = true) => {
    const next = await getThemeDiscovery(force);
    setData(next);
    return next;
  }, []);

  useEffect(() => {
    let active = true;

    const load = async () => {
      setLoading(true);
      try {
        const next = await getThemeDiscovery(true);
        if (!active) return;
        setData(next);
        setError("");
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "No se pudieron cargar las estadísticas.");
      } finally {
        if (active) setLoading(false);
      }
    };

    if (!auth) {
      void load();
      return () => { active = false; };
    }

    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setPrivatePlaylists(null);
      void load();
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const themesById = useMemo(
    () => new Map((data?.themes || []).map((theme) => [theme.id, theme])),
    [data?.themes],
  );

  const visibleThemes = useMemo(() => {
    const themes = (data?.themes || []).filter((theme) => theme.count > 0);
    if (mode === "blacklist") return themes.filter((theme) => !filterIds.has(theme.id));
    return themes.filter((theme) => filterIds.has(theme.id));
  }, [data?.themes, filterIds, mode]);

  const totalAssignments = visibleThemes.reduce((sum, theme) => sum + theme.count, 0);

  const slices = useMemo(() => {
    if (totalAssignments <= 0) return [];
    let cursor = 0;
    return visibleThemes.map((theme) => {
      const start = cursor;
      const span = (theme.count / totalAssignments) * 360;
      cursor += span;
      return { theme, start, end: cursor, span };
    });
  }, [totalAssignments, visibleThemes]);

  const filteredLegend = useMemo(() => {
    const query = normalize(legendQuery);
    return [...(data?.themes || [])]
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "es", { sensitivity: "base" }))
      .filter((theme) => !query || normalize(theme.name).includes(query));
  }, [data?.themes, legendQuery]);

  const selectedTheme = selectedThemeId ? themesById.get(selectedThemeId) || null : null;
  const selectedSongs = useMemo(() => {
    if (!selectedThemeId) return [];
    return (data?.songs || [])
      .filter((song) => song.themeIds.includes(selectedThemeId))
      .sort((left, right) => songCreatedAtMs(right) - songCreatedAtMs(left));
  }, [data?.songs, selectedThemeId]);

  useEffect(() => {
    if (!selectedThemeId) return;
    const isStillVisible = visibleThemes.some((theme) => theme.id === selectedThemeId);
    if (!isStillVisible) setSelectedThemeId(null);
  }, [selectedThemeId, visibleThemes]);

  const toggleFilter = (themeId: string) => {
    setFilterIds((current) => {
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

    setPlayingLoadingId(songId);
    try {
      const song = await getThemeDiscoverySong(songId);
      const track = songToTrack(song);
      toggleTrack(track, [track], { id: song.id, name: "Canción suelta", type: "song" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo reproducir la canción.");
    } finally {
      setPlayingLoadingId(null);
    }
  };

  const ensurePrivatePlaylists = async () => {
    if (!user || privatePlaylists !== null || privatePlaylistsLoading) return;
    setPrivatePlaylistsLoading(true);
    try {
      setPrivatePlaylists(await listOwnPrivatePlaylists(user.uid));
    } catch {
      setPrivatePlaylists([]);
    } finally {
      setPrivatePlaylistsLoading(false);
    }
  };

  const copy = (value: string) => void navigator.clipboard.writeText(value);

  const openSongEditor = async (song: ThemeDiscoverySong) => {
    if (!data?.isAdmin) return;
    setEditingSong(song);
    setEditThemeIds([...song.themeIds]);
    setEditThemes((data.themes || []).map((theme) => ({
      id: theme.id,
      name: theme.name,
    })));
    setEditLoading(true);
    try {
      setEditThemes(await listSongThemes());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudieron cargar los temas.");
    } finally {
      setEditLoading(false);
    }
  };

  const createThemeFromEditor = async (name: string) => {
    const { theme } = await createSongTheme(name);
    setEditThemes((current) => [...current.filter((item) => item.id !== theme.id), theme]
      .sort((left, right) => left.name.localeCompare(right.name, "es", { sensitivity: "base" })));
    return theme;
  };

  const deleteThemeFromEditor = async (theme: SongTheme) => {
    await deleteSongTheme(theme.id);
    setEditThemes((current) => current.filter((item) => item.id !== theme.id));
    setEditThemeIds((current) => current.filter((id) => id !== theme.id));
    await refreshDiscovery(true);
  };

  const applySongEditor = async () => {
    if (!editingSong || editSaving) return;
    setEditSaving(true);
    try {
      await updateThemeDiscoverySongThemes(editingSong, editThemeIds);
      await refreshDiscovery(true);
      setEditingSong(null);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudieron aplicar los temas.");
    } finally {
      setEditSaving(false);
    }
  };

  const contextItems = (song: ThemeDiscoverySong): FarreoContextMenuItem[] => {
    const sameSong = currentTrack?.id === song.id;
    const playlistChildren: FarreoContextMenuItem[] = !user
      ? [{ label: "Inicia sesión para añadir", disabled: true, onSelect: () => undefined }]
      : privatePlaylistsLoading
        ? [{ label: "Cargando playlists…", disabled: true, onSelect: () => undefined }]
        : (privatePlaylists || []).length === 0
          ? [{ label: "Sin playlists propias", disabled: true, onSelect: () => undefined }]
          : (privatePlaylists || []).map((playlist) => ({
            label: playlist.nombre,
            icon: <LibraryIcon size={14} />,
            onSelect: () => void addSongToPrivatePlaylist(playlist.id, song.id),
          }));

    const items: FarreoContextMenuItem[] = [
      {
        label: sameSong && isPlaying ? "Pausar" : "Reproducir",
        icon: sameSong && isPlaying ? <PauseIcon size={15} /> : <PlayIcon size={15} />,
        onSelect: () => void playSong(song.id),
      },
      {
        label: "Añadir a playlist",
        icon: <PlusIcon size={15} />,
        onSelect: () => undefined,
        children: playlistChildren,
      },
      {
        label: "Compartir",
        icon: <Share2Icon size={15} />,
        onSelect: () => undefined,
        children: [
          {
            label: "Copiar enlace de Farreo",
            onSelect: () => copy(`${window.location.origin}/play?song=${encodeURIComponent(song.id)}`),
          },
          {
            label: "Copiar enlace MP3",
            onSelect: () => copy(getMediaUrl(song.url)),
          },
        ],
      },
    ];

    if (data?.isAdmin) {
      items.push({
        label: "Editar formulario",
        icon: <PencilIcon size={15} />,
        onSelect: () => void openSongEditor(song),
      });
    }

    return items;
  };

  const openContext = (event: React.MouseEvent, song: ThemeDiscoverySong) => {
    event.preventDefault();
    event.stopPropagation();
    setSongContext({ x: event.clientX, y: event.clientY, song });
    void ensurePrivatePlaylists();
  };

  if (loading) {
    return <section className={styles.page}><div className={styles.loading}>Preparando estadísticas…</div></section>;
  }

  return (
    <section className={styles.page}>
      <div className={styles.mobileBlock}>
        <ShieldCheckIcon size={30} />
        <strong>Estadísticas está disponible en escritorio</strong>
        <span>Esta vista está diseñada para aprovechar el ancho del gráfico y la leyenda.</span>
      </div>

      <div className={styles.desktop}>
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Farreo data</span>
            <h1>Estadísticas</h1>
            <p>
              Distribución de temas entre las canciones a las que tienes acceso.
              {data?.isAdmin ? " Como admin también incluye canciones ocultas." : ""}
            </p>
          </div>
          <div className={styles.summary}>
            <strong>{data?.songs.length || 0}</strong>
            <span>canciones</span>
            <strong>{data?.themes.filter((theme) => theme.count > 0).length || 0}</strong>
            <span>temas usados</span>
          </div>
        </header>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.dashboard}>
          <div className={styles.chartCard}>
            <div className={styles.chartHeading}>
              <div>
                <span>Distribución temática</span>
                <small>{totalAssignments} asignaciones en tu catálogo accesible</small>
              </div>
              {filterIds.size > 0 && (
                <button type="button" onClick={() => setFilterIds(new Set())}>Limpiar filtros</button>
              )}
            </div>

            <div className={styles.chartWrap}>
              {slices.length === 0 ? (
                <div className={styles.noChart}>
                  {mode === "whitelist"
                    ? "Selecciona al menos un tema en la whitelist."
                    : "No quedan temas visibles con este filtro."}
                </div>
              ) : (
                <svg viewBox="0 0 420 420" className={styles.chart} role="img" aria-label="Gráfico circular de temas">
                  {slices.length === 1 ? (
                    <circle
                      cx="210"
                      cy="210"
                      r="185"
                      fill={themeColor(slices[0].theme.id)}
                      className={selectedThemeId === slices[0].theme.id ? styles.sliceSelected : styles.slice}
                      onClick={() => setSelectedThemeId(slices[0].theme.id)}
                    >
                      <title>{`${slices[0].theme.name}: ${slices[0].theme.count}`}</title>
                    </circle>
                  ) : slices.map(({ theme, start, end }) => (
                    <path
                      key={theme.id}
                      d={piePath(210, 210, 185, start, end)}
                      fill={themeColor(theme.id)}
                      className={selectedThemeId === theme.id ? styles.sliceSelected : styles.slice}
                      onClick={() => setSelectedThemeId(theme.id)}
                    >
                      <title>{`${theme.name}: ${theme.count} canciones`}</title>
                    </path>
                  ))}
                </svg>
              )}
            </div>

            <div className={styles.chartHint}>Pulsa un sector para explorar sus canciones.</div>
          </div>

          <aside className={styles.legendCard}>
            <div className={styles.modeSwitch} aria-label="Modo de filtrado">
              <button
                type="button"
                className={mode === "blacklist" ? styles.modeActive : ""}
                onClick={() => { setMode("blacklist"); setFilterIds(new Set()); }}
              >
                Blacklist
              </button>
              <button
                type="button"
                className={mode === "whitelist" ? styles.modeActive : ""}
                onClick={() => { setMode("whitelist"); setFilterIds(new Set()); }}
              >
                Whitelist
              </button>
            </div>

            <p className={styles.modeHelp}>
              {mode === "blacklist"
                ? "Selecciona temas para quitarlos del gráfico."
                : "Selecciona únicamente los temas que quieres ver."}
            </p>

            <label className={styles.legendSearch}>
              <SearchIcon size={15} />
              <input
                value={legendQuery}
                onChange={(event) => setLegendQuery(event.target.value)}
                placeholder="Buscar tema…"
              />
            </label>

            <div className={styles.legendScroll}>
              {filteredLegend.map((theme) => {
                const selected = filterIds.has(theme.id);
                return (
                  <button
                    type="button"
                    key={theme.id}
                    className={`${styles.legendItem} ${selected ? styles.legendItemSelected : ""}`}
                    onClick={() => toggleFilter(theme.id)}
                  >
                    <i style={{ background: themeColor(theme.id) }} />
                    <span>{theme.name}</span>
                    <strong>{theme.count}</strong>
                  </button>
                );
              })}
            </div>
          </aside>
        </div>

        {selectedTheme && (
          <section className={styles.songSection}>
            <div className={styles.songSectionTitle}>
              <i style={{ background: themeColor(selectedTheme.id) }} />
              <div>
                <h2>{selectedTheme.name}</h2>
                <span>{selectedSongs.length} canciones con este tema</span>
              </div>
            </div>

            <div className={styles.songList}>
              {selectedSongs.map((song, index) => (
                <button
                  type="button"
                  key={song.id}
                  className={`${styles.songRow} ${currentTrack?.id === song.id ? styles.songRowActive : ""}`}
                  onClick={() => void playSong(song.id)}
                  onContextMenu={(event) => openContext(event, song)}
                  disabled={playingLoadingId === song.id}
                  title="Click: reproducir/pausar · Click derecho: opciones"
                >
                  <span className={styles.index}>{String(index + 1).padStart(2, "0")}</span>
                  <SongArtwork src={song.iconUrl} alt={song.name} className={styles.artwork} sizes="52px" />
                  <span className={styles.songMain}>
                    <span className={styles.songTitleLine}>
                      <strong>{song.name}</strong>
                      {song.hidden && <em>Oculta</em>}
                    </span>
                    <span className={styles.songThemes}>
                      {song.themeIds
                        .map((id) => themesById.get(id))
                        .filter((theme): theme is PublicSongTheme => Boolean(theme))
                        .map((theme) => (
                          <small key={theme.id}>
                            <i style={{ background: themeColor(theme.id) }} />
                            {theme.name}
                          </small>
                        ))}
                    </span>
                  </span>
                  <span className={styles.playState}>
                    {playingLoadingId === song.id
                      ? "Cargando…"
                      : currentTrack?.id === song.id
                        ? isPlaying ? "Pausar" : "Reanudar"
                        : "Reproducir"}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      {songContext && (
        <FarreoContextMenu
          x={songContext.x}
          y={songContext.y}
          items={contextItems(songContext.song)}
          onClose={() => setSongContext(null)}
        />
      )}

      {editingSong && (
        <div className={styles.editOverlay} onClick={() => !editSaving && setEditingSong(null)}>
          <div className={styles.editModal} onClick={(event) => event.stopPropagation()}>
            <div className={styles.editHeader}>
              <div>
                <span>Editar formulario</span>
                <h3>{editingSong.name}</h3>
              </div>
              {editingSong.hidden && <em>Oculta</em>}
            </div>

            {editLoading ? (
              <div className={styles.editLoading}>Cargando etiquetas…</div>
            ) : (
              <SongThemeSelector
                themes={editThemes}
                selectedIds={editThemeIds}
                onChange={setEditThemeIds}
                onCreate={createThemeFromEditor}
                onDelete={deleteThemeFromEditor}
              />
            )}

            <div className={styles.editActions}>
              <button type="button" onClick={() => setEditingSong(null)} disabled={editSaving}>
                Cancelar
              </button>
              <button type="button" className={styles.editApply} onClick={() => void applySongEditor()} disabled={editSaving || editLoading}>
                {editSaving ? "Aplicando…" : "Aplicar cambios"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
