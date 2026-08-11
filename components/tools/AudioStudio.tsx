"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadIcon, RotateCcwIcon, SquareIcon, PlayIcon, UploadIcon } from "lucide-react";
import {
  DEFAULT_PARAMS,
  applyParams,
  createPreview,
  renderOffline,
  updateReverb,
  PitchShifter,
  type GraphRefs,
  type StudioParams,
} from "@/lib/tools/studioEngine";
import { audioBufferToMp3, downloadBlob } from "@/lib/tools/mp3";
import { useMusicPlayer } from "@/components/MusicPlayerProvider";

type SliderDef = {
  key: keyof StudioParams;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
};

const GROUPS: { title: string; sliders: SliderDef[] }[] = [
  {
    title: "Tono y musicalidad",
    sliders: [
      { key: "semitones", label: "Tono (clave)", min: -12, max: 12, step: 1, unit: "st" },
      { key: "cents", label: "Afinación fina", min: -100, max: 100, step: 1, unit: "¢" },
      { key: "tempo", label: "Tempo", min: 50, max: 150, step: 1, unit: "%" },
    ],
  },
  {
    title: "Modulación",
    sliders: [
      { key: "vibratoDepth", label: "Vibrato (prof.)", min: 0, max: 100, step: 1, unit: "%" },
      { key: "vibratoRate", label: "Vibrato (vel.)", min: 0.1, max: 12, step: 0.1, unit: "Hz" },
      { key: "tremoloDepth", label: "Trémolo (prof.)", min: 0, max: 100, step: 1, unit: "%" },
      { key: "tremoloRate", label: "Trémolo (vel.)", min: 0.1, max: 20, step: 0.1, unit: "Hz" },
    ],
  },
  {
    title: "Ecualización",
    sliders: [
      { key: "eqLow", label: "Graves", min: -15, max: 15, step: 0.5, unit: "dB" },
      { key: "eqMid", label: "Medios", min: -15, max: 15, step: 0.5, unit: "dB" },
      { key: "eqHigh", label: "Agudos", min: -15, max: 15, step: 0.5, unit: "dB" },
    ],
  },
  {
    title: "Carácter y espacio",
    sliders: [
      { key: "drive", label: "Saturación", min: 0, max: 100, step: 1, unit: "%" },
      { key: "chorusDepth", label: "Chorus (prof.)", min: 0, max: 100, step: 1, unit: "%" },
      { key: "chorusRate", label: "Chorus (vel.)", min: 0.1, max: 6, step: 0.1, unit: "Hz" },
      { key: "delayTime", label: "Delay (tiempo)", min: 0, max: 1000, step: 10, unit: "ms" },
      { key: "delayFeedback", label: "Delay (realim.)", min: 0, max: 90, step: 1, unit: "%" },
      { key: "delayMix", label: "Delay (mezcla)", min: 0, max: 100, step: 1, unit: "%" },
      { key: "reverbSize", label: "Reverb (tamaño)", min: 0, max: 100, step: 1, unit: "%" },
      { key: "reverbMix", label: "Reverb (mezcla)", min: 0, max: 100, step: 1, unit: "%" },
      { key: "stereoWidth", label: "Anchura estéreo", min: 0, max: 200, step: 1, unit: "%" },
      { key: "gain", label: "Volumen salida", min: -12, max: 12, step: 0.5, unit: "dB" },
    ],
  },
];

export default function AudioStudio() {
  const { isPlaying: farreoIsPlaying, togglePlayPause } = useMusicPlayer();

  const [params, setParams] = useState<StudioParams>(DEFAULT_PARAMS);
  const [fileName, setFileName] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [ready, setReady] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const decodedRef = useRef<AudioBuffer | null>(null);
  const reversedRef = useRef<AudioBuffer | null>(null);
  const shifterRef = useRef<InstanceType<typeof PitchShifter> | null>(null);
  const refsRef = useRef<GraphRefs | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const stopPreview = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    try {
      shifterRef.current?.disconnect();
    } catch {}
    shifterRef.current = null;
    refsRef.current = null;
    analyserRef.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => () => stopPreview(), [stopPreview]);

  // El canvas se dibuja en píxeles reales: lo ajustamos al ancho del contenedor.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const width = Math.max(320, Math.floor(canvas.clientWidth));
      if (canvas.width !== width) canvas.width = width;
      if (!playing && decodedRef.current) drawWaveform(decodedRef.current);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [playing]);

  function getReversed(buffer: AudioBuffer, ctx: AudioContext): AudioBuffer {
    if (reversedRef.current) return reversedRef.current;
    const rev = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const out = rev.getChannelData(c);
      const src = buffer.getChannelData(c);
      for (let i = 0, n = src.length; i < n; i++) out[i] = src[n - 1 - i];
    }
    reversedRef.current = rev;
    return rev;
  }

  async function handleFile(file: File) {
    setError(null);
    setStatus("Decodificando audio…");
    stopPreview();
    decodedRef.current = null;
    reversedRef.current = null;
    setReady(false);
    try {
      if (!ctxRef.current) {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctxRef.current = new Ctx();
      }
      const arr = await file.arrayBuffer();
      const decoded = await ctxRef.current.decodeAudioData(arr);
      decodedRef.current = decoded;
      setFileName(file.name);
      setReady(true);
      setStatus(`Listo · ${decoded.duration.toFixed(1)} s · ${decoded.sampleRate} Hz`);
      drawWaveform(decoded);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo decodificar el archivo");
      setStatus(null);
    }
  }

  function drawWaveform(buffer: AudioBuffer) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const data = buffer.getChannelData(0);
    const step = Math.ceil(data.length / w);
    ctx.fillStyle = "rgba(245, 158, 11, 0.55)";
    for (let x = 0; x < w; x++) {
      let min = 1;
      let max = -1;
      for (let i = 0; i < step; i++) {
        const v = data[x * step + i] || 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = ((1 + min) / 2) * h;
      const y2 = ((1 + max) / 2) * h;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }

  function drawAnalyser() {
    const analyser = analyserRef.current;
    const canvas = canvasRef.current;
    if (!analyser || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const bins = analyser.frequencyBinCount;
    const arr = new Uint8Array(bins);

    const render = () => {
      const w = canvas.width;
      const h = canvas.height;
      analyser.getByteFrequencyData(arr);
      ctx.clearRect(0, 0, w, h);
      const bars = 64;
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const v = arr[Math.floor((i / bars) * bins)] / 255;
        const bh = v * h;
        ctx.fillStyle = `rgba(245, ${158 + v * 60}, ${11 + v * 90}, 0.9)`;
        ctx.fillRect(i * bw, h - bh, bw - 1, bh);
      }
      rafRef.current = requestAnimationFrame(render);
    };
    render();
  }

  async function startPreview(original = false) {
    const ctx = ctxRef.current;
    const decoded = decodedRef.current;
    if (!ctx || !decoded) return;
    // Evita que suene a la vez que el reproductor de Farreo.
    if (farreoIsPlaying) togglePlayPause();
    stopPreview();
    await ctx.resume();

    const buffer = !original && params.reverse ? getReversed(decoded, ctx) : decoded;

    if (original) {
      // Reproducción sin procesar para comparar A/B.
      const shifter = new PitchShifter(ctx, decoded, 4096);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      shifter.connect(analyser);
      analyser.connect(ctx.destination);
      shifter.on("end", () => stopPreview());
      shifterRef.current = shifter;
      analyserRef.current = analyser;
    } else {
      const { shifter, refs, analyser } = createPreview(ctx, buffer, params);
      shifter.on("end", () => stopPreview());
      shifterRef.current = shifter;
      refsRef.current = refs;
      analyserRef.current = analyser;
    }
    setPlaying(true);
    drawAnalyser();
  }

  function update<K extends keyof StudioParams>(key: K, value: StudioParams[K]) {
    setParams((prev) => {
      const next = { ...prev, [key]: value };
      const ctx = ctxRef.current;
      const refs = refsRef.current;
      if (refs && ctx) {
        applyParams(refs, next);
        if (key === "reverbSize") updateReverb(ctx, refs, next.reverbSize);
        if (key === "tempo" && shifterRef.current) shifterRef.current.tempo = next.tempo / 100;
        if ((key === "semitones" || key === "cents") && shifterRef.current) {
          shifterRef.current.pitchSemitones = next.semitones + next.cents / 100;
        }
      }
      return next;
    });
  }

  function toggleReverse() {
    const wasPlaying = playing && refsRef.current !== null;
    setParams((prev) => ({ ...prev, reverse: !prev.reverse }));
    if (wasPlaying) {
      // reinicia con el buffer (des)invertido
      setTimeout(() => void startPreview(false), 0);
    }
  }

  function resetParams() {
    setParams(DEFAULT_PARAMS);
    const ctx = ctxRef.current;
    const refs = refsRef.current;
    if (refs && ctx) {
      applyParams(refs, DEFAULT_PARAMS);
      updateReverb(ctx, refs, DEFAULT_PARAMS.reverbSize);
      if (shifterRef.current) {
        shifterRef.current.tempo = DEFAULT_PARAMS.tempo / 100;
        shifterRef.current.pitchSemitones = DEFAULT_PARAMS.semitones;
      }
    }
  }

  async function handleExport() {
    const decoded = decodedRef.current;
    if (!decoded) return;
    setExporting(true);
    setError(null);
    setStatus("Renderizando y codificando MP3…");
    try {
      // Cedemos un tick para que se pinte el estado antes del trabajo pesado.
      await new Promise((r) => setTimeout(r, 30));
      const rendered = await renderOffline(decoded, paramsRef.current);
      const blob = audioBufferToMp3(rendered, 192);
      const base = (fileName || "remix").replace(/\.[^.]+$/, "");
      downloadBlob(blob, `${base}-remix.mp3`);
      setStatus("MP3 exportado");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al exportar");
      setStatus(null);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="tools-studio">
      <label className="tools-file">
        <input
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        <UploadIcon size={20} />
        {fileName ? (
          <span className="tools-file__name">{fileName}</span>
        ) : (
          <>
            <span className="tools-file__name">Selecciona un archivo de audio</span>
            <span className="tools-file__hint">MP3, WAV, M4A, OGG, FLAC</span>
          </>
        )}
      </label>

      <canvas ref={canvasRef} height={96} className="tools-studio__viz" />

      <div className="tools-studio__transport">
        <button
          type="button"
          className="tools-btn"
          onClick={() => (playing ? stopPreview() : void startPreview(false))}
          disabled={!ready}
        >
          {playing ? <SquareIcon size={15} /> : <PlayIcon size={15} />}
          {playing ? "Detener" : "Previsualizar"}
        </button>
        <button
          type="button"
          className="tools-btn tools-btn--ghost"
          onClick={() => void startPreview(true)}
          disabled={!ready}
        >
          <PlayIcon size={15} />
          Original (A/B)
        </button>
        <button
          type="button"
          className="tools-btn tools-btn--ghost"
          onClick={resetParams}
          disabled={!ready}
        >
          <RotateCcwIcon size={15} />
          Preset
        </button>
      </div>

      <div className="tools-studio__groups">
        {GROUPS.map((group) => (
          <fieldset className="tools-studio__group" key={group.title}>
            <legend>{group.title}</legend>
            {group.title === "Tono y musicalidad" && (
              <label className="tools-studio__toggle">
                <input type="checkbox" checked={params.reverse} onChange={toggleReverse} />
                <span>Reproducir al revés</span>
              </label>
            )}
            {group.sliders.map((s) => (
              <div className="tools-studio__slider" key={s.key}>
                <label htmlFor={`studio-${s.key}`}>{s.label}</label>
                <input
                  id={`studio-${s.key}`}
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={params[s.key] as number}
                  onChange={(e) => update(s.key, Number(e.target.value) as never)}
                />
                <input
                  className="tools-studio__num"
                  type="number"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={params[s.key] as number}
                  onChange={(e) => update(s.key, Number(e.target.value) as never)}
                />
                <span className="tools-studio__unit">{s.unit}</span>
              </div>
            ))}
          </fieldset>
        ))}
      </div>

      <button
        type="button"
        className="tools-btn tools-btn--primary tools-btn--block"
        onClick={() => void handleExport()}
        disabled={!ready || exporting}
      >
        <DownloadIcon size={16} />
        {exporting ? "Exportando…" : "Exportar MP3"}
      </button>

      {status && <p className="tools-status">{status}</p>}
      {error && <div className="tools-error">{error}</div>}
      <p className="tools-hint">
        Transforma audio del que tengas derechos (creación propia, pistas con licencia o libres de
        regalías). Todo el procesado ocurre en tu navegador.
      </p>
    </div>
  );
}
