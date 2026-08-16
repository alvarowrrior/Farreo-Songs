"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { useRouter } from "next/navigation";
import { CompassIcon, Disc3Icon, HeartIcon, ListMusicIcon, PauseIcon, PlayIcon, PlusIcon, Share2Icon } from "lucide-react";
import FarreoContextMenu, { type FarreoContextMenuItem } from "@/components/FarreoContextMenu";
import RecommendationArtwork from "@/components/RecommendationArtwork";
import SongArtwork from "@/components/SongArtwork";
import { useMusicPlayer } from "@/components/MusicPlayerProvider";
import { auth } from "@/lib/firebase";
import { followAlbum, unfollowAlbum } from "@/lib/albums";
import { addSongToPrivatePlaylist, listOwnPrivatePlaylists, type PrivatePlaylist } from "@/lib/privatePlaylists";
import { getMediaUrl } from "@/lib/radioApi";
import { getHomeRecommendations, isDailyRecommendationRevealed, markDailyRecommendationRevealed, millisecondsUntilNextRecommendationDay, recommendationHref, type HomeRecommendations as RecommendationData, type WeeklyRecommendation } from "@/lib/recommendations";
import { playRevealSound } from "@/lib/revealSound";

interface HomeRecommendationsProps {
  userId?: string | null;
}

const playlistIcon = (playlist: PrivatePlaylist) => playlist.iconUrl ? (
  // eslint-disable-next-line @next/next/no-img-element
  <img src={getMediaUrl(playlist.iconUrl)} alt="" className="farreo-context-menu__playlist-icon" />
) : <span className="farreo-context-menu__playlist-icon farreo-context-menu__playlist-icon--fallback"><ListMusicIcon size={13} /></span>;

export default function HomeRecommendations({ userId }: HomeRecommendationsProps) {
  const router = useRouter();
  const { currentTrack, isPlaying, toggleTrack, volume } = useMusicPlayer();
  const [data, setData] = useState<RecommendationData | null>(null);
  const [authReady, setAuthReady] = useState(!auth);
  const [viewerUid, setViewerUid] = useState<string | null>(auth?.currentUser?.uid || null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [dailyRevealing, setDailyRevealing] = useState(false);
  const [privatePlaylists, setPrivatePlaylists] = useState<PrivatePlaylist[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: FarreoContextMenuItem[] } | null>(null);

  // The Home component mounts before Firebase has necessarily restored the
  // previous session. Never request/show guest recommendations during that
  // window: wait for the definitive auth state first.
  useEffect(() => {
    if (!auth) {
      setViewerUid(null);
      setAuthReady(true);
      return;
    }

    return onAuthStateChanged(auth, (user) => {
      setData(null);
      setLoading(true);
      setLoadError("");
      setViewerUid(user?.uid || null);
      setAuthReady(true);
    });
  }, []);

  const resolvedUserId = auth ? viewerUid : userId || null;

  useEffect(() => {
    if (!authReady) return;

    let active = true;
    setData(null);
    setLoading(true);
    setLoadError("");

    getHomeRecommendations()
      .then((value) => {
        if (active) setData(value);
      })
      .catch((error) => {
        if (active) {
          setData(null);
          setLoadError(error instanceof Error ? error.message : "No se pudieron cargar las recomendaciones.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    if (resolvedUserId) {
      listOwnPrivatePlaylists(resolvedUserId)
        .then((value) => active && setPrivatePlaylists(value))
        .catch(() => active && setPrivatePlaylists([]));
    } else {
      setPrivatePlaylists([]);
    }

    return () => {
      active = false;
    };
  }, [authReady, resolvedUserId]);

  useEffect(() => {
    if (!authReady || !data) return;

    let active = true;
    const timer = window.setTimeout(() => {
      // Hide yesterday's cards while the new day's account snapshot is fetched.
      setLoading(true);
      setLoadError("");

      getHomeRecommendations(true)
        .then((value) => {
          if (active) setData(value);
        })
        .catch((error) => {
          if (active) {
            setData(null);
            setLoadError(error instanceof Error ? error.message : "No se pudieron actualizar las recomendaciones.");
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, millisecondsUntilNextRecommendationDay());

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [authReady, data?.dayKey, resolvedUserId]);

  const context = (event: MouseEvent, items: FarreoContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const loadingView = (
    <section className="playlist-admin__section playlist-admin__section--recommendations">
      <div className="playlist-admin__section-header playlist-admin__section-header--library">
        <h2 className="playlist-admin__section-title"><CompassIcon size={20} /> Recomendaciones</h2>
      </div>
      <div className="playlist-admin__recommendations" aria-live="polite" aria-busy="true">
        <div
          className="playlist-admin__recommendation-card"
          style={{ cursor: "default", opacity: 0.72, pointerEvents: "none" }}
        >
          <CompassIcon size={24} />
          <span>
            <strong>Cargando recomendaciones...</strong>
            <small>Preparando tu canción del día y selecciones semanales</small>
          </span>
        </div>
      </div>
    </section>
  );

  if (!authReady || loading) return loadingView;

  if (!data) {
    return (
      <section className="playlist-admin__section playlist-admin__section--recommendations">
        <div className="playlist-admin__section-header playlist-admin__section-header--library">
          <h2 className="playlist-admin__section-title"><CompassIcon size={20} /> Recomendaciones</h2>
        </div>
        <div className="playlist-admin__recommendations">
          <div
            className="playlist-admin__recommendation-card"
            style={{ cursor: "default", opacity: 0.72, pointerEvents: "none" }}
          >
            <CompassIcon size={24} />
            <span>
              <strong>Recomendaciones no disponibles</strong>
              <small>{loadError || "No se pudieron cargar ahora mismo."}</small>
            </span>
          </div>
        </div>
      </section>
    );
  }

  const revealDaily = (song: NonNullable<RecommendationData["dailySong"]>) => {
    if (dailyRevealing) return;
    setDailyRevealing(true);
    markDailyRecommendationRevealed(data.dayKey, song.id);
    playRevealSound(volume);
    window.setTimeout(() => {
      setDailyRevealing(false);
    }, 1350);
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

  const weeklyCard = (weekly: WeeklyRecommendation) => (
    <button
      key={weekly.id}
      type="button"
      className="playlist-admin__recommendation-card"
      disabled={weekly.songs.length === 0}
      onClick={() => router.push(recommendationHref(weekly.shareToken))}
      onContextMenu={event => context(event, [{
        label: "Compartir",
        icon: <Share2Icon size={15} />,
        onSelect: () => void navigator.clipboard.writeText(`${window.location.origin}${recommendationHref(weekly.shareToken)}`),
      }])}
    >
      <RecommendationArtwork songs={weekly.songs} className="playlist-admin__recommendation-collage" sizes="56px" />
      <span><strong>{weekly.name}</strong><small>Seleccion semanal</small></span>
    </button>
  );

  return (
    <section className="playlist-admin__section playlist-admin__section--recommendations">
      <div className="playlist-admin__section-header playlist-admin__section-header--library">
        <h2 className="playlist-admin__section-title"><CompassIcon size={20} /> Recomendaciones</h2>
      </div>
      <div className="playlist-admin__recommendations" aria-label="Recomendaciones de Farreo">
        {data.dailySong && (() => {
          const song = data.dailySong;
          const track = { ...song, url: getMediaUrl(song.url) };
          const isCurrent = currentTrack?.id === song.id;
          const concealed = data.dailySongUnheard && (dailyRevealing || !isDailyRecommendationRevealed(data.dayKey, song.id));
          return (
            <button
              type="button"
              className={`playlist-admin__recommendation-card playlist-admin__recommendation-card--daily ${isCurrent && isPlaying ? "playlist-admin__recommendation-card--playing" : ""} ${concealed ? "playlist-admin__recommendation-card--concealed" : ""} ${dailyRevealing ? "playlist-admin__recommendation-card--revealing" : ""}`}
              onClick={() => concealed ? revealDaily(song) : toggleTrack(track, [track], { id: song.id, name: "Cancion del dia", type: "song" })}
              onContextMenu={concealed ? undefined : event => context(event, songContext(song))}
            >
              <span className="playlist-admin__recommendation-artwork">
                <SongArtwork src={song.iconUrl} alt={song.name} />
                <span className="playlist-admin__recommendation-play-state" aria-hidden="true">
                  {isCurrent && isPlaying ? <PauseIcon size={19} fill="currentColor" /> : <PlayIcon size={19} fill="currentColor" />}
                </span>
              </span>
              <span className="playlist-admin__recommendation-copy"><strong>Cancion del dia</strong><small>{song.name}</small></span>
              {concealed && (
                <span className="playlist-admin__recommendation-reveal" aria-hidden="true">
                  <Disc3Icon size={22} />
                  <span><strong>Cancion del dia</strong><small>{dailyRevealing ? "Revelando..." : "Toca para descubrirla"}</small></span>
                  <span className="playlist-admin__recommendation-reveal-particles"><i /><i /><i /><i /></span>
                </span>
              )}
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
