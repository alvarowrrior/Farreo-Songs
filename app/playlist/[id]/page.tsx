"use client";

import { useParams } from "next/navigation";
import PlaylistPlayer from "@/components/PlaylistPlayer";

export default function PlaylistPage() {
  const params = useParams<{ id: string }>();
  const playlistId = decodeURIComponent(params.id);

  return <PlaylistPlayer playlistId={playlistId} />;
}
