// Motor de audio del estudio, solo navegador.
// La previsualización en tiempo real usa el PitchShifter de soundtouchjs
// alimentando un grafo de efectos de Web Audio; la exportación reejecuta el
// mismo grafo en un OfflineAudioContext.
import { PitchShifter, SoundTouch, SimpleFilter, WebAudioBufferSource } from "soundtouchjs";

export interface StudioParams {
  // Tono y musicalidad
  semitones: number; // -12..12
  cents: number; // -100..100
  tempo: number; // 50..150 (%)
  reverse: boolean;
  // Modulación
  vibratoRate: number; // 0.1..12 Hz
  vibratoDepth: number; // 0..100
  tremoloRate: number; // 0.1..20 Hz
  tremoloDepth: number; // 0..100
  // EQ (dB)
  eqLow: number; // -15..15
  eqMid: number; // -15..15
  eqHigh: number; // -15..15
  // Carácter
  drive: number; // 0..100
  chorusRate: number; // 0.1..6 Hz
  chorusDepth: number; // 0..100
  delayTime: number; // 0..1000 ms
  delayFeedback: number; // 0..90 (%)
  delayMix: number; // 0..100
  reverbSize: number; // 0..100
  reverbMix: number; // 0..100
  stereoWidth: number; // 0..200 (%)
  gain: number; // -12..12 dB de trim de salida
}

// Preset por defecto: transforma la pista de forma audible sin perder calidad.
// Algo más grave y lento, cálido, ancho, con algo de sala y chorus.
export const DEFAULT_PARAMS: StudioParams = {
  semitones: -2,
  cents: 0,
  tempo: 95,
  reverse: false,
  vibratoRate: 5,
  vibratoDepth: 0,
  tremoloRate: 5,
  tremoloDepth: 0,
  eqLow: 2,
  eqMid: -1,
  eqHigh: 1.5,
  drive: 10,
  chorusRate: 1.2,
  chorusDepth: 15,
  delayTime: 0,
  delayFeedback: 30,
  delayMix: 0,
  reverbSize: 30,
  reverbMix: 12,
  stereoWidth: 120,
  gain: 0,
};

const dbToGain = (db: number) => Math.pow(10, db / 20);

/** Referencias a los nodos del grafo que se pueden actualizar en vivo. */
export interface GraphRefs {
  input: GainNode;
  output: GainNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  saturation: WaveShaperNode;
  vibratoDelay: DelayNode;
  vibratoLfo: OscillatorNode;
  vibratoDepth: GainNode;
  tremoloGain: GainNode;
  tremoloLfo: OscillatorNode;
  tremoloDepth: GainNode;
  widthSide: GainNode;
  chorusDelay: DelayNode;
  chorusLfo: OscillatorNode;
  chorusDepth: GainNode;
  chorusWet: GainNode;
  delay: DelayNode;
  delayFeedback: GainNode;
  delayWet: GainNode;
  reverbWet: GainNode;
  convolver: ConvolverNode;
}

function makeSaturationCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  if (amount <= 0) {
    for (let i = 0; i < n; i++) curve[i] = (i * 2) / n - 1; // lineal (limpio)
    return curve;
  }
  const k = amount / 8;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(x * k) / norm;
  }
  return curve;
}

function createReverbIR(ctx: BaseAudioContext, size: number): AudioBuffer {
  const seconds = 0.1 + (size / 100) * 2.9; // 0.1..3 s
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(seconds * rate));
  const ir = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const decay = Math.pow(1 - i / length, 2.5);
      data[i] = (Math.random() * 2 - 1) * decay;
    }
  }
  return ir;
}

/**
 * Construye el grafo de efectos sobre el contexto dado. Los LFO arrancan en
 * `startTime`. Devuelve las referencias para poder actualizar parámetros en vivo.
 */
export function buildGraph(ctx: BaseAudioContext, params: StudioParams, startTime = 0): GraphRefs {
  const input = ctx.createGain();
  const output = ctx.createGain();

  // --- EQ ---
  const eqLow = ctx.createBiquadFilter();
  eqLow.type = "lowshelf";
  eqLow.frequency.value = 200;
  const eqMid = ctx.createBiquadFilter();
  eqMid.type = "peaking";
  eqMid.frequency.value = 1000;
  eqMid.Q.value = 0.8;
  const eqHigh = ctx.createBiquadFilter();
  eqHigh.type = "highshelf";
  eqHigh.frequency.value = 4000;

  // --- Saturación ---
  const saturation = ctx.createWaveShaper();
  saturation.oversample = "2x";

  // --- Vibrato (delay modulado -> oscilación de tono) ---
  const vibratoDelay = ctx.createDelay(0.05);
  vibratoDelay.delayTime.value = 0.005;
  const vibratoLfo = ctx.createOscillator();
  vibratoLfo.type = "sine";
  const vibratoDepth = ctx.createGain();
  vibratoLfo.connect(vibratoDepth).connect(vibratoDelay.delayTime);

  // --- Trémolo (modulación de amplitud) ---
  const tremoloGain = ctx.createGain();
  const tremoloLfo = ctx.createOscillator();
  tremoloLfo.type = "sine";
  const tremoloDepth = ctx.createGain();
  tremoloLfo.connect(tremoloDepth).connect(tremoloGain.gain);

  // cadena en serie
  input.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(saturation);
  saturation.connect(vibratoDelay);
  vibratoDelay.connect(tremoloGain);

  // --- Anchura estéreo (M/S) ---
  const splitter = ctx.createChannelSplitter(2);
  const midGain = ctx.createGain();
  midGain.gain.value = 0.5;
  const sideGain = ctx.createGain();
  sideGain.gain.value = 0.5;
  const rInv = ctx.createGain();
  rInv.gain.value = -1;
  tremoloGain.connect(splitter);
  splitter.connect(midGain, 0);
  splitter.connect(midGain, 1);
  splitter.connect(sideGain, 0);
  splitter.connect(rInv, 1);
  rInv.connect(sideGain);
  const widthSide = ctx.createGain();
  sideGain.connect(widthSide);
  const sideInv = ctx.createGain();
  sideInv.gain.value = -1;
  widthSide.connect(sideInv);
  const merger = ctx.createChannelMerger(2);
  midGain.connect(merger, 0, 0);
  widthSide.connect(merger, 0, 0);
  midGain.connect(merger, 0, 1);
  sideInv.connect(merger, 0, 1);

  const core = ctx.createGain(); // bus ensanchado, previo a los efectos
  merger.connect(core);

  // bus de mezcla: seco + envíos en paralelo
  const mixBus = ctx.createGain();
  core.connect(mixBus); // seco

  // --- Chorus ---
  const chorusDelay = ctx.createDelay(0.1);
  chorusDelay.delayTime.value = 0.025;
  const chorusLfo = ctx.createOscillator();
  chorusLfo.type = "sine";
  const chorusDepth = ctx.createGain();
  chorusLfo.connect(chorusDepth).connect(chorusDelay.delayTime);
  const chorusWet = ctx.createGain();
  core.connect(chorusDelay);
  chorusDelay.connect(chorusWet);
  chorusWet.connect(mixBus);

  // --- Delay (con realimentación) ---
  const delay = ctx.createDelay(2.0);
  const delayFeedback = ctx.createGain();
  const delayWet = ctx.createGain();
  core.connect(delay);
  delay.connect(delayFeedback);
  delayFeedback.connect(delay);
  delay.connect(delayWet);
  delayWet.connect(mixBus);

  // --- Reverb ---
  const convolver = ctx.createConvolver();
  convolver.buffer = createReverbIR(ctx, params.reverbSize);
  const reverbWet = ctx.createGain();
  core.connect(convolver);
  convolver.connect(reverbWet);
  reverbWet.connect(mixBus);

  mixBus.connect(output);

  vibratoLfo.start(startTime);
  tremoloLfo.start(startTime);
  chorusLfo.start(startTime);

  const refs: GraphRefs = {
    input, output, eqLow, eqMid, eqHigh, saturation, vibratoDelay, vibratoLfo,
    vibratoDepth, tremoloGain, tremoloLfo, tremoloDepth, widthSide, chorusDelay,
    chorusLfo, chorusDepth, chorusWet, delay, delayFeedback, delayWet, reverbWet,
    convolver,
  };
  applyParams(refs, params);
  return refs;
}

/** Actualiza los nodos del grafo desde los parámetros (barato: se puede llamar en cada cambio). */
export function applyParams(refs: GraphRefs, p: StudioParams) {
  refs.eqLow.gain.value = p.eqLow;
  refs.eqMid.gain.value = p.eqMid;
  refs.eqHigh.gain.value = p.eqHigh;
  refs.saturation.curve = makeSaturationCurve(p.drive);

  refs.vibratoLfo.frequency.value = p.vibratoRate;
  refs.vibratoDepth.gain.value = (p.vibratoDepth / 100) * 0.002;

  refs.tremoloLfo.frequency.value = p.tremoloRate;
  const tremDepth = p.tremoloDepth / 100;
  refs.tremoloGain.gain.value = 1 - tremDepth / 2;
  refs.tremoloDepth.gain.value = tremDepth / 2;

  refs.widthSide.gain.value = (p.stereoWidth / 100) * 0.5;

  refs.chorusLfo.frequency.value = p.chorusRate;
  refs.chorusDepth.gain.value = (p.chorusDepth / 100) * 0.004;
  refs.chorusWet.gain.value = (p.chorusDepth / 100) * 0.5;

  refs.delay.delayTime.value = Math.min(2, p.delayTime / 1000);
  refs.delayFeedback.gain.value = Math.min(0.9, p.delayFeedback / 100);
  refs.delayWet.gain.value = p.delayTime > 0 ? p.delayMix / 100 : 0;

  refs.reverbWet.gain.value = p.reverbMix / 100;

  refs.output.gain.value = dbToGain(p.gain);
}

/** Regenera el impulso de reverb (llamar al cambiar reverbSize). */
export function updateReverb(ctx: BaseAudioContext, refs: GraphRefs, size: number) {
  refs.convolver.buffer = createReverbIR(ctx, size);
}

/** Aplica tono/tempo (y la reproducción invertida) offline con SoundTouch. */
function processPitchTempo(
  buffer: AudioBuffer,
  p: StudioParams,
): { left: Float32Array; right: Float32Array; sampleRate: number } {
  const src = new WebAudioBufferSource(buffer);
  const st = new SoundTouch();
  st.pitchSemitones = p.semitones + p.cents / 100;
  st.tempo = p.tempo / 100;
  st.rate = 1;

  if (p.reverse) {
    // WebAudioBufferSource lee el AudioBuffer directamente: invertimos una copia.
    const ch0 = Float32Array.from(buffer.getChannelData(0)).reverse();
    const ch1 = buffer.numberOfChannels > 1
      ? Float32Array.from(buffer.getChannelData(1)).reverse()
      : ch0;
    src.buffer = {
      numberOfChannels: 2,
      length: ch0.length,
      getChannelData: (c: number) => (c === 0 ? ch0 : ch1),
    } as unknown as AudioBuffer;
  }

  const filter = new SimpleFilter(src, st);
  const BLOCK = 4096;
  const interleaved = new Float32Array(BLOCK * 2);
  const leftChunks: Float32Array[] = [];
  const rightChunks: Float32Array[] = [];
  let total = 0;
  let extracted = 0;
  // salvaguarda contra bucles infinitos
  const maxFrames = Math.ceil((buffer.length / (p.tempo / 100)) * 1.2) + BLOCK * 4;
  while ((extracted = filter.extract(interleaved, BLOCK)) > 0 && total < maxFrames) {
    const l = new Float32Array(extracted);
    const r = new Float32Array(extracted);
    for (let i = 0; i < extracted; i++) {
      l[i] = interleaved[i * 2];
      r[i] = interleaved[i * 2 + 1];
    }
    leftChunks.push(l);
    rightChunks.push(r);
    total += extracted;
  }

  const left = new Float32Array(total);
  const right = new Float32Array(total);
  let off = 0;
  for (let i = 0; i < leftChunks.length; i++) {
    left.set(leftChunks[i], off);
    right.set(rightChunks[i], off);
    off += leftChunks[i].length;
  }
  return { left, right, sampleRate: buffer.sampleRate };
}

/** Render offline completo: tono/tempo + grafo de efectos. */
export async function renderOffline(buffer: AudioBuffer, params: StudioParams): Promise<AudioBuffer> {
  const { left, right, sampleRate } = processPitchTempo(buffer, params);
  const frames = left.length;
  if (frames === 0) throw new Error("No se pudo procesar el audio");

  const tail = Math.ceil(
    (0.1 + (params.reverbSize / 100) * 2.9 + params.delayTime / 1000 + 0.3) * sampleRate,
  );
  const totalLength = frames + tail;

  const Offline =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!Offline) throw new Error("OfflineAudioContext no soportado en este navegador");

  const offline = new Offline(2, totalLength, sampleRate);
  const srcBuffer = offline.createBuffer(2, frames, sampleRate);
  srcBuffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
  srcBuffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
  const srcNode = offline.createBufferSource();
  srcNode.buffer = srcBuffer;

  const refs = buildGraph(offline, params, 0);
  srcNode.connect(refs.input);
  refs.output.connect(offline.destination);
  srcNode.start(0);

  return offline.startRendering();
}

/** Crea un reproductor de previsualización en tiempo real. */
export function createPreview(ctx: AudioContext, buffer: AudioBuffer, params: StudioParams) {
  const shifter = new PitchShifter(ctx, buffer, 4096);
  shifter.tempo = params.tempo / 100;
  shifter.pitchSemitones = params.semitones + params.cents / 100;

  const refs = buildGraph(ctx, params, ctx.currentTime);
  shifter.connect(refs.input);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  refs.output.connect(analyser);
  analyser.connect(ctx.destination);

  return { shifter, refs, analyser };
}

export { PitchShifter };
