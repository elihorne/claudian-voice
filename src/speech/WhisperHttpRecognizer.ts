import { requestUrl } from 'obsidian';

import type { ListenCallbacks, RecognitionResult, SpeechRecognizer } from './types';

export interface WhisperHttpOptions {
  getEndpoint: () => string;
  getApiKey: () => string;
  getModel: () => string;
  getLanguage: () => string;
  /** Silence this long after speech ends the utterance. */
  getSilenceMs: () => number;
  /** Give up waiting for the first word after this long. */
  getNoSpeechTimeoutMs: () => number;
  /** RMS level below which audio counts as silence. */
  getSilenceThreshold: () => number;
  /** Vocabulary hint (glossary terms); whisper-1 takes it as `prompt`. */
  getPrompt?: () => string;
}

/**
 * Records one utterance with MediaRecorder, ends it on trailing silence, and posts it to
 * an OpenAI-compatible `/v1/audio/transcriptions` endpoint (OpenAI, Groq, local
 * faster-whisper or whisper.cpp servers all accept this shape).
 */
export class WhisperHttpRecognizer implements SpeechRecognizer {
  readonly id = 'whisper-http' as const;
  #finishRequested = false;

  finish(): void {
    this.#finishRequested = true;
  }

  constructor(private readonly options: WhisperHttpOptions) {}

  isAvailable(): boolean {
    return typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia
      && typeof MediaRecorder !== 'undefined'
      && this.options.getEndpoint().trim().length > 0;
  }

  async listen(signal: AbortSignal, callbacks: ListenCallbacks = {}): Promise<RecognitionResult | null> {
    const audio = await this.#record(signal, callbacks.onLevel);
    if (!audio || signal.aborted) return null;
    const text = await this.#transcribe(audio);
    return text ? { text } : null;
  }

  async #record(signal: AbortSignal, onLevel?: (rms: number) => void): Promise<Blob | null> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data); };

    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    const silenceMs = this.options.getSilenceMs();
    const noSpeechMs = this.options.getNoSpeechTimeoutMs();
    const configuredThreshold = this.options.getSilenceThreshold();
    const started = performance.now();
    let lastVoice = 0;
    let heardSpeech = false;
    let voicedMs = 0;
    let lastTick = started;
    // Calibrate against the room for the first 300ms so the gate sits above ambient noise
    // (fans, keyboard, the tail of the agent's own speech) rather than at a fixed level.
    let ambientPeak = 0;
    let threshold = configuredThreshold;

    this.#finishRequested = false;
    const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
    recorder.start(250);

    const finish = await new Promise<'speech' | 'silence' | 'aborted'>(resolve => {
      const tick = () => {
        if (signal.aborted) return resolve('aborted');
        if (this.#finishRequested) return resolve(heardSpeech ? 'speech' : 'silence');
        analyser.getFloatTimeDomainData(samples);
        const rms = rootMeanSquare(samples);
        onLevel?.(rms);
        const now = performance.now();
        const delta = now - lastTick;
        lastTick = now;
        if (now - started < CALIBRATION_MS) {
          ambientPeak = Math.max(ambientPeak, rms);
          threshold = Math.max(configuredThreshold, ambientPeak * AMBIENT_MARGIN);
          requestAnimationFrame(tick);
          return;
        }
        if (rms > threshold) {
          heardSpeech = true;
          lastVoice = now;
          voicedMs += delta;
        } else if (heardSpeech && now - lastVoice > silenceMs) {
          return resolve('speech');
        } else if (!heardSpeech && now - started > noSpeechMs) {
          return resolve('silence');
        }
        requestAnimationFrame(tick);
      };
      tick();
    });

    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    for (const track of stream.getTracks()) track.stop();
    source.disconnect();
    await context.close().catch(() => undefined);

    // A click or cough crosses the gate but is not an utterance; Whisper hallucinates on those.
    if (finish !== 'speech' || voicedMs < MIN_VOICED_MS) return null;
    return new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
  }

  async #transcribe(audio: Blob): Promise<string> {
    const boundary = `----claudian-voice-${Date.now().toString(16)}`;
    const extension = audio.type.includes('ogg') ? 'ogg' : audio.type.includes('mp4') ? 'm4a' : 'webm';
    const fields: Array<[string, string]> = [['model', this.options.getModel() || 'whisper-1']];
    const language = this.options.getLanguage().trim();
    if (language) fields.push(['language', language]);
    const prompt = this.options.getPrompt?.().trim() ?? '';
    if (prompt) fields.push(['prompt', prompt.slice(0, 800)]);
    // verbose_json carries per-segment no_speech_prob and the detected language, which is
    // how we tell a real utterance from Whisper's "thanks for watching" on silence.
    fields.push(['response_format', 'verbose_json']);

    const body = await buildMultipart(boundary, fields, { name: 'file', filename: `utterance.${extension}`, type: audio.type || 'audio/webm', blob: audio });
    const headers: Record<string, string> = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
    const apiKey = this.options.getApiKey().trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await requestUrl({
      url: this.options.getEndpoint().trim(),
      method: 'POST',
      headers,
      body,
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Transcription failed (${response.status}): ${response.text.slice(0, 200)}`);
    }
    const payload = response.json as VerboseTranscription;
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) return '';
    if (isLikelyHallucination(payload, language)) return '';
    return text;
  }
}

export interface VerboseTranscription {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  segments?: Array<{ no_speech_prob?: number; avg_logprob?: number; text?: string }>;
}

const CALIBRATION_MS = 300;
const AMBIENT_MARGIN = 2.5;
const MIN_VOICED_MS = 400;

/** Whisper's signature outputs on silence, in the languages it most often drifts into. */
const PHANTOM_PHRASES = [
  /thank(s| you) for watching/i,
  /subscribe/i,
  /시청.*감사/u,
  /ご視聴ありがとう/u,
  /^evet\.?$/i,
  /^you\.?$/i,
  /^bye\.?$/i,
  /^thank you\.?$/i,
];

export function isLikelyHallucination(payload: VerboseTranscription, languageHint: string): boolean {
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (PHANTOM_PHRASES.some(pattern => pattern.test(text))) return true;
  const segments = payload.segments ?? [];
  if (segments.length > 0) {
    const confidentSpeech = segments.some(segment =>
      (segment.no_speech_prob ?? 0) < 0.5 && (segment.avg_logprob ?? 0) > -1.0);
    if (!confidentSpeech) return true;
  }
  // A language hint was given but Whisper answered in another language: noise, not speech.
  if (languageHint && typeof payload.language === 'string') {
    const detected = payload.language.toLowerCase();
    const hint = languageHint.toLowerCase();
    if (detected !== hint && !LANGUAGE_NAMES[hint]?.includes(detected)) return true;
  }
  return false;
}

/** verbose_json reports full names ("english") while users type codes ("en"). */
const LANGUAGE_NAMES: Record<string, string[]> = {
  en: ['english'], de: ['german'], sv: ['swedish'], fr: ['french'], es: ['spanish'], it: ['italian'],
  pt: ['portuguese'], nl: ['dutch'], ja: ['japanese'], zh: ['chinese'], ko: ['korean'], ru: ['russian'],
  pl: ['polish'], tr: ['turkish'], da: ['danish'], no: ['norwegian'], fi: ['finnish'],
};

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    .find(candidate => MediaRecorder.isTypeSupported(candidate));
}

function rootMeanSquare(samples: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

async function buildMultipart(
  boundary: string,
  fields: Array<[string, string]>,
  file: { name: string; filename: string; type: string; blob: Blob },
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of fields) {
    parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`,
  ));
  parts.push(new Uint8Array(await file.blob.arrayBuffer()));
  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out.buffer;
}
