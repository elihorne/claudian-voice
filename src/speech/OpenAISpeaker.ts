import { requestUrl } from 'obsidian';

import type { Speaker } from './types';

export interface OpenAISpeakerOptions {
  getEndpoint: () => string;
  getApiKey: () => string;
  getModel: () => string;
  getVoice: () => string;
  getSpeed: () => number;
  /** Synthesis failures are reported here instead of being dropped as silence. */
  onError: (error: Error) => void;
  isDebug?: () => boolean;
}

/** OpenAI's `pcm` response format: 24kHz, mono, signed 16-bit little-endian. */
const PCM_RATE = 24000;
/** Schedule a little ahead so back-to-back chunks never leave a gap. */
const LEAD_SECONDS = 0.05;
/** Phrases up to this length are cached after first synthesis. */
const PHRASE_CACHE_MAX_CHARS = 32;

interface QueuedUtterance {
  text: string;
  stream: PcmStream;
  resolve: () => void;
}

/** Audio for one utterance as it arrives from the network. */
interface PcmStream {
  chunks: Float32Array<ArrayBuffer>[];
  done: boolean;
  error: Error | null;
  /** Wakes the player when a chunk lands or the stream ends. */
  notify: () => void;
  wait: () => Promise<void>;
}

/**
 * Neural TTS through an OpenAI-compatible `/v1/audio/speech` endpoint. Each utterance is
 * requested the moment it is enqueued and played as the bytes arrive, so the first words
 * are heard a few hundred milliseconds after the request rather than after the whole clip
 * downloads. Playback goes through an analyser so the barge-in monitor can read our own
 * output level. Falls back to a whole-file request when streaming is unavailable.
 */
export class OpenAISpeaker implements Speaker {
  #queue: QueuedUtterance[] = [];
  #playing = false;
  #context: AudioContext | null = null;
  #analyser: AnalyserNode | null = null;
  #levelSamples: Float32Array<ArrayBuffer> | null = null;
  #active = new Set<AudioBufferSourceNode>();
  #generation = 0;
  #streamingSupported: boolean | null = null;
  /** Audio for short fixed phrases ("Noted.", "Working on it."), keyed by voice+model+text. */
  #phraseCache = new Map<string, Float32Array<ArrayBuffer>[]>();

  constructor(private readonly options: OpenAISpeakerOptions) {}

  get isSpeaking(): boolean {
    return this.#playing || this.#queue.length > 0;
  }

  /** RMS of what is being played right now, so the barge-in monitor can subtract our own voice. */
  getOutputLevel(): number | undefined {
    if (!this.#analyser || !this.#levelSamples || this.#active.size === 0) return 0;
    this.#analyser.getFloatTimeDomainData(this.#levelSamples);
    let sum = 0;
    for (let index = 0; index < this.#levelSamples.length; index += 1) {
      const value = this.#levelSamples[index] ?? 0;
      sum += value * value;
    }
    return Math.sqrt(sum / this.#levelSamples.length);
  }

  speak(sentence: string): Promise<void> {
    const text = sentence.trim();
    if (!text) return Promise.resolve();
    const generation = this.#generation;
    const stream = createPcmStream();
    const cacheKey = text.length <= PHRASE_CACHE_MAX_CHARS ? `${this.options.getModel()}|${this.options.getVoice()}|${this.options.getSpeed()}|${text}` : null;
    const cached = cacheKey ? this.#phraseCache.get(cacheKey) : undefined;
    if (cached) {
      stream.chunks.push(...cached);
      stream.done = true;
    } else {
      void this.#fetchInto(text, stream, generation).then(() => {
        if (cacheKey && !stream.error && stream.chunks.length > 0) this.#phraseCache.set(cacheKey, [...stream.chunks]);
      });
    }
    return new Promise<void>(resolve => {
      this.#queue.push({ text, stream, resolve });
      void this.#drain();
    });
  }

  cancel(): void {
    this.#generation += 1;
    for (const item of this.#queue) item.resolve();
    this.#queue = [];
    for (const source of this.#active) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.#active.clear();
    this.#playing = false;
  }

  dispose(): void {
    this.cancel();
    this.#analyser?.disconnect();
    this.#analyser = null;
    void this.#context?.close().catch(() => undefined);
    this.#context = null;
  }

  async #drain(): Promise<void> {
    if (this.#playing) return;
    this.#playing = true;
    try {
      while (this.#queue.length > 0) {
        const generation = this.#generation;
        const item = this.#queue.shift();
        if (!item) break;
        try {
          await this.#play(item.stream, generation);
        } catch (error) {
          if (generation === this.#generation) this.options.onError(error instanceof Error ? error : new Error(String(error)));
        }
        item.resolve();
      }
    } finally {
      this.#playing = false;
    }
  }

  /** Schedules chunks as they arrive; resolves when the last one has finished playing. */
  async #play(stream: PcmStream, generation: number): Promise<void> {
    const context = this.#audioContext();
    await context.resume().catch(() => undefined);
    let nextStart = 0;
    let consumed = 0;
    const ended: Promise<void>[] = [];

    while (generation === this.#generation) {
      while (consumed < stream.chunks.length) {
        const samples = stream.chunks[consumed];
        consumed += 1;
        if (!samples || samples.length === 0) continue;
        const buffer = context.createBuffer(1, samples.length, PCM_RATE);
        buffer.copyToChannel(samples, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.#outputTap(context));
        const startAt = Math.max(context.currentTime + LEAD_SECONDS, nextStart);
        nextStart = startAt + buffer.duration;
        this.#active.add(source);
        ended.push(new Promise<void>(resolve => {
          source.onended = () => { this.#active.delete(source); resolve(); };
        }));
        source.start(startAt);
      }
      if (stream.error) throw stream.error;
      if (stream.done) break;
      await stream.wait();
    }
    if (generation === this.#generation) await Promise.all(ended);
  }

  /** Requests the utterance and feeds decoded PCM into the stream, chunk by chunk. */
  async #fetchInto(text: string, stream: PcmStream, generation: number): Promise<void> {
    try {
      if (this.#streamingSupported !== false) {
        try {
          const started = performance.now();
          await this.#fetchStreaming(text, stream, generation);
          if (this.#streamingSupported !== true) this.#log('streaming TTS works', { firstRequestMs: Math.round(performance.now() - started) });
          this.#streamingSupported = true;
          return;
        } catch (error) {
          if (this.#streamingSupported === true) throw error;
          // First attempt failed before any audio: assume fetch is blocked here and fall back for good.
          if (stream.chunks.length > 0) throw error;
          this.#log('streaming TTS unavailable, falling back to whole-file requests', error instanceof Error ? error.message : error);
          this.#streamingSupported = false;
        }
      }
      await this.#fetchWhole(text, stream, generation);
    } catch (error) {
      stream.error = error instanceof Error ? error : new Error(String(error));
    } finally {
      stream.done = true;
      stream.notify();
    }
  }

  async #fetchStreaming(text: string, stream: PcmStream, generation: number): Promise<void> {
    // fetch, not requestUrl: PCM is streamed and played as it arrives, and requestUrl buffers the whole body.
    const response = await fetch(this.options.getEndpoint().trim(), {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(this.#body(text, 'pcm')),
    });
    if (!response.ok) throw new Error(await describeFailure(response.status, await response.text()));
    if (!response.body) throw new Error('Streaming response had no body.');
    const reader = response.body.getReader();
    let carry: Uint8Array = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (generation !== this.#generation) { void reader.cancel(); return; }
      if (done) break;
      if (!value) continue;
      // PCM16 frames are two bytes; keep a dangling byte for the next chunk.
      const merged = concat(carry, value);
      const usable = merged.length - (merged.length % 2);
      stream.chunks.push(pcm16BytesToFloat(merged.subarray(0, usable)));
      carry = merged.slice(usable);
      stream.notify();
    }
  }

  async #fetchWhole(text: string, stream: PcmStream, generation: number): Promise<void> {
    const response = await requestUrl({
      url: this.options.getEndpoint().trim(),
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(this.#body(text, 'pcm')),
      throw: false,
    });
    if (generation !== this.#generation) return;
    if (response.status < 200 || response.status >= 300) throw new Error(await describeFailure(response.status, response.text));
    const bytes = new Uint8Array(response.arrayBuffer);
    stream.chunks.push(pcm16BytesToFloat(bytes.subarray(0, bytes.length - (bytes.length % 2))));
    stream.notify();
  }

  #log(message: string, detail?: unknown): void {
    if (this.options.isDebug?.()) console.debug(`[claudian-voice] ${message}`, detail ?? '');
  }

  #headers(): Record<string, string> {
    const apiKey = this.options.getApiKey().trim();
    return { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  }

  #body(text: string, format: 'pcm' | 'wav'): Record<string, unknown> {
    const model = this.options.getModel() || 'tts-1';
    return {
      model,
      voice: this.options.getVoice() || 'nova',
      input: text,
      response_format: format,
      // Only the tts-1 family accepts `speed`; gpt-4o-mini-tts takes `instructions` instead.
      ...(model.startsWith('tts-1')
        ? { speed: clamp(this.options.getSpeed(), 0.25, 4) }
        : { instructions: `Read the text exactly as written, in the language it is written in, with a clear neutral accent. ${paceInstruction(this.options.getSpeed())}` }),
    };
  }

  #audioContext(): AudioContext {
    this.#context ??= new AudioContext({ sampleRate: PCM_RATE });
    return this.#context;
  }

  /** Playback runs through an analyser on its way to the speakers so its level can be read. */
  #outputTap(context: AudioContext): AudioNode {
    if (!this.#analyser) {
      this.#analyser = context.createAnalyser();
      this.#analyser.fftSize = 1024;
      this.#levelSamples = new Float32Array(this.#analyser.fftSize);
      this.#analyser.connect(context.destination);
    }
    return this.#analyser;
  }
}

function createPcmStream(): PcmStream {
  let wake: (() => void) | null = null;
  return {
    chunks: [],
    done: false,
    error: null,
    notify: () => { wake?.(); wake = null; },
    wait: () => new Promise<void>(resolve => { wake = resolve; }),
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function pcm16BytesToFloat(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return out;
}

async function describeFailure(status: number, text: string): Promise<string> {
  let detail = '';
  try { detail = String((JSON.parse(text) as { error?: { message?: string } }).error?.message ?? ''); } catch { /* not json */ }
  return `Speech synthesis failed (${status}): ${detail || text.slice(0, 200)}`;
}

/** gpt-4o-mini-tts ignores `speed`; pace can only be asked for in words. */
function paceInstruction(rate: number): string {
  if (!Number.isFinite(rate) || Math.abs(rate - 1) < 0.05) return 'Speak at a natural conversational pace.';
  if (rate >= 1.6) return 'Speak very quickly, noticeably faster than normal conversation, without dropping words.';
  if (rate >= 1.25) return 'Speak quickly, a bit faster than normal conversation.';
  if (rate > 1) return 'Speak at a brisk conversational pace.';
  if (rate <= 0.7) return 'Speak slowly and deliberately.';
  return 'Speak a little slower than normal conversation.';
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 1;
}
