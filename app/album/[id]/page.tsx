"use client";

import { useParams } from "next/navigation";
import AlbumPlayer from "@/components/AlbumPlayer";

export default function AlbumPage() {
  const params = useParams<{ id: string }>();
  return <AlbumPlayer albumId={decodeURIComponent(params.id)} />;
}
