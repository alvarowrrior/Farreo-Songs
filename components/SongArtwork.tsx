"use client";

import { MusicIcon } from "lucide-react";
import { getMediaUrl, MUSIC_API_URL } from "@/lib/radioApi";

interface SongArtworkProps {
  src?: string | null;
  alt?: string;
  className?: string;
  sizes?: string;
  eager?: boolean;
}

export default function SongArtwork({ src, alt = "", className = "", sizes = "64px", eager = false }: SongArtworkProps) {
  const resolvedSrc = src ? getMediaUrl(src) : "";
  const songIconMatch = src?.match(/^\/song-icons\/([^/?#]+)$/);
  const srcSet = songIconMatch
    ? [64, 96, 128, 256, 512]
      .map(size => `${MUSIC_API_URL}/song-icon/${size}/${encodeURIComponent(songIconMatch[1])} ${size}w`)
      .join(", ")
    : undefined;

  if (resolvedSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={resolvedSrc}
        srcSet={srcSet}
        sizes={srcSet ? sizes : undefined}
        alt={alt}
        className={`song-artwork ${className}`}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        onError={(event) => {
          const image = event.currentTarget;
          if (!image.srcset || image.dataset.originalFallback === "true") return;
          image.dataset.originalFallback = "true";
          image.srcset = "";
          image.src = resolvedSrc;
        }}
      />
    );
  }

  return (
    <span className={`song-artwork song-artwork--fallback ${className}`} aria-hidden="true">
      <MusicIcon size={18} />
    </span>
  );
}
