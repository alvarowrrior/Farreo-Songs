"use client";

import { useEffect, useMemo, useRef } from "react";
import { useMusicPlayer } from "@/components/MusicPlayerProvider";

const BAR_COUNT = 420;

const sampleFrequencyData = (data: Uint8Array<ArrayBuffer>, index: number) => {
  const position = index / Math.max(1, BAR_COUNT - 1);
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
  const bars = useMemo(() => Array.from({ length: BAR_COUNT }, (_, index) => index), []);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const smoothedLevelsRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));
  const writtenHeightsRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));
  const writtenOpacitiesRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));
  const lastFrameAtRef = useRef(0);

  useEffect(() => {
    if (!currentTrack || !isPlaying) return undefined;

    const nodes = Array.from(containerRef.current?.children ?? []) as HTMLElement[];
    if (nodes.length === 0) return undefined;
    const smoothedLevels = smoothedLevelsRef.current;
    const writtenHeights = writtenHeightsRef.current;
    const writtenOpacities = writtenOpacitiesRef.current;

    const tick = (now: number) => {
      rafRef.current = window.requestAnimationFrame(tick);

      // ~30fps es de sobra para una onda ya suavizada (la transition CSS de
      // 45ms interpola entre actualizaciones); a 60fps las 840 escrituras de
      // estilo por frame + layout de 420 barras saturaban el hilo principal.
      if (now - lastFrameAtRef.current < 28) return;
      lastFrameAtRef.current = now;

      const data = getAudioFrequencyData();
      if (!data) return;

      for (let index = 0; index < nodes.length; index += 1) {
        const rawLevel = sampleFrequencyData(data, index);
        const previousLevel = smoothedLevels[index] ?? 0;
        const level = (previousLevel * 0.58) + (rawLevel * 0.42);
        smoothedLevels[index] = level;

        const height = Math.max(4, Math.pow(level, 0.72) * 100);
        const opacity = Math.min(1, 0.14 + (level * 1.15));

        // Saltar escrituras imperceptibles: la mayoria de barras apenas varian
        // entre frames y cada escritura invalida estilo/layout de la barra.
        if (
          Math.abs(height - writtenHeights[index]) < 0.6 &&
          Math.abs(opacity - writtenOpacities[index]) < 0.015
        ) {
          continue;
        }
        writtenHeights[index] = height;
        writtenOpacities[index] = opacity;
        nodes[index].style.setProperty("--wave-height", `${height.toFixed(1)}%`);
        nodes[index].style.setProperty("--wave-opacity", `${opacity.toFixed(3)}`);
      }
    };

    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      smoothedLevels.fill(0);
      writtenHeights.fill(0);
      writtenOpacities.fill(0);
      nodes.forEach((node) => {
        node.style.removeProperty("--wave-height");
        node.style.removeProperty("--wave-opacity");
      });
    };
  }, [currentTrack, getAudioFrequencyData, isPlaying]);

  if (!currentTrack || !isPlaying) return null;

  return (
    <div className={`music-wave-header ${simple ? "music-wave-header--simple" : ""}`} aria-hidden="true">
      <div ref={containerRef} className="music-wave-header__bars">
        {bars.map((index) => (
          <span key={index} className="music-wave-header__bar" />
        ))}
      </div>
    </div>
  );
}
