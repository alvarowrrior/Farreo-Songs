"use client";

import { useParams } from "next/navigation";
import PrivatePlaylistPlayer from "@/components/PrivatePlaylistPlayer";

export default function UserPlaylistPage() {
  const params = useParams<{ id: string }>();
  return <PrivatePlaylistPlayer playlistId={decodeURIComponent(params.id)} />;
}
