"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
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

function Collapsible({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`song-discovery ${open ? "song-discovery--open" : ""}`}>
      <button type="button" className="song-discovery__heading" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <span>{icon}{title}</span>
        <ChevronDownIcon size={17} />
      </button>
      {open ? <div className="song-discovery__list">{children}</div> : null}
    </section>
  );
}

export default function SongDiscoverySections({ track, onPlaySong, variant = "desktop", onMobileAlbumActions, onOpenMobileAlbum, onMobileSongActions }: SongDiscoverySectionsProps) {
  const [albums, setAlbums] = useState<AlbumCard[]>([]);
  const [similar, setSimilar] = useState<ApiSong[]>([]);
  const [privatePlaylists, setPrivatePlaylists] = useState<PrivatePlaylist[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: FarreoContextMenuItem[] } | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([listSongAlbums(track.id), listSimilarSongs(track.id)])
      .then(([nextAlbums, nextSimilar]) => {
        if (!active) return;
        setAlbums(nextAlbums);
        setSimilar(nextSimilar);
      })
      .catch(() => {
        if (!active) return;
        setAlbums([]);
        setSimilar([]);
      });
    const user = auth?.currentUser;
    const playlistsRequest = user ? listOwnPrivatePlaylists(user.uid) : Promise.resolve([]);
    playlistsRequest.then(items => active && setPrivatePlaylists(items)).catch(() => undefined);
    return () => { active = false; };
  }, [track.id]);

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
        setAlbums(current => current.map(item => item.id === album.id ? { ...item, isFollowing: !album.isFollowing } : item));
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
      children: privatePlaylists.map(playlist => ({
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
      {albums.length > 0 ? (
        <Collapsible title="Albumes" icon={<Disc3Icon size={17} />}>
          {albums.map(album => (
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
                <button type="button" onClick={event => { event.preventDefault(); onMobileAlbumActions(album); }} aria-label="Opciones del album">•••</button>
              ) : null}
            </div>
          ))}
        </Collapsible>
      ) : null}

      {similar.length > 0 ? (
        <Collapsible title="Canciones similares" icon={<ListMusicIcon size={17} />}>
          {similar.map(song => (
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
      ) : null}
      {menu ? <FarreoContextMenu {...menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}
