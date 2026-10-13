import { requestUrl } from 'obsidian';

import type { RecognitionResult, SpeechRecognizer } from './types';

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
}

/**
 * Records one utterance with MediaRecorder, ends it on trailing silence, and posts it to
 * an OpenAI-compatible `/v1/audio/transcriptions` endpoint (OpenAI, Groq, local
 * faster-whisper or whisper.cpp servers all accept this shape).
 */
export class WhisperHttpRecognizer implements SpeechRecognizer {
  readonly id = 'whisper-http' as const;

  constructor(private readonly options: WhisperHttpOptions) {}

  isAvailable(): boolean {
    return typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia
      && typeof MediaRecorder !== 'undefined'
      && this.options.getEndpoint().trim().length > 0;
  }

  async listen(signal: AbortSignal, onLevel?: (rms: number) => void): Promise<RecognitionResult | null> {
    const audio = await this.#record(signal, onLevel);
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
    const threshold = this.options.getSilenceThreshold();
    const started = performance.now();
    let lastVoice = 0;
    let heardSpeech = false;

    const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
    recorder.start(250);

    const finish = await new Promise<'speech' | 'silence' | 'aborted'>(resolve => {
      const tick = () => {
        if (signal.aborted) return resolve('aborted');
        analyser.getFloatTimeDomainData(samples);
        const rms = rootMeanSquare(samples);
        onLevel?.(rms);
        const now = performance.now();
        if (rms > threshold) {
          heardSpeech = true;
          lastVoice = now;
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

    if (finish !== 'speech') return null;
    return new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
  }

  async #transcribe(audio: Blob): Promise<string> {
    const boundary = `----claudian-voice-${Date.now().toString(16)}`;
    const extension = audio.type.includes('ogg') ? 'ogg' : audio.type.includes('mp4') ? 'm4a' : 'webm';
    const fields: Array<[string, string]> = [['model', this.options.getModel() || 'whisper-1']];
    const language = this.options.getLanguage().trim();
    if (language) fields.push(['language', language]);
    fields.push(['response_format', 'json']);

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
    const payload = response.json as { text?: unknown };
    return typeof payload.text === 'string' ? payload.text.trim() : '';
  }
}

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
