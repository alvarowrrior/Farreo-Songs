// Codificación MP3 en el navegador (lamejs), para que el estudio pueda exportar
// sin depender de ffmpeg en el servidor.
import lamejs from "@breezystack/lamejs";

const MP3_FRAME = 1152; // tamaño de frame MP3

function floatTo16(input: Float32Array, length: number, out: Int16Array): Int16Array {
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Codificador incremental: se le pasan bloques de PCM y solo retiene el MP3
 * resultante. Así una pista larga no necesita una copia entera en Int16 además
 * de la de Float32.
 */
class Mp3Stream {
  private encoder: InstanceType<typeof lamejs.Mp3Encoder>;
  private chunks: Uint8Array[] = [];
  private readonly stereo: boolean;
  private leftInt: Int16Array = new Int16Array(0);
  private rightInt: Int16Array = new Int16Array(0);

  constructor(channels: number, sampleRate: number, kbps = 192) {
    this.stereo = channels > 1;
    this.encoder = new lamejs.Mp3Encoder(this.stereo ? 2 : 1, sampleRate, kbps);
  }

  /** Codifica `length` muestras de los buffers dados. */
  write(left: Float32Array, right: Float32Array | null, length = left.length) {
    if (length <= 0) return;
    if (this.leftInt.length < length) {
      this.leftInt = new Int16Array(length);
      this.rightInt = new Int16Array(length);
    }

    const l = floatTo16(left, length, this.leftInt).subarray(0, length);
    const r = this.stereo && right
      ? floatTo16(right, length, this.rightInt).subarray(0, length)
      : l;

    const encoded = this.stereo ? this.encoder.encodeBuffer(l, r) : this.encoder.encodeBuffer(l);
    if (encoded.length > 0) this.chunks.push(new Uint8Array(encoded));
  }

  /** Cierra el flujo y devuelve el MP3 completo. */
  finish(): Blob {
    const tail = this.encoder.flush();
    if (tail.length > 0) this.chunks.push(new Uint8Array(tail));
    const blob = new Blob(this.chunks as BlobPart[], { type: "audio/mpeg" });
    this.chunks = [];
    return blob;
  }
}

/** Codifica un AudioBuffer ya renderizado a un Blob MP3. */
export function audioBufferToMp3(buffer: AudioBuffer, kbps = 192): Blob {
  const stereo = buffer.numberOfChannels > 1;
  const left = buffer.getChannelData(0);
  const right = stereo ? buffer.getChannelData(1) : null;

  const stream = new Mp3Stream(stereo ? 2 : 1, buffer.sampleRate, kbps);
  for (let i = 0; i < left.length; i += MP3_FRAME) {
    const length = Math.min(MP3_FRAME, left.length - i);
    stream.write(
      left.subarray(i, i + length),
      right ? right.subarray(i, i + length) : null,
      length,
    );
  }
  return stream.finish();
}

/** Lanza la descarga de un blob con el nombre indicado. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
