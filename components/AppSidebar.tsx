"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  GlobeIcon,
  HouseIcon,
  LibraryIcon,
  LockIcon,
  LogInIcon,
  LogOutIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RadioIcon,
  SearchIcon,
  ShareIcon,
  ShieldIcon,
  TrashIcon,
} from "lucide-react";
import { auth } from "@/lib/firebase";
import { getMediaUrl, radioGet, type ApiPlaylistInfo, type ApiSong } from "@/lib/radioApi";
import {
  addSongToPrivatePlaylist,
  createPrivatePlaylist,
  deletePrivatePlaylist,
  listOwnPrivatePlaylists,
  updatePrivatePlaylist,
  type PrivatePlaylist,
  type PrivatePlaylistVisibility,
} from "@/lib/privatePlaylists";
import { listFollowedGlobalPlaylistIds, unfollowGlobalPlaylist } from "@/lib/globalPlaylistFollows";
import FarreoContextMenu, { type FarreoContextMenuItem } from "@/components/FarreoContextMenu";
import SongArtwork from "@/components/SongArtwork";
import { useHiddenSongs } from "@/lib/useHiddenSongs";
import { useMusicPlayer, type MusicTrack } from "@/components/MusicPlayerProvider";

const ADMIN_EMAILS = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);

interface SidebarEditorState {
  open: boolean;
  playlist: PrivatePlaylist | null;
  name: string;
  iconUrl: string;
  visibility: PrivatePlaylistVisibility;
}

interface ContextMenuState {
  x: number;
  y: number;
  items: FarreoContextMenuItem[];
}

function Avatar({ user }: { user: User }) {
  const photo = user.photoURL;
  const name = user.displayName ?? user.email ?? "Usuario";
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  if (photo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={photo} alt={name} className="avatar__img" referrerPolicy="no-referrer" />
    );
  }

  return <div className="avatar__fallback">{initials || "U"}</div>;
}

function PlaylistContextIcon({ playlist }: { playlist: PrivatePlaylist }) {
  if (playlist.iconUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={playlist.iconUrl} alt="" className="farreo-context-menu__playlist-icon" />
    );
  }

  return (
    <span className="farreo-context-menu__playlist-icon farreo-context-menu__playlist-icon--fallback">
      <LibraryIcon size={13} />
    </span>
  );
}

const normalizeSearch = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const songMatchesQuery = (song: ApiSong, query: string) => {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) return false;
  const values = [song.name, ...(song.variantes || [])].map(normalizeSearch);
  return values.some((value) => value.includes(normalizedQuery));
};

export default function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { isVisible, loading: hiddenLoading } = useHiddenSongs();
  const { currentTrack, playQueue } = useMusicPlayer();
  const [expanded, setExpanded] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [songSearchQuery, setSongSearchQuery] = useState("");
  const [songResults, setSongResults] = useState<ApiSong[]>([]);
  const [allSongs, setAllSongs] = useState<ApiSong[]>([]);
  const [songSearchSubmitted, setSongSearchSubmitted] = useState(false);
  const [songSearchLoading, setSongSearchLoading] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [privatePlaylists, setPrivatePlaylists] = useState<PrivatePlaylist[]>([]);
  const [followedPlaylists, setFollowedPlaylists] = useState<ApiPlaylistInfo[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [shareSongTarget, setShareSongTarget] = useState<ApiSong | null>(null);
  const [copiedLink, setCopiedLink] = useState<"normal" | "internal" | null>(null);
  const [editor, setEditor] = useState<SidebarEditorState>({
    open: false,
    playlist: null,
    name: "",
    iconUrl: "",
    visibility: "private",
  });

  const isAdmin = Boolean(user?.email && ADMIN_EMAILS.includes(user.email));

  const focusSearch = () => {
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const openSearchPanel = () => {
    setExpanded(true);
    setSearchOpen(true);
    focusSearch();
  };

  const getVisibleSongResults = useCallback((songs: ApiSong[], query: string) => (
    songs
      .filter((song) => isVisible(song.id))
      .filter((song) => songMatchesQuery(song, query))
      .slice(0, 40)
  ), [isVisible]);

  const executeSongSearch = useCallback(async () => {
    const query = songSearchQuery.trim();
    setSearchOpen(true);
    setExpanded(true);

    if (!query) {
      setSongSearchSubmitted(false);
      setSongResults([]);
      focusSearch();
      return;
    }

    if (hiddenLoading) {
      setSongSearchSubmitted(true);
      setSongResults([]);
      setSongSearchLoading(false);
      return;
    }

    try {
      setSongSearchLoading(true);
      const songs = allSongs.length > 0 ? allSongs : await radioGet<ApiSong[]>("/canciones");
      if (allSongs.length === 0) setAllSongs(songs);
      setSongResults(getVisibleSongResults(songs, query));
      setSongSearchSubmitted(true);
    } catch {
      setSongResults([]);
      setSongSearchSubmitted(true);
    } finally {
      setSongSearchLoading(false);
      focusSearch();
    }
  }, [allSongs, getVisibleSongResults, hiddenLoading, songSearchQuery]);

  useEffect(() => {
    if (!songSearchSubmitted || hiddenLoading) return;
    setSongResults(getVisibleSongResults(allSongs, songSearchQuery));
  }, [allSongs, getVisibleSongResults, hiddenLoading, songSearchQuery, songSearchSubmitted]);

  useEffect(() => {
    if (hiddenLoading || !songSearchSubmitted || !songSearchQuery.trim() || allSongs.length > 0) return;
    void executeSongSearch();
  }, [allSongs.length, executeSongSearch, hiddenLoading, songSearchQuery, songSearchSubmitted]);

  const reloadLibrary = useCallback(async (activeUser = user) => {
    if (!activeUser) {
      setPrivatePlaylists([]);
      setFollowedPlaylists([]);
      return;
    }

    try {
      const [own, followedIds, globals] = await Promise.all([
        listOwnPrivatePlaylists(activeUser.uid),
        listFollowedGlobalPlaylistIds(activeUser.uid),
        radioGet<ApiPlaylistInfo[]>("/playlists"),
      ]);
      const followedSet = new Set(followedIds);
      setPrivatePlaylists(own);
      setFollowedPlaylists(globals.filter((playlist) => followedSet.has(playlist.id)));
    } catch {
      setPrivatePlaylists([]);
      setFollowedPlaylists([]);
    }
  }, [user]);

  useEffect(() => {
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      void reloadLibrary(nextUser);
    });
    return () => unsub();
  }, [reloadLibrary]);

  useEffect(() => {
    const reload = () => void reloadLibrary();
    window.addEventListener("farreo:library-updated", reload);
    return () => window.removeEventListener("farreo:library-updated", reload);
  }, [reloadLibrary]);

  const openCreate = () => {
    if (!user) {
      router.push("/login");
      return;
    }

    setExpanded(true);
    setLibraryOpen(true);
    setEditor({ open: true, playlist: null, name: "", iconUrl: "", visibility: "private" });
  };

  const openEdit = (playlist: PrivatePlaylist) => {
    setEditor({
      open: true,
      playlist,
      name: playlist.nombre,
      iconUrl: playlist.iconUrl || "",
      visibility: playlist.visibility,
    });
  };

  const saveEditor = async () => {
    const name = editor.name.trim();
    if (!user || !name) return;

    if (editor.playlist) {
      await updatePrivatePlaylist(editor.playlist.id, {
        nombre: name,
        iconUrl: editor.iconUrl || null,
        visibility: editor.visibility,
      });
    } else {
      await createPrivatePlaylist({
        ownerId: user.uid,
        ownerEmail: user.email,
        nombre: name,
        iconUrl: editor.iconUrl || null,
        visibility: editor.visibility,
      });
    }

    setEditor((current) => ({ ...current, open: false }));
    await reloadLibrary();
    window.dispatchEvent(new Event("farreo:library-updated"));
  };

  const sharePrivatePlaylist = (playlist: PrivatePlaylist) => {
    if (playlist.visibility !== "public") {
      window.alert("No puedes compartir una playlist privada. Hazla pública primero.");
      return;
    }
    void navigator.clipboard.writeText(`${window.location.origin}/user-playlist/${encodeURIComponent(playlist.id)}`);
  };

  const shareGlobalPlaylist = (playlist: ApiPlaylistInfo) => {
    void navigator.clipboard.writeText(`${window.location.origin}/playlist/${encodeURIComponent(playlist.id)}`);
  };

  const shareSong = (song: ApiSong) => {
    setCopiedLink(null);
    setShareSongTarget(song);
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

  const playSingleSong = (song: ApiSong) => {
    const track = songToTrack(song);
    playQueue([track], 0, { id: song.id, name: "Canción suelta", type: "song" });
  };

  const addSongToOwnPlaylist = async (playlist: PrivatePlaylist, song: ApiSong) => {
    await addSongToPrivatePlaylist(playlist.id, song.id);
    window.dispatchEvent(new Event("farreo:library-updated"));
  };

  const deleteOwnPlaylist = async (playlist: PrivatePlaylist) => {
    if (!window.confirm(`Eliminar la playlist "${playlist.nombre}"?`)) return;
    await deletePrivatePlaylist(playlist.id);
    await reloadLibrary();
    window.dispatchEvent(new Event("farreo:library-updated"));
    if (pathname === `/user-playlist/${playlist.id}`) router.push("/");
  };

  const unfollowPlaylist = async (playlist: ApiPlaylistInfo) => {
    if (!user) return;
    await unfollowGlobalPlaylist(user.uid, playlist.id);
    await reloadLibrary();
    window.dispatchEvent(new Event("farreo:library-updated"));
  };

  const privateContextItems = (playlist: PrivatePlaylist): FarreoContextMenuItem[] => [
    { label: "Compartir", icon: <ShareIcon size={15} />, onSelect: () => sharePrivatePlaylist(playlist) },
    { label: "Editar", icon: <PencilIcon size={15} />, onSelect: () => openEdit(playlist) },
    { label: "Borrar", icon: <TrashIcon size={15} />, danger: true, onSelect: () => void deleteOwnPlaylist(playlist) },
  ];

  const followedContextItems = (playlist: ApiPlaylistInfo): FarreoContextMenuItem[] => [
    { label: "Compartir", icon: <ShareIcon size={15} />, onSelect: () => shareGlobalPlaylist(playlist) },
    { label: "Dejar de seguir", icon: <TrashIcon size={15} />, danger: true, onSelect: () => void unfollowPlaylist(playlist) },
  ];

  const songAddContextItems = (song: ApiSong): FarreoContextMenuItem[] => {
    if (!user) {
      return [{ label: "Inicia sesión para añadir", icon: <PlusIcon size={15} />, disabled: true, onSelect: () => undefined }];
    }

    if (privatePlaylists.length === 0) {
      return [{ label: "Sin playlists propias", icon: <PlusIcon size={15} />, disabled: true, onSelect: () => undefined }];
    }

    return privatePlaylists.map((playlist) => ({
      label: playlist.nombre,
      icon: <PlaylistContextIcon playlist={playlist} />,
      onSelect: () => void addSongToOwnPlaylist(playlist, song).catch(() => undefined),
    }));
  };

  const songContextItems = (song: ApiSong): FarreoContextMenuItem[] => [
    { label: "Reproducir", icon: <PlayIcon size={15} />, onSelect: () => playSingleSong(song) },
    ...songAddContextItems(song).map((item) => ({ ...item, label: item.disabled ? item.label : `Añadir a ${item.label}` })),
    { label: "Compartir", icon: <ShareIcon size={15} />, onSelect: () => shareSong(song) },
  ];

  const openContextMenu = (event: React.MouseEvent, items: FarreoContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  const openSongAddMenu = (event: React.MouseEvent, song: ApiSong) => {
    openContextMenu(event, songAddContextItems(song));
  };

  const userLabel = user?.displayName || user?.email || "Login";

  return (
    <>
      <aside className={`app-sidebar ${expanded ? "app-sidebar--expanded" : ""}`}>
        <div className="app-sidebar__top">
          <Link href="/" className="app-sidebar__brand" aria-label="Farreo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={expanded ? "/brand/farreo.png" : "/brand/farreo-f.png"} alt="Farreo" />
          </Link>
          <button
            type="button"
            className="app-sidebar__collapse"
            onClick={() => {
              if (expanded) setLibraryOpen(false);
              setExpanded(!expanded);
            }}
            title={expanded ? "Plegar barra" : "Desplegar barra"}
          >
            {expanded ? <ChevronLeftIcon size={26} /> : <ChevronRightIcon size={26} />}
          </button>
        </div>

        <nav className="app-sidebar__nav" aria-label="Navegación principal">
          <div className={`app-sidebar__search ${searchOpen ? "app-sidebar__search--open" : ""}`}>
            {expanded ? (
              <form
                className="app-sidebar__search-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void executeSongSearch();
                }}
              >
                <SearchIcon size={18} />
                <input
                  ref={searchInputRef}
                  type="search"
                  value={songSearchQuery}
                  onChange={(event) => setSongSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void executeSongSearch();
                  }}
                  placeholder="Buscar canciones"
                  aria-label="Buscar canciones"
                />
                <button type="submit" title="Buscar canciones">
                  <SearchIcon size={15} />
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="app-sidebar__nav-item"
                onClick={openSearchPanel}
                title="Buscar"
              >
                <SearchIcon size={20} />
                <span>Buscar</span>
              </button>
            )}

            {expanded && searchOpen && songSearchSubmitted && (
              <section className="app-sidebar__song-results" aria-label="Resultados de canciones">
                {songSearchLoading ? (
                  <span className="app-sidebar__empty">Buscando canciones...</span>
                ) : songResults.length === 0 ? (
                  <span className="app-sidebar__empty">Sin canciones encontradas</span>
                ) : (
                  songResults.map((song) => (
                    <div
                      key={song.id}
                      className={`app-sidebar__song-result ${currentTrack?.id === song.id ? "app-sidebar__song-result--active" : ""}`}
                      onClick={() => playSingleSong(song)}
                      onContextMenu={(event) => openContextMenu(event, songContextItems(song))}
                      title="Reproducir canción"
                    >
                      <span className="app-sidebar__song-thumb">
                        <SongArtwork src={song.iconUrl} alt={song.name} className="app-sidebar__song-artwork" />
                        <span className="app-sidebar__song-play"><PlayIcon size={12} /></span>
                      </span>
                      <div className="app-sidebar__song-result-text">
                        <span title={song.name}>{song.name}</span>
                        {song.variantes && song.variantes.length > 0 && (
                          <small title={song.variantes.join(", ")}>{song.variantes.join(", ")}</small>
                        )}
                      </div>
                      <button
                        type="button"
                        className="app-sidebar__song-add"
                        onClick={(event) => openSongAddMenu(event, song)}
                        title="Añadir a playlist"
                      >
                        <PlusIcon size={15} />
                      </button>
                    </div>
                  ))
                )}
              </section>
            )}
          </div>

          <button
            type="button"
            className={`app-sidebar__nav-item ${libraryOpen ? "app-sidebar__nav-item--active" : ""}`}
            onClick={() => {
              if (!expanded) setExpanded(true);
              setLibraryOpen((value) => !value);
            }}
            title="Librería"
          >
            <LibraryIcon size={20} />
            <span>Librería</span>
          </button>

          {expanded && libraryOpen && (
            <section className="app-sidebar__library">
              {user && (
                <button type="button" className="app-sidebar__create" onClick={openCreate}>
                  <PlusIcon size={15} />
                  <span>Crear playlist</span>
                </button>
              )}

              <div className={`app-sidebar__playlist-list ${(privatePlaylists.length + followedPlaylists.length) > 6 ? "app-sidebar__playlist-list--scroll" : ""}`}>
                {privatePlaylists.map((playlist) => (
                  <Link
                    key={playlist.id}
                    href={`/user-playlist/${playlist.id}`}
                    className="app-sidebar__playlist"
                    onContextMenu={(event) => openContextMenu(event, privateContextItems(playlist))}
                  >
                    {playlist.iconUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={playlist.iconUrl} alt="" />
                    ) : (
                      <span className="app-sidebar__playlist-fallback"><LibraryIcon size={16} /></span>
                    )}
                    <span>{playlist.nombre}</span>
                  </Link>
                ))}

                {followedPlaylists.map((playlist) => (
                  <Link
                    key={playlist.id}
                    href={`/playlist/${playlist.id}`}
                    className="app-sidebar__playlist"
                    onContextMenu={(event) => openContextMenu(event, followedContextItems(playlist))}
                  >
                    {playlist.iconUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={getMediaUrl(playlist.iconUrl)} alt="" />
                    ) : (
                      <span className="app-sidebar__playlist-fallback"><GlobeIcon size={16} /></span>
                    )}
                    <span>{playlist.nombre}</span>
                  </Link>
                ))}

                {!user && (
                  <Link href="/login" className="app-sidebar__empty-link">
                    Inicia sesión para ver tu librería
                  </Link>
                )}

                {user && privatePlaylists.length === 0 && followedPlaylists.length === 0 && (
                  <span className="app-sidebar__empty">Sin playlists guardadas</span>
                )}
              </div>
            </section>
          )}

        </nav>

        <div className="app-sidebar__dock">
          <Link
            href="/"
            className={`app-sidebar__nav-item ${pathname === "/" ? "app-sidebar__nav-item--active" : ""}`}
            title="Inicio"
          >
            <HouseIcon size={20} />
            <span>Inicio</span>
          </Link>
          <Link
            href="/radio"
            className={`app-sidebar__nav-item ${pathname.startsWith("/radio") ? "app-sidebar__nav-item--active" : ""}`}
            title="Radio"
          >
            <RadioIcon size={20} />
            <span>Radio</span>
          </Link>
        </div>

        <div className="app-sidebar__bottom">
          {isAdmin && (
            <Link
              href="/admin"
              className={`app-sidebar__nav-item ${pathname.startsWith("/admin") ? "app-sidebar__nav-item--active" : ""}`}
              title="Admin"
            >
              <ShieldIcon size={20} />
              <span>Admin</span>
            </Link>
          )}
          {user ? (
            <div className="app-sidebar__account-row">
              <Link href="/perfil" className="app-sidebar__user" title={userLabel}>
                <Avatar user={user} />
                <span>{userLabel}</span>
              </Link>
              {expanded && auth && (
                <button type="button" className="app-sidebar__signout" onClick={() => { if (auth) void signOut(auth); }} title="Cerrar sesión">
                  <LogOutIcon size={16} />
                </button>
              )}
            </div>
          ) : (
            <Link href="/login" className="app-sidebar__nav-item" title="Login">
              <LogInIcon size={20} />
              <span>Login</span>
            </Link>
          )}
        </div>
      </aside>

      {contextMenu && (
        <FarreoContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {shareSongTarget && (
        <div className="playlist-admin__modal-overlay" onClick={() => setShareSongTarget(null)}>
          <div className="playlist-admin__modal" onClick={(event) => event.stopPropagation()}>
            <div className="playlist-admin__modal-header">
              <h3>Compartir Canción</h3>
              <button type="button" onClick={() => setShareSongTarget(null)} className="playlist-admin__btn-cancel-small">x</button>
            </div>

            <p style={{ fontSize: "0.95rem", color: "#b3b3b3", marginBottom: "1.5rem" }}>
              Canción: <strong style={{ color: "#fff" }}>{shareSongTarget.name}</strong>
            </p>

            <div className="playlist-admin__upload-form-group" style={{ marginBottom: "1.2rem" }}>
              <label className="playlist-admin__upload-form-label">Link de la canción</label>
              <div className="playlist-admin__upload-form-row">
                <input
                  type="text"
                  readOnly
                  value={`${window.location.origin}/play?song=${encodeURIComponent(shareSongTarget.id)}`}
                  className="playlist-admin__upload-form-input"
                />
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/play?song=${encodeURIComponent(shareSongTarget.id)}`).then(() => {
                      setCopiedLink("normal");
                      setTimeout(() => setCopiedLink(null), 2000);
                    });
                  }}
                  className="playlist-admin__upload-form-add"
                >
                  {copiedLink === "normal" ? "Copiado!" : "Copiar"}
                </button>
              </div>
            </div>

            <div className="playlist-admin__upload-form-group" style={{ marginBottom: "1.5rem" }}>
              <label className="playlist-admin__upload-form-label">Link interno (MP3 real)</label>
              <div className="playlist-admin__upload-form-row">
                <input
                  type="text"
                  readOnly
                  value={getMediaUrl(shareSongTarget.url)}
                  className="playlist-admin__upload-form-input"
                />
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(getMediaUrl(shareSongTarget.url)).then(() => {
                      setCopiedLink("internal");
                      setTimeout(() => setCopiedLink(null), 2000);
                    });
                  }}
                  className="playlist-admin__upload-form-add"
                >
                  {copiedLink === "internal" ? "Copiado!" : "Copiar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editor.open && (
        <div className="playlist-admin__modal-overlay" onClick={() => setEditor((current) => ({ ...current, open: false }))}>
          <div className="playlist-admin__modal" onClick={(event) => event.stopPropagation()}>
            <div className="playlist-admin__modal-header">
              <h3>{editor.playlist ? "Editar Playlist" : "Crear Playlist"}</h3>
              <button type="button" onClick={() => setEditor((current) => ({ ...current, open: false }))} className="playlist-admin__btn-cancel-small">x</button>
            </div>

            <div className="playlist-admin__upload-form-group">
              <label className="playlist-admin__upload-form-label">Nombre</label>
              <input
                type="text"
                value={editor.name}
                onChange={(event) => setEditor((current) => ({ ...current, name: event.target.value }))}
                className="playlist-admin__upload-form-input"
                autoFocus
              />
            </div>

            <div className="playlist-admin__upload-form-group">
              <label className="playlist-admin__upload-form-label">Icono opcional</label>
              <input
                type="text"
                value={editor.iconUrl}
                onChange={(event) => setEditor((current) => ({ ...current, iconUrl: event.target.value }))}
                className="playlist-admin__upload-form-input"
                placeholder="URL o data URL"
              />
            </div>

            <div className="playlist-admin__upload-form-group">
              <label className="playlist-admin__upload-form-label">Visibilidad</label>
              <div className="playlist-admin__chips">
                <button
                  type="button"
                  className={`playlist-admin__chip ${editor.visibility === "private" ? "" : "playlist-admin__chip--muted"}`}
                  onClick={() => setEditor((current) => ({ ...current, visibility: "private" }))}
                >
                  <LockIcon size={14} /> Privada
                </button>
                <button
                  type="button"
                  className={`playlist-admin__chip ${editor.visibility === "public" ? "" : "playlist-admin__chip--muted"}`}
                  onClick={() => setEditor((current) => ({ ...current, visibility: "public" }))}
                >
                  <GlobeIcon size={14} /> Pública
                </button>
              </div>
            </div>

            <button type="button" onClick={() => void saveEditor()} className="playlist-admin__upload-btn">
              {editor.playlist ? "Guardar Cambios" : "Crear Playlist"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
