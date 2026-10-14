import { rootMeanSquare } from './pcm';

export interface BargeInOptions {
  /** Floor for the gate when nothing is playing. */
  getThreshold: () => number;
  /** Continuous voiced time required before it counts as the user talking over the reply. */
  getHoldMs: () => number;
  /** Output RMS of our own playback right now; undefined when the speaker cannot report it. */
  getReferenceLevel?: () => number | undefined;
}

/**
 * Listens while the agent speaks and fires once the user talks over it.
 *
 * Echo handling: the speaker reports its output level, and the monitor learns how much of
 * that reaches the mic (the leakage ratio) during the first moments of playback, when the
 * user is presumably quiet. From then on the expected echo is `reference × ratio`, and the
 * gate sits above that plus the room floor. A sustained signal above the gate is the user.
 * Without a reference (system TTS) it falls back to a slow moving average of what it hears.
 */
export class BargeInMonitor {
  constructor(private readonly options: BargeInOptions) {}

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  /** Resolves true when the user barged in, false when the signal aborted first. */
  async watch(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
    if (signal.aborted) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    const started = performance.now();
    let lastTick = started;
    let roomFloor = 0;          // slow average of mic level while playback is quiet
    let leakRatio = 0;          // mic level per unit of playback level, learned on the fly
    let leakSamples = 0;
    let referenceHistory: number[] = [];
    let background = 0;         // fallback moving average when no reference exists
    let voicedSince: number | null = null;

    try {
      return await new Promise<boolean>(resolve => {
        const onAbort = () => resolve(false);
        signal.addEventListener('abort', onAbort, { once: true });
        const tick = () => {
          if (signal.aborted) return;
          analyser.getFloatTimeDomainData(samples);
          const mic = rootMeanSquare(samples);
          const now = performance.now();
          const delta = Math.min(now - lastTick, 100);
          lastTick = now;

          const reference = this.options.getReferenceLevel?.();
          let gate: number;
          if (reference !== undefined) {
            // Acoustic and buffer delay: compare against the loudest playback in the last ~200ms.
            referenceHistory.push(reference);
            if (referenceHistory.length > 12) referenceHistory = referenceHistory.slice(-12);
            const recentReference = Math.max(...referenceHistory);
            if (recentReference < QUIET_REFERENCE) {
              roomFloor = ema(roomFloor, mic, delta, FLOOR_TAU_MS);
            } else if (leakSamples < LEARN_SAMPLES || mic < recentReference * leakRatio * 1.5) {
              // Learn (or keep refining) the ratio while the mic looks like echo rather than a voice.
              const observed = Math.max(0, mic - roomFloor) / recentReference;
              leakRatio = leakSamples === 0 ? observed : ema(leakRatio, observed, delta, LEAK_TAU_MS);
              leakSamples += 1;
            }
            const expectedEcho = recentReference * leakRatio;
            gate = Math.max(this.options.getThreshold(), roomFloor * ROOM_MARGIN, (expectedEcho + roomFloor) * ECHO_MARGIN);
          } else {
            const tau = mic > background ? RISE_TAU_MS : FALL_TAU_MS;
            background = ema(background, mic, delta, tau);
            gate = Math.max(this.options.getThreshold(), background * FALLBACK_MARGIN);
          }

          if (now - started < CALIBRATION_MS) {
            window.requestAnimationFrame(tick);
            return;
          }
          if (mic > gate) {
            voicedSince ??= now;
            if (now - voicedSince >= this.options.getHoldMs()) {
              signal.removeEventListener('abort', onAbort);
              return resolve(true);
            }
          } else {
            voicedSince = null;
          }
          window.requestAnimationFrame(tick);
        };
        tick();
      });
    } finally {
      for (const track of stream.getTracks()) track.stop();
      source.disconnect();
      await context.close().catch(() => undefined);
    }
  }
}

function ema(current: number, sample: number, deltaMs: number, tauMs: number): number {
  return current + (sample - current) * (1 - Math.exp(-deltaMs / tauMs));
}

const CALIBRATION_MS = 400;
const QUIET_REFERENCE = 0.004;
const LEARN_SAMPLES = 30;
const FLOOR_TAU_MS = 1500;
const LEAK_TAU_MS = 600;
const ROOM_MARGIN = 3;
const ECHO_MARGIN = 1.8;
const FALLBACK_MARGIN = 2.5;
const RISE_TAU_MS = 250;
const FALL_TAU_MS = 3000;
