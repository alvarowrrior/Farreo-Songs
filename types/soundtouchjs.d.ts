declare module "soundtouchjs" {
  export class PitchShifter {
    constructor(context: BaseAudioContext, buffer: AudioBuffer, bufferSize: number, onEnd?: () => void);
    tempo: number;
    rate: number;
    pitch: number;
    pitchSemitones: number;
    readonly node: AudioNode;
    readonly duration: number;
    percentagePlayed: number;
    connect(node: AudioNode): void;
    disconnect(): void;
    on(event: string, cb: (detail: unknown) => void): void;
    off(event?: string): void;
  }

  export class SoundTouch {
    constructor();
    tempo: number;
    rate: number;
    pitch: number;
    pitchSemitones: number;
  }

  export class WebAudioBufferSource {
    constructor(buffer: AudioBuffer);
    buffer: AudioBuffer;
    extract(target: Float32Array, numFrames?: number, position?: number): number;
  }

  export class SimpleFilter {
    constructor(source: WebAudioBufferSource, pipe: SoundTouch, callback?: () => void);
    sourcePosition: number;
    extract(target: Float32Array, numFrames?: number): number;
  }

  export class RateTransposer {}
  export class Stretch {}
  export class AbstractFifoSamplePipe {}
  export function getWebAudioNode(...args: unknown[]): AudioNode;
}
