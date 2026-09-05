"use client";

import { useEffect, useState } from "react";
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
  const [failed, setFailed] = useState(false);
  const resolvedSrc = src ? getMediaUrl(src) : "";
  const songIconMatch = src?.match(/^\/song-icons\/([^/?#]+)$/);
  const srcSet = songIconMatch
    ? [64, 96, 128, 256, 512]
      .map(size => `${MUSIC_API_URL}/song-icon/${size}/${encodeURIComponent(songIconMatch[1])} ${size}w`)
      .join(", ")
    : undefined;

  useEffect(() => {
    // A changed song/artwork URL gets a fresh attempt even if the previous
    // physical file disappeared.
    setFailed(false);
  }, [resolvedSrc]);

  if (resolvedSrc && !failed) {
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

          // First failure may come from an optimized /song-icon/<size> variant.
          // Retry the original artwork URL once.
          if (image.srcset && image.dataset.originalFallback !== "true") {
            image.dataset.originalFallback = "true";
            image.srcset = "";
            image.src = resolvedSrc;
            return;
          }

          // If the physical original URL is stale/missing too, never expose
          // the browser's broken-image glyph.
          setFailed(true);
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
