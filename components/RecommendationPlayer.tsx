"use client";

import { useEffect, useState } from "react";
import { CompassIcon } from "lucide-react";
import PlaylistSongTable from "@/components/PlaylistSongTable";
import RecommendationArtwork from "@/components/RecommendationArtwork";
import { useMusicPlayer } from "@/components/MusicPlayerProvider";
import { auth } from "@/lib/firebase";
import { addSongToPrivatePlaylist, listOwnPrivatePlaylists, type PrivatePlaylist } from "@/lib/privatePlaylists";
import { getMediaUrl } from "@/lib/radioApi";
import { getSharedRecommendation, type WeeklyRecommendation } from "@/lib/recommendations";

export default function RecommendationPlayer({ token }: { token: string }) {
  const { currentTrack, isPlaying, toggleTrack } = useMusicPlayer();
  const [recommendation, setRecommendation] = useState<WeeklyRecommendation | null>(null);
  const [playlists, setPlaylists] = useState<PrivatePlaylist[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getSharedRecommendation(token).then(value => active && setRecommendation(value)).catch(reason => active && setError(reason instanceof Error ? reason.message : "No se pudo abrir."));
    const user = auth?.currentUser;
    if (user) listOwnPrivatePlaylists(user.uid).then(value => active && setPlaylists(value)).catch(() => undefined);
    return () => { active = false; };
  }, [token]);

  const tracks = (recommendation?.songs || []).map(song => ({ ...song, url: getMediaUrl(song.url) }));
  const source = recommendation ? { id: recommendation.id, name: recommendation.name, type: "song" as const } : null;

  return (
    <main className="playlist-admin recommendation-player">
      <div className="playlist-admin__content">
        <header className="recommendation-player__header">
          {recommendation ? <RecommendationArtwork songs={recommendation.songs} className="recommendation-player__artwork" sizes="160px" /> : <CompassIcon size={30} />}
          <div><small>Seleccion semanal</small><h1>{recommendation?.name || (error ? "Recomendacion no disponible" : "Preparando recomendacion...")}</h1></div>
        </header>
        {error ? <p className="playlist-admin__empty">{error}</p> : (
          <PlaylistSongTable
            tracks={tracks}
            currentTrackId={currentTrack?.id}
            isPlaying={isPlaying}
            source={source}
            loading={!recommendation}
            onPlayTrack={(track, queue, activeSource) => toggleTrack(track, queue, activeSource)}
            personalPlaylists={playlists}
            onAddToPlaylist={(playlistId, track) => addSongToPrivatePlaylist(playlistId, track.id)}
            onShare={track => void navigator.clipboard.writeText(`${window.location.origin}/play?song=${encodeURIComponent(track.id)}`)}
          />
        )}
        <div
          aria-hidden="true"
          style={{
            height: "calc(84px + 46px + 3rem)",
            flex: "0 0 calc(84px + 46px + 3rem)",
          }}
        />
      </div>
    </main>
  );
}
