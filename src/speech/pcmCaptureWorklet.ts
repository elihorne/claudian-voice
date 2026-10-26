/**
 * AudioWorklet that turns microphone audio into 16-bit PCM at the transcription rate, off
 * the main thread. It replaces the deprecated ScriptProcessorNode.
 *
 * A bundled plugin cannot ship a separate worklet file, so the processor source lives here
 * as a string and is loaded from a Blob URL. It has no imports: the resampler is a copy of
 * `resample`/`floatToPcm16` in pcm.ts, kept in step by the worklet test.
 *
 * Messages to the main thread: `{ pcm: Int16Array, rms: number }` per chunk, where `rms` is
 * the level of that chunk's samples, for the meter.
 */

export const PCM_CAPTURE_PROCESSOR = 'claudian-voice-pcm-capture';

export interface PcmCaptureOptions {
  /** Output sample rate. */
  targetRate: number;
  /** Samples per posted chunk, at `targetRate`. */
  chunkSamples: number;
}

export interface PcmCaptureMessage {
  pcm: Int16Array;
  rms: number;
}

export const PCM_CAPTURE_WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetRate, chunkSamples } = options.processorOptions;
    // \`sampleRate\` is the AudioContext rate, a global in the worklet scope.
    this.ratio = sampleRate / targetRate;
    this.out = new Int16Array(chunkSamples);
    this.filled = 0;
    // Input not yet consumed by the resampler, and the fractional read position into it.
    this.pending = new Float32Array(0);
    this.phase = 0;
    this.sumSquares = 0;
    this.count = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    const merged = new Float32Array(this.pending.length + channel.length);
    merged.set(this.pending);
    merged.set(channel, this.pending.length);
    // Linear interpolation; each output sample needs its right-hand neighbour, so the last
    // input sample waits for the next block.
    let pos = this.phase;
    while (pos + 1 < merged.length) {
      const left = Math.floor(pos);
      const t = pos - left;
      const sample = merged[left] * (1 - t) + merged[left + 1] * t;
      const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
      this.sumSquares += clamped * clamped;
      this.count += 1;
      this.out[this.filled] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.filled += 1;
      if (this.filled === this.out.length) this.flush();
      pos += this.ratio;
    }
    const keep = Math.floor(pos);
    this.pending = merged.slice(keep);
    this.phase = pos - keep;
    return true;
  }

  flush() {
    if (this.filled === 0) return;
    const pcm = this.out.slice(0, this.filled);
    const rms = this.count > 0 ? Math.sqrt(this.sumSquares / this.count) : 0;
    this.port.postMessage({ pcm, rms }, [pcm.buffer]);
    this.filled = 0;
    this.sumSquares = 0;
    this.count = 0;
  }
}
registerProcessor('${PCM_CAPTURE_PROCESSOR}', PcmCapture);
`;

let moduleUrl: string | null = null;

/** Blob URL for the worklet module, created once per plugin load. */
export function pcmCaptureModuleUrl(): string {
  moduleUrl ??= URL.createObjectURL(new Blob([PCM_CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }));
  return moduleUrl;
}

const loaded = new WeakSet<AudioContext>();

/** Registers the processor on a context, once. Rejects where AudioWorklet is unavailable. */
export async function ensurePcmCaptureWorklet(context: AudioContext): Promise<void> {
  if (loaded.has(context)) return;
  if (!context.audioWorklet) throw new Error('AudioWorklet is not available in this window.');
  await context.audioWorklet.addModule(pcmCaptureModuleUrl());
  loaded.add(context);
}
