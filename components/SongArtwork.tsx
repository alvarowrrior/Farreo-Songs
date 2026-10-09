"use client";

import { useEffect, useRef, useState } from "react";
import { MusicIcon } from "lucide-react";
import { getMediaUrl, MUSIC_API_URL } from "@/lib/radioApi";

interface SongArtworkProps {
  src?: string | null;
  alt?: string;
  className?: string;
  sizes?: string;
  eager?: boolean;
  nativeQuality?: boolean;
  onReady?: () => void;
}

export default function SongArtwork({
  src, alt = "", className = "", sizes = "64px", eager = false,
  nativeQuality = false, onReady,
}: SongArtworkProps) {
  const [failed, setFailed] = useState(false);
  const onReadyRef = useRef(onReady);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  const resolvedSrc = src ? getMediaUrl(src) : "";
  const songIconMatch = src?.match(/^\/song-icons\/([^/?#]+)$/);
  const srcSet = !nativeQuality && songIconMatch
    ? [64, 96, 128, 256, 512]
      .map(size => `${MUSIC_API_URL}/song-icon/${size}/${encodeURIComponent(songIconMatch[1])} ${size}w`)
      .join(", ")
    : undefined;

  useEffect(() => {
    setFailed(false);
    if (!resolvedSrc) onReadyRef.current?.();
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
        // List thumbnails should yield bandwidth to audio and the current
        // song's cover. The visible list no longer gets normal priority.
        fetchPriority={eager ? "high" : "low"}
        decoding="async"
        onLoad={() => onReadyRef.current?.()}
        onError={(event) => {
          const image = event.currentTarget;
          if (image.srcset && image.dataset.originalFallback !== "true") {
            image.dataset.originalFallback = "true";
            image.srcset = "";
            image.src = resolvedSrc;
            return;
          }
          setFailed(true);
          onReadyRef.current?.();
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
