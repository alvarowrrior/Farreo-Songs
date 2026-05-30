"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import PlaylistPlayer from "@/components/PlaylistPlayer";

function PlayContent() {
  const searchParams = useSearchParams();

  return (
    <PlaylistPlayer
      playlistId={searchParams.get("playlist") ?? undefined}
      songId={searchParams.get("song") ?? undefined}
    />
  );
}

export default function PlayPage() {
  return (
    <Suspense fallback={<div>Cargando reproductor...</div>}>
      <PlayContent />
    </Suspense>
  );
}
