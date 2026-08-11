import SongArtwork from "@/components/SongArtwork";
import type { ApiSong } from "@/lib/radioApi";

interface RecommendationArtworkProps {
  songs: ApiSong[];
  className?: string;
  sizes?: string;
}

export default function RecommendationArtwork({ songs, className = "", sizes = "96px" }: RecommendationArtworkProps) {
  const visibleSongs = songs.length > 0
    ? Array.from({ length: 4 }, (_, index) => songs[index % songs.length])
    : [];
  return (
    <span className={`recommendation-artwork ${className}`.trim()} aria-hidden="true">
      {visibleSongs.map((song, index) => (
        <SongArtwork key={`${song.id}-${index}`} src={song.iconUrl} alt="" sizes={sizes} />
      ))}
    </span>
  );
}
