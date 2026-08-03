"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { HeartIcon, ListMusicIcon, PlusIcon, Share2Icon, SparklesIcon } from "lucide-react";
import FarreoContextMenu, { type FarreoContextMenuItem } from "@/components/FarreoContextMenu";
import SongArtwork from "@/components/SongArtwork";
import { useMusicPlayer } from "@/components/MusicPlayerProvider";
import { auth } from "@/lib/firebase";
import { followAlbum, unfollowAlbum } from "@/lib/albums";
import { addSongToPrivatePlaylist, listOwnPrivatePlaylists, type PrivatePlaylist } from "@/lib/privatePlaylists";
import { getMediaUrl } from "@/lib/radioApi";
import { getHomeRecommendations, recommendationHref, type HomeRecommendations as RecommendationData, type WeeklyRecommendation } from "@/lib/recommendations";

interface HomeRecommendationsProps {
  userId?: string | null;
}

const playlistIcon = (playlist: PrivatePlaylist) => playlist.iconUrl ? (
  // eslint-disable-next-line @next/next/no-img-element
  <img src={getMediaUrl(playlist.iconUrl)} alt="" className="farreo-context-menu__playlist-icon" />
) : <span className="farreo-context-menu__playlist-icon farreo-context-menu__playlist-icon--fallback"><ListMusicIcon size={13} /></span>;

export default function HomeRecommendations({ userId }: HomeRecommendationsProps) {
  const router = useRouter();
  const { toggleTrack } = useMusicPlayer();
  const [data, setData] = useState<RecommendationData | null>(null);
  const [privatePlaylists, setPrivatePlaylists] = useState<PrivatePlaylist[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: FarreoContextMenuItem[] } | null>(null);

  useEffect(() => {
    let active = true;
    getHomeRecommendations().then(value => active && setData(value)).catch(() => active && setData(null));
    const playlistsRequest = userId ? listOwnPrivatePlaylists(userId) : Promise.resolve([]);
    playlistsRequest.then(value => active && setPrivatePlaylists(value)).catch(() => undefined);
    return () => { active = false; };
  }, [userId]);

  if (!data) return null;

  const context = (event: MouseEvent, items: FarreoContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const songContext = (song: NonNullable<RecommendationData["dailySong"]>): FarreoContextMenuItem[] => [
    {
      label: "Compartir",
      icon: <Share2Icon size={15} />,
      onSelect: () => undefined,
      children: [
        { label: "Copiar enlace de Farreo", onSelect: () => void navigator.clipboard.writeText(`${window.location.origin}/play?song=${encodeURIComponent(song.id)}`) },
        { label: "Copiar enlace MP3", onSelect: () => void navigator.clipboard.writeText(getMediaUrl(song.url)) },
      ],
    },
    {
      label: "Añadir a playlist",
      icon: <PlusIcon size={15} />,
      disabled: privatePlaylists.length === 0,
      onSelect: () => undefined,
      children: privatePlaylists.map(playlist => ({
        label: playlist.nombre,
        icon: playlistIcon(playlist),
        onSelect: () => void addSongToPrivatePlaylist(playlist.id, song.id),
      })),
    },
  ];

  const playWeekly = (weekly: WeeklyRecommendation) => {
    const tracks = weekly.songs.map(song => ({ ...song, url: getMediaUrl(song.url) }));
    if (!tracks[0]) return;
    toggleTrack(tracks[0], tracks, { id: weekly.id, name: weekly.name, type: "song" });
  };

  const weeklyCard = (weekly: WeeklyRecommendation) => (
    <button
      key={weekly.id}
      type="button"
      className="playlist-admin__recommendation-card"
      disabled={weekly.songs.length === 0}
      onClick={() => playWeekly(weekly)}
      onContextMenu={event => context(event, [{
        label: "Compartir",
        icon: <Share2Icon size={15} />,
        onSelect: () => void navigator.clipboard.writeText(`${window.location.origin}${recommendationHref(weekly.shareToken)}`),
      }])}
    >
      <span className="playlist-admin__recommendation-collage">
        {weekly.songs.slice(0, 4).map(song => <SongArtwork key={song.id} src={song.iconUrl} alt="" />)}
      </span>
      <span><strong>{weekly.name}</strong><small>Seleccion semanal</small></span>
    </button>
  );

  return (
    <section className="playlist-admin__section playlist-admin__section--recommendations">
      <div className="playlist-admin__section-header playlist-admin__section-header--library">
        <h2 className="playlist-admin__section-title"><SparklesIcon size={20} /> Recomendaciones</h2>
      </div>
      <div className="playlist-admin__recommendations" aria-label="Recomendaciones de Farreo">
        {data.dailySong && (() => {
          const song = data.dailySong;
          const track = { ...song, url: getMediaUrl(song.url) };
          return (
            <button
              type="button"
              className="playlist-admin__recommendation-card playlist-admin__recommendation-card--daily"
              onClick={() => toggleTrack(track, [track], { id: song.id, name: "Cancion del dia", type: "song" })}
              onContextMenu={event => context(event, songContext(song))}
            >
              <SongArtwork src={song.iconUrl} alt={song.name} />
              <span><strong>Cancion del dia</strong><small>{song.name}</small></span>
            </button>
          );
        })()}
        {data.weeklyPlaylists.slice(0, 2).map(weeklyCard)}
        {data.weeklyAlbum ? (
          <button
            type="button"
            className="playlist-admin__recommendation-card"
            onClick={() => router.push(`/album/${encodeURIComponent(data.weeklyAlbum!.id)}`)}
            onContextMenu={event => context(event, [
              { label: "Compartir", icon: <Share2Icon size={15} />, onSelect: () => void navigator.clipboard.writeText(`${window.location.origin}/album/${encodeURIComponent(data.weeklyAlbum!.id)}`) },
              ...(auth?.currentUser ? [{
                label: data.weeklyAlbum!.isFollowing ? "Dejar de seguir" : "Seguir",
                icon: <HeartIcon size={15} fill={data.weeklyAlbum!.isFollowing ? "currentColor" : "none"} />,
                onSelect: () => void (data.weeklyAlbum!.isFollowing ? unfollowAlbum(data.weeklyAlbum!.id) : followAlbum(data.weeklyAlbum!.id)).then(() => {
                  setData(current => current?.weeklyAlbum ? { ...current, weeklyAlbum: { ...current.weeklyAlbum, isFollowing: !current.weeklyAlbum.isFollowing } } : current);
                }),
              }] : []),
            ])}
          >
            <SongArtwork src={data.weeklyAlbum.iconUrl} alt={data.weeklyAlbum.nombre} />
            <span><strong>{data.weeklyAlbum.nombre}</strong><small>Album de la semana</small></span>
          </button>
        ) : data.weeklyPlaylists[2] ? weeklyCard(data.weeklyPlaylists[2]) : null}
      </div>
      {menu ? <FarreoContextMenu {...menu} onClose={() => setMenu(null)} /> : null}
    </section>
  );
}
