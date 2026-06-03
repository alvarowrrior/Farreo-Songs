"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  PlayIcon,
  PauseIcon,
  RotateCcwIcon,
  TrashIcon,
  Mic2Icon,
  PlusIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SearchIcon,
} from "lucide-react";
import { MUSIC_API_URL, getMediaUrl, type ApiSong } from "@/lib/radioApi";
import { buildSrt, parseSrt } from "@/lib/lyrics";

interface EditorCue {
  id: string;
  start: number;
  end: number;
  text: string;
}

const WAVEFORM_BUCKETS = 1600;
const MIN_CUE_LENGTH = 0.05;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const newId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `cue-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const formatLabel = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00.0";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const d = Math.floor((seconds - Math.floor(seconds)) * 10);
  return `${m}:${s < 10 ? "0" : ""}${s}.${d}`;
};

export default function LyricsEditor() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const durationRef = useRef(0);

  const [songs, setSongs] = useState<ApiSong[]>([]);
  const [loadingSongs, setLoadingSongs] = useState(false);
  const [songSearch, setSongSearch] = useState("");
  const [selectedSong, setSelectedSong] = useState<ApiSong | null>(null);

  const [cues, setCues] = useState<EditorCue[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [lyricsText, setLyricsText] = useState("");

  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [waveformError, setWaveformError] = useState(false);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [timelineWidth, setTimelineWidth] = useState(0);
  const [zoom, setZoom] = useState(1);

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Drag state lives in a ref so the global pointer listeners stay stable.
  const dragRef = useRef<
    | { index: number; mode: "move" | "left" | "right"; startX: number; origStart: number; origEnd: number }
    | null
  >(null);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  // ----- Load songs -----
  const loadSongs = useCallback(async () => {
    setLoadingSongs(true);
    try {
      const res = await fetch(`${MUSIC_API_URL}/canciones`);
      if (res.ok) {
        const data = (await res.json()) as ApiSong[];
        setSongs(Array.isArray(data) ? data : []);
      } else {
        setMessage({ type: "error", text: "No se pudieron cargar las canciones." });
      }
    } catch {
      setMessage({ type: "error", text: "No se pudo conectar con el servidor." });
    } finally {
      setLoadingSongs(false);
    }
  }, []);

  useEffect(() => {
    loadSongs();
  }, [loadSongs]);

  // ----- Waveform decode -----
  const decodeWaveform = useCallback(async (url: string) => {
    setPeaks(null);
    setWaveformError(false);
    setWaveformLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("fetch failed");
      const arrayBuffer = await res.arrayBuffer();
      const AudioCtx =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      const buffer = await ctx.decodeAudioData(arrayBuffer);
      const channel = buffer.getChannelData(0);
      const bucketSize = Math.max(1, Math.floor(channel.length / WAVEFORM_BUCKETS));
      const result: number[] = [];
      let globalMax = 0;
      for (let i = 0; i < WAVEFORM_BUCKETS; i += 1) {
        let max = 0;
        const startSample = i * bucketSize;
        for (let j = 0; j < bucketSize; j += 1) {
          const v = Math.abs(channel[startSample + j] || 0);
          if (v > max) max = v;
        }
        result.push(max);
        if (max > globalMax) globalMax = max;
      }
      const normalized = globalMax > 0 ? result.map((v) => v / globalMax) : result;
      setPeaks(normalized);
      void ctx.close();
    } catch {
      setWaveformError(true);
      setPeaks(null);
    } finally {
      setWaveformLoading(false);
    }
  }, []);

  // ----- Select a song -----
  const selectSong = useCallback(
    (song: ApiSong) => {
      setSelectedSong(song);
      setMessage(null);
      setIsPlaying(false);
      setCurrentTime(0);
      setActiveIndex(0);

      const existing = parseSrt(song.lyricsSrt).map<EditorCue>((cue) => ({
        id: newId(),
        start: cue.start,
        end: cue.end,
        text: cue.text,
      }));
      setCues(existing);
      setLyricsText(existing.map((cue) => cue.text).join("\n"));

      const src = getMediaUrl(song.url);
      const audio = audioRef.current;
      if (audio) {
        audio.src = src;
        audio.load();
      }
      void decodeWaveform(src);
    },
    [decodeWaveform],
  );

  // ----- Import a .srt/.vtt file (processed locally, never uploaded as-is) -----
  const importLyricsFile = async (file: File | null) => {
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".srt") && !lower.endsWith(".vtt")) {
      setMessage({ type: "error", text: "El archivo debe ser .srt o .vtt." });
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseSrt(text).map<EditorCue>((cue) => ({
        id: newId(),
        start: cue.start,
        end: cue.end,
        text: cue.text,
      }));
      if (parsed.length === 0) {
        setMessage({ type: "error", text: "No se encontraron líneas con tiempos en el archivo." });
        return;
      }
      setCues(parsed);
      setLyricsText(parsed.map((cue) => cue.text).join("\n"));
      setActiveIndex(0);
      setMessage({
        type: "success",
        text: `${parsed.length} nodos cargados desde ${file.name}. Revísalos y pulsa Guardar.`,
      });
    } catch {
      setMessage({ type: "error", text: "No se pudo leer el archivo." });
    }
  };

  // ----- Load lyric lines from the textarea -----
  const loadLinesFromText = () => {
    const lines = lyricsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    setCues(lines.map((text) => ({ id: newId(), start: 0, end: 0, text })));
    setActiveIndex(0);
    setMessage({ type: "success", text: `${lines.length} líneas cargadas. Marca los tiempos.` });
  };

  // ----- Playback controls -----
  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  };

  const seekBy = (delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = clamp(audio.currentTime + delta, 0, durationRef.current || audio.duration || 0);
    setCurrentTime(audio.currentTime);
  };

  const seekTo = (time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = clamp(time, 0, durationRef.current || 0);
    setCurrentTime(audio.currentTime);
  };

  // keep refs so the stable markCue/keyboard handlers read latest values
  const activeIndexRef = useRef(activeIndex);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);
  const cuesLengthRef = useRef(cues.length);
  useEffect(() => {
    cuesLengthRef.current = cues.length;
  }, [cues.length]);

  // ----- Tap-to-sync -----
  // Space marks the start of the current line (and closes the previous one).
  // After the last line is started, one more Space closes its end too.
  const markCue = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = audio.currentTime;
    const idx = activeIndexRef.current;
    const len = cuesLengthRef.current;
    if (len === 0) return;

    // Past the last line: this Space closes the final line's end.
    if (idx >= len) {
      setCues((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const last = next[prev.length - 1];
        next[prev.length - 1] = { ...last, end: Math.max(last.start + MIN_CUE_LENGTH, t) };
        return next;
      });
      return;
    }

    setCues((prev) => {
      if (idx >= prev.length) return prev;
      const next = [...prev];
      if (idx > 0) {
        const prevCue = next[idx - 1];
        next[idx - 1] = { ...prevCue, end: Math.max(prevCue.start + MIN_CUE_LENGTH, t) };
      }
      next[idx] = { ...next[idx], start: t, end: Math.max(t + MIN_CUE_LENGTH, next[idx].end) };
      return next;
    });
    setActiveIndex(Math.min(idx + 1, len));
  }, []);

  const markEnd = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = audio.currentTime;
    const lastStarted = Math.min(activeIndex, cues.length) - 1;
    if (lastStarted < 0) return;
    setCues((prev) => {
      const next = [...prev];
      const cue = next[lastStarted];
      if (!cue) return prev;
      next[lastStarted] = { ...cue, end: Math.max(cue.start + MIN_CUE_LENGTH, t) };
      return next;
    });
  };

  const stepBack = () => setActiveIndex((idx) => Math.max(0, idx - 1));

  // Drop an empty, timed node at the playhead (works with zero cues and while
  // playing). Chains the previously started node's end to this node's start,
  // so you can tap markers first and fill the text afterwards.
  const addNodeAtPlayhead = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = audio.currentTime;
    const total = durationRef.current || t + MIN_CUE_LENGTH;
    setCues((prev) => {
      const next = [...prev];
      let lastIdx = -1;
      let lastStart = -Infinity;
      for (let i = 0; i < next.length; i += 1) {
        if (next[i].start <= t && next[i].start > lastStart) {
          lastStart = next[i].start;
          lastIdx = i;
        }
      }
      if (lastIdx >= 0 && t > next[lastIdx].start) {
        const prevCue = next[lastIdx];
        next[lastIdx] = { ...prevCue, end: clamp(t, prevCue.start + MIN_CUE_LENGTH, total) };
      }
      next.push({ id: newId(), start: t, end: Math.min(total, t + MIN_CUE_LENGTH), text: "" });
      return next;
    });
  }, []);

  // ----- Cue list editing -----
  const updateCueText = (id: string, text: string) =>
    setCues((prev) => prev.map((cue) => (cue.id === id ? { ...cue, text } : cue)));

  const updateCueTime = (id: string, field: "start" | "end", value: number) =>
    setCues((prev) =>
      prev.map((cue) => {
        if (cue.id !== id) return cue;
        const total = durationRef.current || Infinity;
        if (Number.isNaN(value)) return cue;
        if (field === "start") {
          return { ...cue, start: clamp(value, 0, Math.min(total, cue.end - MIN_CUE_LENGTH)) };
        }
        return { ...cue, end: clamp(value, cue.start + MIN_CUE_LENGTH, total) };
      }),
    );

  const deleteCue = (id: string) =>
    setCues((prev) => prev.filter((cue) => cue.id !== id));

  // Insert a node at the current playhead. Display/export sort by start time,
  // so it lands in the right chronological position automatically.
  const addCue = () => {
    const audio = audioRef.current;
    const t = audio ? audio.currentTime : 0;
    const total = durationRef.current || t + 2;
    setCues((prev) => [
      ...prev,
      { id: newId(), start: t, end: Math.min(total, t + 2), text: "Nueva línea" },
    ]);
  };

  // ----- Keyboard shortcuts -----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (!selectedSong) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "KeyM") {
        e.preventDefault();
        markCue();
      } else if (e.code === "KeyN") {
        e.preventDefault();
        addNodeAtPlayhead();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        seekBy(-2);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        seekBy(2);
      } else if (e.code === "Backspace") {
        e.preventDefault();
        stepBack();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSong, cues, activeIndex]);

  // ----- Timeline drag (stable global listeners) -----
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      const container = timelineRef.current;
      const total = durationRef.current;
      if (!drag || !container || total <= 0) return;
      const width = container.clientWidth || 1;
      const dt = ((e.clientX - drag.startX) / width) * total;
      setCues((prev) => {
        if (drag.index < 0 || drag.index >= prev.length) return prev;
        const next = [...prev];
        const cur = { ...next[drag.index] };
        // Free movement within [0, duration] — no neighbour clamping, so a cue
        // can be dragged past others to reorder it by time.
        if (drag.mode === "move") {
          const len = drag.origEnd - drag.origStart;
          const start = clamp(drag.origStart + dt, 0, Math.max(0, total - len));
          cur.start = start;
          cur.end = start + len;
        } else if (drag.mode === "left") {
          cur.start = clamp(drag.origStart + dt, 0, cur.end - MIN_CUE_LENGTH);
        } else {
          cur.end = clamp(drag.origEnd + dt, cur.start + MIN_CUE_LENGTH, total);
        }
        next[drag.index] = cur;
        return next;
      });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const startDrag = (
    e: React.PointerEvent,
    index: number,
    mode: "move" | "left" | "right",
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const cue = cues[index];
    if (!cue) return;
    dragRef.current = {
      index,
      mode,
      startX: e.clientX,
      origStart: cue.start,
      origEnd: cue.end,
    };
  };

  const onTimelineSeek = (e: React.PointerEvent) => {
    const container = timelineRef.current;
    if (!container || duration <= 0) return;
    const rect = container.getBoundingClientRect();
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    seekTo(ratio * duration);
  };

  // ----- Canvas sizing -----
  useEffect(() => {
    const container = timelineRef.current;
    if (!container) return;
    const update = () => setTimelineWidth(container.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [selectedSong]);

  // ----- Canvas draw -----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = timelineWidth || canvas.clientWidth || 600;
    const cssHeight = 120;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const mid = cssHeight / 2;
    if (peaks && peaks.length > 0) {
      const barWidth = cssWidth / peaks.length;
      ctx.fillStyle = "#1db954";
      for (let i = 0; i < peaks.length; i += 1) {
        const x = i * barWidth;
        const barHeight = Math.max(1, peaks[i] * (cssHeight * 0.9));
        ctx.fillRect(x, mid - barHeight / 2, Math.max(1, barWidth), barHeight);
      }
    } else {
      ctx.fillStyle = "#444";
      ctx.fillRect(0, mid - 1, cssWidth, 2);
    }
  }, [peaks, timelineWidth]);

  // ----- Playhead animation -----
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const audio = audioRef.current;
      const head = playheadRef.current;
      const total = durationRef.current;
      if (audio && head && total > 0) {
        head.style.left = `${clamp((audio.currentTime / total) * 100, 0, 100)}%`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ----- Save -----
  const saveLyrics = async (removeLyrics = false) => {
    if (!selectedSong) return;
    setSaving(true);
    setMessage(null);
    try {
      const srt = buildSrt(cues);
      const formData = new FormData();
      if (!removeLyrics) {
        const file = new File([srt], `${selectedSong.name || selectedSong.id}.srt`, {
          type: "application/x-subrip",
        });
        formData.append("lyrics", file);
      }
      formData.append(
        "metadata",
        JSON.stringify({
          nombre: selectedSong.name,
          variantes: selectedSong.variantes ?? [],
          removeLyrics,
        }),
      );
      const res = await fetch(`${MUSIC_API_URL}/cancion/${selectedSong.id}`, {
        method: "PUT",
        body: formData,
      });
      if (res.ok) {
        const updatedSrt = removeLyrics ? null : srt;
        setSelectedSong((prev) => (prev ? { ...prev, lyricsSrt: updatedSrt } : prev));
        setSongs((prev) =>
          prev.map((s) => (s.id === selectedSong.id ? { ...s, lyricsSrt: updatedSrt } : s)),
        );
        if (removeLyrics) {
          setCues([]);
          setLyricsText("");
        }
        setMessage({ type: "success", text: removeLyrics ? "Lyrics eliminadas." : "Lyrics guardadas." });
      } else {
        const err = await res.json().catch(() => ({}));
        setMessage({ type: "error", text: err.error || "Error guardando las lyrics." });
      }
    } catch {
      setMessage({ type: "error", text: "No se pudo conectar con el servidor." });
    } finally {
      setSaving(false);
    }
  };

  const activeCueId = cues[activeIndex]?.id ?? null;
  const sortedCues = [...cues].sort((a, b) => a.start - b.start);

  // Real-time karaoke preview based on the current playhead time.
  const previewActive = sortedCues.find((c) => currentTime >= c.start && currentTime <= c.end) ?? null;
  const previewNext = sortedCues.find((c) => c.start > currentTime) ?? null;
  const previewPassed = sortedCues.filter((c) => c.end < currentTime);
  const previewPrev = previewPassed.length ? previewPassed[previewPassed.length - 1] : null;

  const filteredSongs = songs.filter((song) => {
    if (!songSearch.trim()) return true;
    const q = songSearch.toLowerCase();
    return (
      song.name.toLowerCase().includes(q) ||
      (song.variantes && song.variantes.some((v) => v.toLowerCase().includes(q)))
    );
  });

  return (
    <div className="lyrics-editor">
      <div className="lyrics-editor__topbar">
        <Link href="/admin" className="lyrics-editor__back">
          <ArrowLeftIcon size={16} /> Volver a admin
        </Link>
        <h1 className="lyrics-editor__title">Editor de Lyrics</h1>
        {selectedSong && (
          <button className="lyrics-editor__back" onClick={() => setSelectedSong(null)}>
            Cambiar canción
          </button>
        )}
      </div>

      {message && (
        <div className={`lyrics-editor__message lyrics-editor__message--${message.type}`}>
          {message.text}
        </div>
      )}

      {!selectedSong ? (
        <div className="lyrics-editor__picker">
          <div className="lyrics-editor__search">
            <SearchIcon size={16} />
            <input
              value={songSearch}
              onChange={(e) => setSongSearch(e.target.value)}
              placeholder="Buscar canción..."
            />
          </div>
          {loadingSongs ? (
            <p className="lyrics-editor__hint">Cargando canciones...</p>
          ) : (
            <ul className="lyrics-editor__song-list">
              {filteredSongs.map((song) => (
                <li key={song.id}>
                  <button className="lyrics-editor__song" onClick={() => selectSong(song)}>
                    <span className="lyrics-editor__song-name">{song.name}</span>
                    <span
                      className={`lyrics-editor__song-badge ${song.lyricsSrt ? "lyrics-editor__song-badge--has" : ""}`}
                    >
                      {song.lyricsSrt ? "Con lyrics" : "Sin lyrics"}
                    </span>
                  </button>
                </li>
              ))}
              {filteredSongs.length === 0 && (
                <p className="lyrics-editor__hint">No hay canciones que coincidan.</p>
              )}
            </ul>
          )}
        </div>
      ) : (
        <div className="lyrics-editor__workspace">
          <div className="lyrics-editor__now">
            <strong>{selectedSong.name}</strong>
            <span>
              {formatLabel(currentTime)} / {formatLabel(duration)}
            </span>
          </div>

          <div className="lyrics-editor__transport">
            <button onClick={() => seekBy(-2)} title="Atrás 2s (←)">
              <SkipBackIcon size={16} />
            </button>
            <button className="lyrics-editor__play" onClick={togglePlay} title="Reproducir/Pausar (Espacio)">
              {isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
            </button>
            <button onClick={() => seekBy(2)} title="Adelante 2s (→)">
              <SkipForwardIcon size={16} />
            </button>
            <button className="lyrics-editor__mark" onClick={markCue} title="Marcar inicio de línea / cerrar la última (M)">
              <Mic2Icon size={16} /> Marcar
            </button>
            <button className="lyrics-editor__mark" onClick={addNodeAtPlayhead} title="Crear un nodo vacío aquí (N)">
              <PlusIcon size={16} /> Nodo aquí
            </button>
            <button onClick={markEnd} title="Cerrar el fin de la última línea iniciada">
              Cerrar última
            </button>
            <button onClick={stepBack} title="Retroceder un nodo (Retroceso)">
              <RotateCcwIcon size={16} /> Atrás
            </button>
          </div>

          <p className="lyrics-editor__shortcuts">
            <strong>Atajos:</strong> Espacio = play/pausa · M = marcar línea pegada (y un toque más cierra la última) ·
            N = crear nodo vacío aquí · ←/→ = ±2s · Retroceso = un nodo atrás
          </p>

          <div className="lyrics-editor__preview">
            <span className="lyrics-editor__preview-label">Previsualización</span>
            <span className="lyrics-editor__preview-line lyrics-editor__preview-line--prev">
              {previewPrev?.text ?? ""}
            </span>
            <span className="lyrics-editor__preview-line lyrics-editor__preview-line--current">
              {previewActive ? previewActive.text : "♫"}
            </span>
            <span className="lyrics-editor__preview-line lyrics-editor__preview-line--next">
              {previewNext?.text ?? ""}
            </span>
          </div>

          <div className="lyrics-editor__zoom">
            <span>Zoom</span>
            <input
              type="range"
              min={1}
              max={12}
              step={0.5}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
            <span>{zoom.toFixed(1)}x</span>
          </div>

          <div className="lyrics-editor__timeline-scroll">
            <div
              className="lyrics-editor__timeline"
              ref={timelineRef}
              style={{ width: `${zoom * 100}%` }}
              onPointerDown={onTimelineSeek}
            >
              <canvas ref={canvasRef} className="lyrics-editor__canvas" />
              <div className="lyrics-editor__cues-layer">
                {duration > 0 &&
                  cues.map((cue, index) => {
                    if (cue.end <= cue.start) return null;
                    const left = (cue.start / duration) * 100;
                    const width = ((cue.end - cue.start) / duration) * 100;
                    return (
                      <div
                        key={cue.id}
                        className={`lyrics-editor__cue ${cue.id === activeCueId ? "lyrics-editor__cue--active" : ""}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        onPointerDown={(e) => startDrag(e, index, "move")}
                        title={cue.text}
                      >
                        <span
                          className="lyrics-editor__cue-handle lyrics-editor__cue-handle--left"
                          onPointerDown={(e) => startDrag(e, index, "left")}
                        />
                        <span className="lyrics-editor__cue-label">{cue.text}</span>
                        <span
                          className="lyrics-editor__cue-handle lyrics-editor__cue-handle--right"
                          onPointerDown={(e) => startDrag(e, index, "right")}
                        />
                      </div>
                    );
                  })}
              </div>
              <div ref={playheadRef} className="lyrics-editor__playhead" />
            </div>
          </div>

          {waveformLoading && <p className="lyrics-editor__hint">Generando forma de onda...</p>}
          {waveformError && (
            <p className="lyrics-editor__hint lyrics-editor__hint--warn">
              Forma de onda no disponible (probablemente CORS del servidor de audio). Puedes sincronizar igual con la
              barra de tiempo.
            </p>
          )}

          <div className="lyrics-editor__columns">
            <div className="lyrics-editor__bulk">
              <label>Pegar letra (una línea por nodo)</label>
              <textarea
                value={lyricsText}
                onChange={(e) => setLyricsText(e.target.value)}
                rows={10}
                placeholder={"Primera línea\nSegunda línea\n..."}
              />
              <button className="lyrics-editor__secondary" onClick={loadLinesFromText}>
                Cargar líneas (reinicia tiempos)
              </button>
              <div className="lyrics-editor__import">
                <label className="lyrics-editor__secondary lyrics-editor__import-btn">
                  Importar SRT/VTT
                  <input
                    type="file"
                    accept=".srt,.vtt,application/x-subrip,text/vtt,text/plain"
                    onChange={(e) => {
                      void importLyricsFile(e.target.files?.[0] ?? null);
                      e.target.value = "";
                    }}
                    hidden
                  />
                </label>
                <span className="lyrics-editor__hint">
                  Carga tiempos y nodos de un archivo. No se guarda hasta pulsar &quot;Guardar&quot;.
                </span>
              </div>
            </div>

            <div className="lyrics-editor__cue-list">
              <div className="lyrics-editor__cue-list-head">
                <span>Nodos ({cues.length})</span>
                <button className="lyrics-editor__secondary" onClick={addCue}>
                  + Añadir
                </button>
              </div>
              <ul>
                {sortedCues.map((cue) => (
                  <li
                    key={cue.id}
                    className={cue.id === activeCueId ? "lyrics-editor__row--active" : ""}
                  >
                    <button
                      className="lyrics-editor__row-jump"
                      onClick={() => {
                        seekTo(cue.start);
                        setActiveIndex(cues.findIndex((c) => c.id === cue.id));
                      }}
                      title="Saltar a este nodo"
                    >
                      <PlayIcon size={12} />
                    </button>
                    <div className="lyrics-editor__row-times">
                      <input
                        type="number"
                        step={0.1}
                        min={0}
                        value={Number(cue.start.toFixed(2))}
                        onChange={(e) => updateCueTime(cue.id, "start", parseFloat(e.target.value))}
                        title="Inicio (segundos)"
                      />
                      <input
                        type="number"
                        step={0.1}
                        min={0}
                        value={Number(cue.end.toFixed(2))}
                        onChange={(e) => updateCueTime(cue.id, "end", parseFloat(e.target.value))}
                        title="Fin (segundos)"
                      />
                    </div>
                    <input
                      className="lyrics-editor__row-text"
                      value={cue.text}
                      placeholder="(escribe la letra)"
                      onChange={(e) => updateCueText(cue.id, e.target.value)}
                    />
                    <button
                      className="lyrics-editor__row-del"
                      onClick={() => deleteCue(cue.id)}
                      title="Eliminar nodo"
                    >
                      <TrashIcon size={14} />
                    </button>
                  </li>
                ))}
                {cues.length === 0 && (
                  <p className="lyrics-editor__hint">Pega la letra y pulsa &quot;Cargar líneas&quot;.</p>
                )}
              </ul>
            </div>
          </div>

          <div className="lyrics-editor__actions">
            <button
              className="lyrics-editor__save"
              onClick={() => saveLyrics(false)}
              disabled={saving || cues.length === 0}
            >
              {saving ? "Guardando..." : "Guardar lyrics"}
            </button>
            {selectedSong.lyricsSrt && (
              <button
                className="lyrics-editor__danger"
                onClick={() => saveLyrics(true)}
                disabled={saving}
              >
                Quitar lyrics
              </button>
            )}
          </div>
        </div>
      )}

      <audio
        ref={audioRef}
        onLoadedMetadata={() => {
          const audio = audioRef.current;
          if (audio) setDuration(audio.duration || 0);
        }}
        onTimeUpdate={() => {
          const audio = audioRef.current;
          if (audio) setCurrentTime(audio.currentTime);
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        style={{ display: "none" }}
      />
    </div>
  );
}
