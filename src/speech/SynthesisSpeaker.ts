import type { Speaker } from './types';

export interface SynthesisSpeakerOptions {
  getVoiceName: () => string;
  getRate: () => number;
  getLanguage: () => string;
}

/** Speech output through the browser's speechSynthesis, which uses OS voices under Electron. */
export class SynthesisSpeaker implements Speaker {
  #active = 0;

  constructor(private readonly options: SynthesisSpeakerOptions) {}

  static isSupported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  get isSpeaking(): boolean {
    return this.#active > 0;
  }

  speak(sentence: string): Promise<void> {
    const text = sentence.trim();
    if (!text || !SynthesisSpeaker.isSupported()) return Promise.resolve();
    this.#active += 1;
    return new Promise<void>(resolve => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = clamp(this.options.getRate(), 0.5, 2);
      const language = this.options.getLanguage();
      if (language) utterance.lang = language;
      const voiceName = this.options.getVoiceName();
      if (voiceName) {
        const voice = window.speechSynthesis.getVoices().find(candidate => candidate.name === voiceName);
        if (voice) utterance.voice = voice;
      }
      const done = () => {
        this.#active = Math.max(0, this.#active - 1);
        resolve();
      };
      utterance.onend = done;
      utterance.onerror = done;
      window.speechSynthesis.speak(utterance);
    });
  }

  cancel(): void {
    if (!SynthesisSpeaker.isSupported()) return;
    // cancel() fires onerror/onend for queued utterances, which releases the counters.
    window.speechSynthesis.cancel();
  }

  static listVoices(): SpeechSynthesisVoice[] {
    return SynthesisSpeaker.isSupported() ? window.speechSynthesis.getVoices() : [];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 1;
}
