"use client";

import { useEffect, useRef, useState } from "react";
import { useMusicPlayer } from "@/components/MusicPlayerProvider";
import { addFarreoNativeListener, getFarreoNativeAudio } from "@/lib/nativeAudio";

const MAX_BAR_COUNT = 420;

const sampleFrequencyData = (
  data: Uint8Array<ArrayBufferLike>,
  index: number,
  barCount: number,
) => {
  const position = index / Math.max(1, barCount - 1);
  const distanceFromCenter = Math.abs(position - 0.5) * 2;
  const curvedPosition = Math.pow(distanceFromCenter, 1.55);
  const center = Math.min(data.length - 1, Math.floor(curvedPosition * (data.length - 1)));
  const previous = data[Math.max(0, center - 1)] ?? 0;
  const current = data[center] ?? 0;
  const next = data[Math.min(data.length - 1, center + 1)] ?? 0;

  return ((previous * 0.25) + (current * 0.5) + (next * 0.25)) / 255;
};

export default function MusicWaveHeader({ simple = false }: { simple?: boolean }) {
  const { currentTrack, isPlaying, getAudioFrequencyData } = useMusicPlayer();
  const [nativePlayback, setNativePlayback] = useState({ known: false, hasTrack: false, isPlaying: false });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const nativeFrequencyDataRef = useRef<Uint8Array | null>(null);
  const smoothedLevelsRef = useRef<Float32Array>(new Float32Array(MAX_BAR_COUNT));
  const lastFrameAtRef = useRef(0);

  useEffect(() => {
    const native = getFarreoNativeAudio();
    if (!native) return undefined;
    let disposed = false;

    const syncPlayback = (payload: unknown) => {
      if (disposed || !payload || typeof payload !== "object") return;
      const state = payload as { currentTrack?: unknown; isPlaying?: unknown };
      setNativePlayback({
        known: true,
        hasTrack: Boolean(state.currentTrack),
        isPlaying: Boolean(state.isPlaying),
      });
    };

    const syncFrequency = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const samples = (payload as { samples?: unknown }).samples;
      if (!Array.isArray(samples)) return;
      nativeFrequencyDataRef.current = Uint8Array.from(
        samples.map((value) => Math.max(0, Math.min(255, Number(value) || 0))),
      );
    };

    void native.getState().then(syncPlayback).catch(() => undefined);
    const handles = [
      addFarreoNativeListener("state", syncPlayback),
      addFarreoNativeListener("trackChanged", syncPlayback),
      addFarreoNativeListener("ended", syncPlayback),
      addFarreoNativeListener("frequency", syncFrequency),
    ];

    return () => {
      disposed = true;
      handles.forEach((promise) => void promise.then((handle) => handle?.remove()).catch(() => undefined));
    };
  }, []);

  const nativeIsPlaying = nativePlayback.known && nativePlayback.hasTrack && nativePlayback.isPlaying;
  const webIsPlaying = !nativePlayback.known && Boolean(currentTrack && isPlaying);
  const shouldShow = nativeIsPlaying || webIsPlaying;

  useEffect(() => {
    if (!nativeIsPlaying) return;
    void getFarreoNativeAudio()?.enableVisualization().catch(() => undefined);
  }, [nativeIsPlaying]);

  useEffect(() => {
    if (!shouldShow) return undefined;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return undefined;

    const smoothedLevels = smoothedLevelsRef.current;
    let cssWidth = 0;
    let cssHeight = 0;

    const resizeCanvas = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, bounds.width);
      const nextHeight = Math.max(1, bounds.height);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const targetWidth = Math.round(nextWidth * pixelRatio);
      const targetHeight = Math.round(nextHeight * pixelRatio);
      cssWidth = nextWidth;
      cssHeight = nextHeight;
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      }
    };

    resizeCanvas();
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(resizeCanvas)
      : null;
    resizeObserver?.observe(canvas);
    if (!resizeObserver) window.addEventListener("resize", resizeCanvas, { passive: true });

    const tick = (now: number) => {
      rafRef.current = window.requestAnimationFrame(tick);
      const frameInterval = nativeIsPlaying ? 50 : 32;
      if (now - lastFrameAtRef.current < frameInterval) return;
      lastFrameAtRef.current = now;

      const data = nativeIsPlaying
        ? nativeFrequencyDataRef.current
        : getAudioFrequencyData();
      if (!data || data.length === 0 || cssWidth <= 0 || cssHeight <= 0) return;

      const gap = cssWidth <= 540 ? 0.55 : 0.8;
      const barWidth = cssWidth <= 540 ? 0.9 : 1.15;
      const barCount = Math.min(
        MAX_BAR_COUNT,
        Math.max(1, Math.floor((cssWidth + gap) / (barWidth + gap))),
      );
      const usedWidth = (barCount * barWidth) + ((barCount - 1) * gap);
      const startX = Math.max(0, (cssWidth - usedWidth) / 2);

      context.clearRect(0, 0, cssWidth, cssHeight);
      context.fillStyle = "#fff";
      for (let index = 0; index < barCount; index += 1) {
        const rawLevel = sampleFrequencyData(data, index, barCount);
        const previousLevel = smoothedLevels[index] ?? 0;
        const level = (previousLevel * 0.62) + (rawLevel * 0.38);
        smoothedLevels[index] = level;

        const height = Math.max(1, Math.pow(level, 0.72) * cssHeight);
        context.globalAlpha = Math.min(1, 0.14 + (level * 1.15));
        context.fillRect(startX + (index * (barWidth + gap)), 0, barWidth, height);
      }
      context.globalAlpha = 1;
    };

    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", resizeCanvas);
      smoothedLevels.fill(0);
      context.clearRect(0, 0, cssWidth, cssHeight);
    };
  }, [getAudioFrequencyData, nativeIsPlaying, shouldShow]);

  if (!shouldShow) return null;

  return (
    <div className={`music-wave-header ${simple ? "music-wave-header--simple" : ""}`} aria-hidden="true">
      <canvas ref={canvasRef} className="music-wave-header__canvas" />
    </div>
  );
}
