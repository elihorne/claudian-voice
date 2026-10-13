export interface RecognitionResult {
  text: string;
}

/** One utterance in, one transcript out. Engines own the microphone while `listen` is pending. */
export interface SpeechRecognizer {
  readonly id: 'whisper-http' | 'web-speech';
  /** Resolves with the transcript, or null when cancelled or nothing was heard. Rejects on engine failure. */
  listen(signal: AbortSignal, onLevel?: (rms: number) => void): Promise<RecognitionResult | null>;
  isAvailable(): boolean;
}

export interface Speaker {
  /** Enqueue a sentence; returns a promise that resolves when it has finished playing or was cut. */
  speak(sentence: string): Promise<void>;
  /** Stop everything immediately and drop the queue. */
  cancel(): void;
  readonly isSpeaking: boolean;
}
