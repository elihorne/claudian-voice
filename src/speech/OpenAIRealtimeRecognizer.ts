import { floatToPcm16, pcm16ToBase64, resample, rootMeanSquare } from './pcm';
import type { ListenCallbacks, RecognitionResult, SpeechRecognizer } from './types';
import { isLikelyHallucination } from './WhisperHttpRecognizer';

export interface RealtimeOptions {
  getApiKey: () => string;
  /** e.g. gpt-4o-mini-transcribe or gpt-4o-transcribe */
  getModel: () => string;
  getLanguage: () => string;
  /** Vocabulary and style hint; proper nouns from the glossary go here. */
  getPrompt: () => string;
  /** Trailing silence the server treats as end of utterance. */
  getSilenceMs: () => number;
  /** Give up on a listen with no speech after this long. */
  getNoSpeechTimeoutMs: () => number;
  /** Server VAD sensitivity 0..1; higher needs louder speech. Only used when semantic VAD is off. */
  getVadThreshold: () => number;
  /** Default true: let the model judge when you have finished speaking. */
  useSemanticVad?: () => boolean;
  /** How quickly semantic VAD commits a turn. */
  getEagerness?: () => 'low' | 'medium' | 'high' | 'auto';
  /** Log every socket event to the console. */
  isDebug?: () => boolean;
}

const SOCKET_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const TARGET_RATE = 24000;
/** How much idle audio to retain, and how much of it to send ahead of live audio. */
const PREROLL_SAMPLES = TARGET_RATE; // 1s
const PREROLL_SEND_MS = 700;
const MAX_RECONNECTS = 3;

/**
 * Streaming speech-to-text over OpenAI's Realtime API in transcription mode. Audio goes up
 * as 24kHz pcm16 while you talk; interim text comes back within a few hundred ms, and the
 * server's voice-activity detector decides when the utterance is over, so there is no
 * client-side silence wait and no upload step. The socket and microphone stay open for the
 * whole voice session so repeat turns pay no connection cost.
 */
export class OpenAIRealtimeRecognizer implements SpeechRecognizer {
  readonly id = 'openai-realtime' as const;
  #socket: WebSocket | null = null;
  #ready: Promise<void> | null = null;
  #stream: MediaStream | null = null;
  #context: AudioContext | null = null;
  #processor: ScriptProcessorNode | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #sending = false;
  #listeners = new Set<(event: RealtimeEvent) => void>();
  #onLevel: ((rms: number) => void) | null = null;
  #reconnects = 0;
  /** Recent mic audio kept while idle, so a reply that starts during the handover is not clipped. */
  #preroll: Int16Array[] = [];
  #prerollSamples = 0;

  constructor(private readonly options: RealtimeOptions) {}

  isAvailable(): boolean {
    return typeof WebSocket !== 'undefined'
      && typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia
      && this.options.getApiKey().trim().length > 0;
  }

  async listen(signal: AbortSignal, callbacks: ListenCallbacks = {}): Promise<RecognitionResult | null> {
    await this.#ensureConnected();
    await this.#ensureMicrophone();
    if (signal.aborted) return null;
    this.#onLevel = callbacks.onLevel ?? null;

    return new Promise<RecognitionResult | null>((resolve, reject) => {
      let partial = '';
      let speechStartedAt: number | null = null;
      let speechMs = 0;
      let settled = false;
      const settle = (value: RecognitionResult | null, error?: Error) => {
        if (settled) return;
        settled = true;
        this.#sending = false;
        // Reset the server's VAD state so the next listen does not inherit a half-open turn.
        this.#send({ type: 'input_audio_buffer.clear' });
        this.#onLevel = null;
        this.#listeners.delete(onEvent);
        signal.removeEventListener('abort', onAbort);
        clearTimeout(noSpeechTimer);
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => settle(null);
      const noSpeechTimer = setTimeout(() => {
        if (speechStartedAt === null && !partial) settle(null);
      }, this.options.getNoSpeechTimeoutMs());

      const onEvent = (event: RealtimeEvent) => {
        this.#log(event.type, event.type.includes('delta') ? event.delta : event.transcript ?? event.error ?? '');
        switch (event.type) {
          case 'input_audio_buffer.speech_started':
            speechStartedAt = performance.now();
            break;
          case 'input_audio_buffer.speech_stopped':
            if (speechStartedAt !== null) speechMs += performance.now() - speechStartedAt;
            speechStartedAt = null;
            break;
          case 'conversation.item.input_audio_transcription.delta':
            partial += event.delta ?? '';
            callbacks.onPartial?.(partial);
            break;
          case 'conversation.item.input_audio_transcription.completed': {
            const text = (event.transcript ?? partial).trim();
            // `completed` can land before `speech_stopped`; count speech still in progress.
            // The server's own VAD gated this audio, so short answers ("yes", "do that") are real.
            if (!text || isLikelyHallucination({ text }, this.options.getLanguage(), false)) {
              this.#log('dropped transcript', { text });
              // Noise or a phantom phrase: keep listening within the same call.
              partial = '';
              speechMs = 0;
              callbacks.onPartial?.('');
              return;
            }
            settle({ text });
            break;
          }
          case 'claudian.reconnected':
            partial = '';
            callbacks.onPartial?.('');
            break;
          case 'conversation.item.input_audio_transcription.failed':
            settle(null, new Error(event.error?.message ?? 'Transcription failed'));
            break;
          case 'error':
            settle(null, new Error(event.error?.message ?? 'Realtime transcription error'));
            break;
          default:
            break;
        }
      };

      signal.addEventListener('abort', onAbort, { once: true });
      this.#listeners.add(onEvent);
      this.#flushPreroll();
      this.#sending = true;
      this.#log('listening', { socket: this.#socket?.readyState, context: this.#context?.state });
    });
  }

  /** Commit the buffered audio; the server transcribes it without waiting for VAD. */
  finish(): void {
    if (this.#sending) this.#send({ type: 'input_audio_buffer.commit' });
  }

  dispose(): void {
    this.#sending = false;
    this.#processor?.disconnect();
    this.#source?.disconnect();
    this.#processor = null;
    this.#source = null;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    void this.#context?.close().catch(() => undefined);
    this.#context = null;
    this.#socket?.close();
    this.#socket = null;
    this.#ready = null;
    this.#listeners.clear();
  }

  #ensureConnected(): Promise<void> {
    if (this.#socket && this.#socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.#ready) return this.#ready;
    this.#ready = new Promise<void>((resolve, reject) => {
      const key = this.options.getApiKey().trim();
      // Browser WebSockets cannot set headers; OpenAI accepts the key as a subprotocol.
      const socket = new WebSocket(SOCKET_URL, ['realtime', `openai-insecure-api-key.${key}`, 'openai-beta.realtime-v1']);
      let opened = false;
      socket.onopen = () => {
        opened = true;
        this.#socket = socket;
        this.#configure();
        resolve();
      };
      // A healthy connection for a while earns the reconnect budget back.
      setTimeout(() => { if (this.#socket === socket) this.#reconnects = 0; }, 60000);
      socket.onmessage = message => {
        try {
          const event = JSON.parse(String(message.data)) as RealtimeEvent;
          for (const listener of this.#listeners) listener(event);
        } catch { /* ignore malformed frames */ }
      };
      socket.onerror = () => {
        if (!opened) reject(new Error('Could not connect to OpenAI realtime transcription. Check the API key and network.'));
      };
      socket.onclose = event => {
        this.#socket = null;
        this.#ready = null;
        if (!opened) { reject(new Error(`Realtime socket closed before opening (${event.code}).`)); return; }
        this.#log('socket closed', event.code);
        // Sessions have a fixed lifetime and idle timeouts. If we were mid-listen, reconnect
        // transparently; the in-flight utterance restarts rather than ending the voice session.
        if (this.#sending && this.#reconnects < MAX_RECONNECTS) {
          this.#reconnects += 1;
          void this.#ensureConnected().then(() => {
            this.#log('reconnected');
            const resumed: RealtimeEvent = { type: 'claudian.reconnected' };
            for (const listener of this.#listeners) listener(resumed);
          }).catch(error => {
            const failed: RealtimeEvent = { type: 'error', error: { message: `Transcription connection lost (${error instanceof Error ? error.message : String(error)})` } };
            for (const listener of this.#listeners) listener(failed);
          });
          return;
        }
        const closed: RealtimeEvent = { type: 'error', error: { message: `Transcription connection closed (${event.code})` } };
        if (this.#sending) for (const listener of this.#listeners) listener(closed);
      };
    });
    return this.#ready;
  }

  #configure(): void {
    const language = this.options.getLanguage().trim();
    const prompt = this.options.getPrompt().trim();
    this.#send({
      type: 'transcription_session.update',
      session: {
        input_audio_format: 'pcm16',
        input_audio_transcription: {
          model: this.options.getModel() || 'gpt-4o-mini-transcribe',
          ...(language ? { language } : {}),
          ...(prompt ? { prompt } : {}),
        },
        // Semantic VAD ends the turn when you sound finished, not after a fixed silence, so a
        // mid-thought pause does not cut you off and a complete short sentence sends at once.
        turn_detection: this.options.useSemanticVad?.() === false
          ? {
            type: 'server_vad',
            threshold: this.options.getVadThreshold(),
            prefix_padding_ms: 300,
            silence_duration_ms: this.options.getSilenceMs(),
          }
          : { type: 'semantic_vad', eagerness: this.options.getEagerness?.() ?? 'medium' },
        input_audio_noise_reduction: { type: 'near_field' },
      },
    });
  }

  async #ensureMicrophone(): Promise<void> {
    if (this.#stream && this.#context && this.#processor) return;
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    // Unplugging or switching input devices ends the track; drop our graph so the next listen rebuilds it.
    for (const track of this.#stream.getTracks()) {
      track.onended = () => {
        this.#log('microphone track ended; will reacquire');
        this.#processor?.disconnect();
        this.#source?.disconnect();
        this.#processor = null;
        this.#source = null;
        void this.#context?.close().catch(() => undefined);
        this.#context = null;
        this.#stream = null;
        if (this.#sending) void this.#ensureMicrophone().catch(() => undefined);
      };
    }
    const context = new AudioContext();
    this.#context = context;
    this.#source = context.createMediaStreamSource(this.#stream);
    // ScriptProcessor is deprecated but needs no worklet file, which a bundled plugin cannot ship easily.
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = event => {
      const input = event.inputBuffer.getChannelData(0);
      this.#onLevel?.(rootMeanSquare(input));
      const pcm = floatToPcm16(resample(input, context.sampleRate, TARGET_RATE));
      if (!this.#sending) {
        this.#preroll.push(pcm);
        this.#prerollSamples += pcm.length;
        while (this.#prerollSamples > PREROLL_SAMPLES && this.#preroll.length > 1) {
          this.#prerollSamples -= this.#preroll.shift()?.length ?? 0;
        }
        return;
      }
      if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
      this.#send({ type: 'input_audio_buffer.append', audio: pcm16ToBase64(pcm) });
    };
    this.#source.connect(processor);
    // A ScriptProcessor only runs while connected to the graph; a silent gain keeps it alive without playback.
    const mute = context.createGain();
    mute.gain.value = 0;
    processor.connect(mute).connect(context.destination);
    this.#processor = processor;
  }

  /** Send the tail of what the mic heard while we were not listening, then start live. */
  #flushPreroll(): void {
    if (this.#preroll.length === 0) return;
    // Keep only the most recent PREROLL_SEND_MS; older audio is the agent's own voice.
    let budget = Math.round(TARGET_RATE * PREROLL_SEND_MS / 1000);
    const chunks: Int16Array[] = [];
    for (let index = this.#preroll.length - 1; index >= 0 && budget > 0; index -= 1) {
      const chunk = this.#preroll[index];
      if (!chunk) continue;
      chunks.unshift(chunk.length > budget ? chunk.subarray(chunk.length - budget) : chunk);
      budget -= chunk.length;
    }
    for (const chunk of chunks) this.#send({ type: 'input_audio_buffer.append', audio: pcm16ToBase64(chunk) });
    this.#log('preroll flushed', { ms: Math.round(chunks.reduce((sum, c) => sum + c.length, 0) / TARGET_RATE * 1000) });
    this.#preroll = [];
    this.#prerollSamples = 0;
  }

  #log(message: string, detail?: unknown): void {
    if (this.options.isDebug?.()) console.debug(`[claudian-voice] ${message}`, detail ?? '');
  }

  #send(payload: Record<string, unknown>): void {
    if (payload.type !== 'input_audio_buffer.append') this.#log(`send ${String(payload.type)}`);
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(payload));
  }
}

interface RealtimeEvent {
  type: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
}
