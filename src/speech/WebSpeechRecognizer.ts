import type { RecognitionResult, SpeechRecognizer } from './types';

/* Minimal typings for the prefixed Web Speech API, which lib.dom does not ship. */
interface SpeechRecognitionAlternativeLike { transcript: string }
interface SpeechRecognitionResultLike { readonly isFinal: boolean; 0: SpeechRecognitionAlternativeLike }
interface SpeechRecognitionEventLike { results: ArrayLike<SpeechRecognitionResultLike> }
interface SpeechRecognitionErrorLike { error: string }
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Chromium's built-in recogniser. Under Electron it usually fails with a `network`
 * error because the Google speech keys are not bundled, so this engine is opt-in and
 * reports that failure clearly instead of hanging.
 */
export class WebSpeechRecognizer implements SpeechRecognizer {
  readonly id = 'web-speech' as const;

  constructor(private readonly getLanguage: () => string) {}

  isAvailable(): boolean {
    return typeof window !== 'undefined' && getCtor() !== null;
  }

  listen(signal: AbortSignal): Promise<RecognitionResult | null> {
    const Ctor = getCtor();
    if (!Ctor) return Promise.reject(new Error('Web Speech API is not available in this Obsidian build.'));
    return new Promise((resolve, reject) => {
      const recognition = new Ctor();
      recognition.continuous = false;
      recognition.interimResults = false;
      const language = this.getLanguage();
      if (language) recognition.lang = language;
      let transcript = '';
      let failed: Error | null = null;
      recognition.onresult = event => {
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result?.isFinal) transcript += result[0].transcript;
        }
      };
      recognition.onerror = event => {
        if (event.error === 'aborted' || event.error === 'no-speech') return;
        failed = new Error(event.error === 'network'
          ? 'Web Speech recognition is not supported in this Obsidian build (network error). Use the Whisper HTTP engine.'
          : `Speech recognition error: ${event.error}`);
      };
      recognition.onend = () => {
        signal.removeEventListener('abort', onAbort);
        if (failed) reject(failed);
        else resolve(transcript.trim() ? { text: transcript.trim() } : null);
      };
      const onAbort = () => recognition.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      recognition.start();
    });
  }
}
