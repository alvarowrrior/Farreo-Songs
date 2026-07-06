"use client";

import { MusicIcon } from "lucide-react";
import { getMediaUrl } from "@/lib/radioApi";

interface SongArtworkProps {
  src?: string | null;
  alt?: string;
  className?: string;
}

export default function SongArtwork({ src, alt = "", className = "" }: SongArtworkProps) {
  const resolvedSrc = src ? getMediaUrl(src) : "";

  if (resolvedSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={resolvedSrc}
        alt={alt}
        className={`song-artwork ${className}`}
        loading="lazy"
      />
    );
  }

  return (
    <span className={`song-artwork song-artwork--fallback ${className}`} aria-hidden="true">
      <MusicIcon size={18} />
    </span>
  );
}
