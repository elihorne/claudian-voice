export interface RecognitionResult {
  text: string;
}

export interface ListenCallbacks {
  /** Microphone RMS level, for meters. */
  onLevel?: (rms: number) => void;
  /** Interim transcript of the utterance so far; only streaming engines call it. */
  onPartial?: (text: string) => void;
}

/** One utterance in, one transcript out. Engines own the microphone while `listen` is pending. */
export interface SpeechRecognizer {
  readonly id: 'whisper-http' | 'web-speech' | 'openai-realtime';
  /** Resolves with the transcript, or null when cancelled or nothing was heard. Rejects on engine failure. */
  listen(signal: AbortSignal, callbacks?: ListenCallbacks): Promise<RecognitionResult | null>;
  isAvailable(): boolean;
  /** Hold-to-talk release: stop capturing now and transcribe what was heard. */
  finish?(): void;
  /** Release long-lived resources (sockets, contexts) when the voice session ends. */
  dispose?(): void;
}

export interface Speaker {
  /** Enqueue text; returns a promise that resolves when it has finished playing or was cut. */
  speak(sentence: string): Promise<void>;
  /** Stop everything immediately and drop the queue. */
  cancel(): void;
  readonly isSpeaking: boolean;
  /** Current output RMS when the speaker plays through WebAudio; undefined when unknown. */
  getOutputLevel?(): number | undefined;
  /** Release audio resources. */
  dispose?(): void;
}
