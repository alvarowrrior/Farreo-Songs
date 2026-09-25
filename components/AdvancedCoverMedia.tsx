"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ADVANCED_COVER_SYNC_CHANGE_EVENT,
  ADVANCED_COVER_SYNC_STORAGE_KEY,
  DEFAULT_ADVANCED_COVER_SYNC,
  getAdvancedCoverSyncEnabled,
} from "@/lib/advancedCoverPlaybackPreference";

interface AdvancedCoverMediaProps {
  src: string;
  mimeType?: string | null;
  isPlaying: boolean;
  playbackRate: number;
  className?: string;
  onReady?: () => void;
}

interface DecodedGifImage {
  duration?: number | null;
  displayWidth?: number;
  displayHeight?: number;
  close?: () => void;
}

interface GifDecoder {
  tracks: {
    ready: Promise<void>;
    selectedTrack?: {
      frameCount?: number;
    } | null;
  };
  decode: (options: {
    frameIndex: number;
    completeFramesOnly?: boolean;
  }) => Promise<{
    image: DecodedGifImage;
  }>;
  close?: () => void;
}

type GifDecoderConstructor = new (options: {
  data: ArrayBuffer;
  type: string;
}) => GifDecoder;

const MEDIA_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "block",
  objectFit: "cover",
  objectPosition: "center center",
};

const clampPlaybackRate = (value: number) => (
  Number.isFinite(value)
    ? Math.max(0.5, Math.min(1.5, value))
    : 1
);

const looksLikeVideo = (src: string, mimeType?: string | null) => (
  Boolean(mimeType?.startsWith("video/"))
  || /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(src)
);

const looksLikeGif = (src: string, mimeType?: string | null) => (
  mimeType === "image/gif"
  || /\.gif(?:[?#]|$)/i.test(src)
);

function SyncedVideo({
  src,
  isPlaying,
  playbackRate,
  syncEnabled,
  className,
  onReady,
}: {
  src: string;
  isPlaying: boolean;
  playbackRate: number;
  syncEnabled: boolean;
  className?: string;
  onReady?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    video.playbackRate = syncEnabled
      ? clampPlaybackRate(playbackRate)
      : 1;

    if (syncEnabled && !isPlaying) {
      video.pause();
      return;
    }

    void video.play().catch(() => {
      // Muted inline media normally autoplays. If the browser still blocks it,
      // the next playback-state change will try again.
    });
  }, [isPlaying, playbackRate, syncEnabled, src]);

  return (
    <video
      ref={ref}
      src={src}
      muted
      loop
      playsInline
      autoPlay={!syncEnabled || isPlaying}
      className={className}
      style={MEDIA_STYLE}
      onLoadedData={onReady}
      onError={onReady}
    />
  );
}

function SyncedGif({
  src,
  isPlaying,
  playbackRate,
  className,
  onReady,
}: {
  src: string;
  isPlaying: boolean;
  playbackRate: number;
  className?: string;
  onReady?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const decoderRef = useRef<GifDecoder | null>(null);
  const frameCountRef = useRef(0);
  const nextFrameRef = useRef(0);
  const initialDelayRef = useRef(100);
  const rateRef = useRef(clampPlaybackRate(playbackRate));
  const [ready, setReady] = useState(false);
  const [fallback, setFallback] = useState(false);

  rateRef.current = clampPlaybackRate(playbackRate);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setFallback(false);
    nextFrameRef.current = 0;
    frameCountRef.current = 0;

    const previous = decoderRef.current;
    decoderRef.current = null;
    previous?.close?.();

    const Decoder = (
      window as unknown as { ImageDecoder?: GifDecoderConstructor }
    ).ImageDecoder;

    if (!Decoder) {
      setFallback(true);
      return undefined;
    }

    const drawFrame = (
      image: DecodedGifImage,
      context: CanvasRenderingContext2D,
    ) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const width = Math.max(1, Number(image.displayWidth) || canvas.width || 1);
      const height = Math.max(1, Number(image.displayHeight) || canvas.height || 1);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        image as unknown as CanvasImageSource,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    };

    void (async () => {
      try {
        const response = await fetch(src, { cache: "force-cache" });
        if (!response.ok) throw new Error(`GIF HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        if (cancelled) return;

        const decoder = new Decoder({ data, type: "image/gif" });
        decoderRef.current = decoder;
        await decoder.tracks.ready;
        if (cancelled || decoderRef.current !== decoder) return;

        const frameCount = Math.max(
          1,
          Number(decoder.tracks.selectedTrack?.frameCount) || 1,
        );
        frameCountRef.current = frameCount;

        const first = await decoder.decode({
          frameIndex: 0,
          completeFramesOnly: true,
        });
        if (cancelled || decoderRef.current !== decoder) {
          first.image.close?.();
          return;
        }

        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) {
          first.image.close?.();
          throw new Error("No canvas 2D context");
        }

        drawFrame(first.image, context);
        initialDelayRef.current = Math.max(
          16,
          (Number(first.image.duration) || 100_000) / 1000,
        );
        first.image.close?.();
        nextFrameRef.current = frameCount > 1 ? 1 : 0;
        setReady(true);
        onReady?.();
      } catch {
        if (!cancelled) setFallback(true);
      }
    })();

    return () => {
      cancelled = true;
      const decoder = decoderRef.current;
      decoderRef.current = null;
      decoder?.close?.();
    };
  }, [src]);

  useEffect(() => {
    if (!ready || !isPlaying || fallback) return undefined;

    let cancelled = false;
    let timer: number | null = null;
    let pendingImage: DecodedGifImage | null = null;

    // The previous scheduler waited for a frame duration and only THEN decoded
    // the next frame. Decode time was therefore added on top of every GIF frame
    // and made x1 visibly slower than the original animation.
    //
    // Keep an absolute presentation deadline instead: decode the next frame
    // immediately, then wait only for the REMAINING time until that deadline.
    // This makes decode cost invisible whenever it fits inside the current
    // frame's display window.
    let presentationAt = performance.now()
      + (initialDelayRef.current / rateRef.current);

    const renderNext = async () => {
      const decoder = decoderRef.current;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      const frameCount = frameCountRef.current;
      if (
        cancelled
        || !decoder
        || !canvas
        || !context
        || frameCount <= 1
      ) {
        return;
      }

      const frameIndex = nextFrameRef.current % frameCount;

      try {
        const decoded = await decoder.decode({
          frameIndex,
          completeFramesOnly: true,
        });

        if (cancelled || decoderRef.current !== decoder) {
          decoded.image.close?.();
          return;
        }

        const image = decoded.image;
        pendingImage = image;

        const present = () => {
          if (cancelled || decoderRef.current !== decoder) {
            image.close?.();
            if (pendingImage === image) pendingImage = null;
            return;
          }

          const width = Math.max(1, Number(image.displayWidth) || canvas.width || 1);
          const height = Math.max(1, Number(image.displayHeight) || canvas.height || 1);
          if (canvas.width !== width) canvas.width = width;
          if (canvas.height !== height) canvas.height = height;

          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(
            image as unknown as CanvasImageSource,
            0,
            0,
            canvas.width,
            canvas.height,
          );

          const frameDuration = Math.max(
            16,
            (Number(image.duration) || 100_000) / 1000,
          );
          image.close?.();
          if (pendingImage === image) pendingImage = null;

          nextFrameRef.current = (frameIndex + 1) % frameCount;

          // Advance from the intended presentation timestamp rather than from
          // "now", so small timer/decode delays do not accumulate into a slower
          // and slower GIF over time.
          presentationAt += frameDuration / rateRef.current;

          // Decode the following frame immediately. Its decode work happens
          // during the current frame's visible interval.
          void renderNext();
        };

        const remaining = presentationAt - performance.now();
        if (remaining <= 1) {
          present();
        } else {
          timer = window.setTimeout(present, remaining);
        }
      } catch {
        if (!cancelled) setFallback(true);
      }
    };

    void renderNext();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      pendingImage?.close?.();
      pendingImage = null;
    };
  }, [fallback, isPlaying, ready, src]);

  if (fallback) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className={className}
        style={MEDIA_STYLE}
        onLoad={onReady}
        onError={onReady}
      />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={MEDIA_STYLE}
      aria-hidden="true"
    />
  );
}

export default function AdvancedCoverMedia({
  src,
  mimeType,
  isPlaying,
  playbackRate,
  className,
  onReady,
}: AdvancedCoverMediaProps) {
  const [syncEnabled, setSyncEnabled] = useState(
    DEFAULT_ADVANCED_COVER_SYNC,
  );

  useEffect(() => {
    const refresh = () => setSyncEnabled(getAdvancedCoverSyncEnabled());
    const onStorage = (event: StorageEvent) => {
      if (event.key === ADVANCED_COVER_SYNC_STORAGE_KEY) refresh();
    };

    refresh();
    window.addEventListener(ADVANCED_COVER_SYNC_CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener(ADVANCED_COVER_SYNC_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  if (looksLikeVideo(src, mimeType)) {
    return (
      <SyncedVideo
        src={src}
        isPlaying={isPlaying}
        playbackRate={playbackRate}
        syncEnabled={syncEnabled}
        className={className}
        onReady={onReady}
      />
    );
  }

  if (looksLikeGif(src, mimeType) && syncEnabled) {
    return (
      <SyncedGif
        src={src}
        isPlaying={isPlaying}
        playbackRate={playbackRate}
        className={className}
        onReady={onReady}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className={className}
      style={MEDIA_STYLE}
      onLoad={onReady}
      onError={onReady}
    />
  );
}
