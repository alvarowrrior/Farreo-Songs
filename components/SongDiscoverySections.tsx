"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDownIcon, Disc3Icon, HeartIcon, ListMusicIcon, PlusIcon, Share2Icon } from "lucide-react";
import FarreoContextMenu, { type FarreoContextMenuItem } from "@/components/FarreoContextMenu";
import SongArtwork from "@/components/SongArtwork";
import type { MusicTrack } from "@/components/MusicPlayerProvider";
import { auth } from "@/lib/firebase";
import { followAlbum, listSongAlbums, unfollowAlbum, type AlbumCard } from "@/lib/albums";
import { addSongToPrivatePlaylist, listOwnPrivatePlaylists, type PrivatePlaylist } from "@/lib/privatePlaylists";
import { getMediaUrl, type ApiSong } from "@/lib/radioApi";
import { listSimilarSongs } from "@/lib/songDiscovery";

interface SongDiscoverySectionsProps {
  track: MusicTrack;
  onPlaySong: (song: ApiSong) => void;
  variant?: "desktop" | "mobile";
  onMobileAlbumActions?: (album: AlbumCard) => void;
  onOpenMobileAlbum?: (album: AlbumCard) => void;
  onMobileSongActions?: (song: ApiSong) => void;
}

const copy = (value: string) => navigator.clipboard.writeText(value);

function Collapsible({
  title,
  icon,
  children,
  revealOnOpen = false,
  onOpen,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  revealOnOpen?: boolean;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open || !revealOnOpen) return;
    const frame = window.requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, revealOnOpen]);

  const toggle = () => {
    const next = !open;
    setOpen(next);

    // onOpen puede actualizar estado del componente padre (por ejemplo,
    // setSimilarLoading). Nunca debe ejecutarse dentro del updater de setOpen:
    // React puede evaluar ese updater durante render y marcarlo como
    // "setState while rendering a different component".
    if (next) onOpen?.();
  };

  return (
    <section ref={sectionRef} className={`song-discovery ${open ? "song-discovery--open" : ""}`}>
      <button type="button" className="song-discovery__heading" onClick={toggle} aria-expanded={open}>
        <span>{icon}{title}</span>
        <ChevronDownIcon size={17} />
      </button>
      {open ? <div className="song-discovery__list">{children}</div> : null}
    </section>
  );
}

export default function SongDiscoverySections({ track, onPlaySong, variant = "desktop", onMobileAlbumActions, onOpenMobileAlbum, onMobileSongActions }: SongDiscoverySectionsProps) {
  const [albums, setAlbums] = useState<AlbumCard[]>([]);
  const [albumsLoaded, setAlbumsLoaded] = useState(false);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [similar, setSimilar] = useState<ApiSong[]>([]);
  const [similarLoaded, setSimilarLoaded] = useState(false);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [privatePlaylists, setPrivatePlaylists] = useState<PrivatePlaylist[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: FarreoContextMenuItem[] } | null>(null);
  const userId = auth?.currentUser?.uid || null;

  // A track change used to trigger three data requests immediately: album
  // discovery, similar songs and the user's entire private-playlist query.
  // Discovery is now lazy and private playlists are loaded only when the user
  // identity changes, not for every song played.
  useEffect(() => {
    setAlbums([]);
    setAlbumsLoaded(false);
    setAlbumsLoading(false);
    setSimilar([]);
    setSimilarLoaded(false);
    setSimilarLoading(false);
  }, [track.id]);

  useEffect(() => {
    let active = true;
    if (!userId) {
      setPrivatePlaylists([]);
      return () => { active = false; };
    }
    listOwnPrivatePlaylists(userId)
      .then((items) => {
        if (active) setPrivatePlaylists(items);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [userId]);

  const loadAlbums = () => {
    if (albumsLoaded || albumsLoading) return;
    setAlbumsLoading(true);
    void listSongAlbums(track.id)
      .then(setAlbums)
      .catch(() => setAlbums([]))
      .finally(() => {
        setAlbumsLoaded(true);
        setAlbumsLoading(false);
      });
  };

  const loadSimilar = () => {
    if (similarLoaded || similarLoading) return;
    setSimilarLoading(true);
    void listSimilarSongs(track.id)
      .then(setSimilar)
      .catch(() => setSimilar([]))
      .finally(() => {
        setSimilarLoaded(true);
        setSimilarLoading(false);
      });
  };

  const openMenu = (event: MouseEvent, items: FarreoContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const albumItems = (album: AlbumCard): FarreoContextMenuItem[] => [
    {
      label: "Compartir",
      icon: <Share2Icon size={15} />,
      onSelect: () => void copy(`${window.location.origin}/album/${encodeURIComponent(album.id)}`),
    },
    ...(auth?.currentUser ? [{
      label: album.isFollowing ? "Dejar de seguir" : "Seguir",
      icon: <HeartIcon size={15} fill={album.isFollowing ? "currentColor" : "none"} />,
      onSelect: () => void (album.isFollowing ? unfollowAlbum(album.id) : followAlbum(album.id)).then(() => {
        setAlbums((current) => current.map((item) => item.id === album.id ? { ...item, isFollowing: !album.isFollowing } : item));
      }),
    }] : []),
  ];

  const songItems = (song: ApiSong): FarreoContextMenuItem[] => [
    {
      label: "Compartir",
      icon: <Share2Icon size={15} />,
      onSelect: () => undefined,
      children: [
        { label: "Copiar enlace de Farreo", onSelect: () => void copy(`${window.location.origin}/play/${encodeURIComponent(song.id)}`) },
        { label: "Copiar enlace MP3", onSelect: () => void copy(getMediaUrl(song.url)) },
      ],
    },
    {
      label: "Añadir a playlist",
      icon: <PlusIcon size={15} />,
      disabled: privatePlaylists.length === 0,
      onSelect: () => undefined,
      children: privatePlaylists.map((playlist) => ({
        label: playlist.nombre,
        icon: playlist.iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={getMediaUrl(playlist.iconUrl)} alt="" className="farreo-context-menu__playlist-icon" />
        ) : <span className="farreo-context-menu__playlist-icon farreo-context-menu__playlist-icon--fallback"><ListMusicIcon size={13} /></span>,
        onSelect: () => void addSongToPrivatePlaylist(playlist.id, song.id),
      })),
    },
  ];

  return (
    <>
      <Collapsible key={`albums:${track.id}`} title="Albumes" icon={<Disc3Icon size={17} />} revealOnOpen={variant === "desktop"} onOpen={loadAlbums}>
        {albumsLoading ? <p className="song-discovery__empty">Cargando albumes...</p> : null}
        {!albumsLoading && albumsLoaded && albums.length === 0 ? <p className="song-discovery__empty">Esta cancion no aparece en ningun album disponible.</p> : null}
        {albums.map((album) => (
          <div
            key={album.id}
            className="song-discovery__row"
            onContextMenu={variant === "desktop" ? event => openMenu(event, albumItems(album)) : undefined}
          >
            {variant === "mobile" ? (
              <button type="button" className="song-discovery__play-row" onClick={() => onOpenMobileAlbum?.(album)}>
                {album.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={getMediaUrl(album.iconUrl)} alt="" loading="lazy" />
                ) : <span className="song-discovery__fallback"><Disc3Icon size={17} /></span>}
                <span><strong>{album.nombre}</strong><small>{album.numCanciones} canciones</small></span>
              </button>
            ) : (
              <Link className="song-discovery__play-row" href={`/album/${encodeURIComponent(album.id)}`}>
                {album.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={getMediaUrl(album.iconUrl)} alt="" loading="lazy" />
                ) : <span className="song-discovery__fallback"><Disc3Icon size={17} /></span>}
                <span><strong>{album.nombre}</strong><small>{album.numCanciones} canciones</small></span>
              </Link>
            )}
            {variant === "mobile" && onMobileAlbumActions ? (
              <button type="button" onClick={(event) => { event.preventDefault(); onMobileAlbumActions(album); }} aria-label="Opciones del album">•••</button>
            ) : null}
          </div>
        ))}
      </Collapsible>

      <Collapsible key={`similar:${track.id}`} title="Canciones similares" icon={<ListMusicIcon size={17} />} revealOnOpen={variant === "desktop"} onOpen={loadSimilar}>
        {similarLoading ? <p className="song-discovery__empty">Buscando canciones similares...</p> : null}
        {!similarLoading && similarLoaded && similar.length === 0 ? <p className="song-discovery__empty">No hay canciones similares etiquetadas.</p> : null}
        {similar.map((song) => (
          <div
            key={song.id}
            className="song-discovery__row"
            onContextMenu={variant === "desktop" ? event => openMenu(event, songItems(song)) : undefined}
          >
            <button type="button" className="song-discovery__play-row" onClick={() => onPlaySong(song)}>
              <SongArtwork src={song.iconUrl} alt={song.name} />
              <span><strong>{song.name}</strong><small>{song.variantes?.slice(0, 2).join(", ") || "Cancion"}</small></span>
            </button>
            {variant === "mobile" && onMobileSongActions ? (
              <button type="button" onClick={() => onMobileSongActions(song)} aria-label="Opciones de la cancion">•••</button>
            ) : null}
          </div>
        ))}
      </Collapsible>

      {menu ? <FarreoContextMenu {...menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}
