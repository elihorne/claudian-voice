import type { SpeechRecognizer } from '../speech/types';
import type { VoiceState } from './VoiceSession';

export interface HoldToTalkDeps {
  recognizer: SpeechRecognizer;
  onState: (state: VoiceState) => void;
  cue?: (kind: 'start' | 'listen' | 'stop' | 'error') => Promise<void>;
}

/**
 * Press-and-hold capture: the hotkey's keydown starts listening, its keyup finishes the
 * utterance and resolves with the transcript. Obsidian delivers the command on keydown
 * (and repeats while held); we watch the document for the matching keyup ourselves.
 */
export class HoldToTalk {
  #active: { abort: AbortController; done: Promise<string | null>; key: string } | null = null;

  constructor(private readonly deps: HoldToTalkDeps) {}

  get isActive(): boolean {
    return this.#active !== null;
  }

  /**
   * Called from the command's callback. The first call starts capture; repeats while the key
   * is held are ignored. Resolves when the key is released, with the transcript.
   */
  async press(releaseKey: string): Promise<string | null> {
    if (this.#active) return this.#active.done;
    const abort = new AbortController();
    const key = releaseKey.toLowerCase();
    const onKeyUp = (event: KeyboardEvent) => {
      // Releasing either the key itself or a modifier ends the hold.
      const released = event.key.toLowerCase();
      if (released === key || released === 'meta' || released === 'control' || released === 'alt' || released === 'shift') {
        this.deps.recognizer.finish?.();
        document.removeEventListener('keyup', onKeyUp, true);
        window.removeEventListener('blur', onBlur);
      }
    };
    const onBlur = () => { this.deps.recognizer.finish?.(); };
    document.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);

    const done = (async () => {
      try {
        void this.deps.cue?.('listen');
        this.deps.onState({ phase: 'listening', level: 0, transcript: '' });
        const heard = await this.deps.recognizer.listen(abort.signal, {
          onLevel: level => this.deps.onState({ phase: 'listening', level, transcript: this.#transcript }),
          onPartial: transcript => { this.#transcript = transcript; this.deps.onState({ phase: 'listening', level: 0, transcript }); },
        });
        return heard?.text ?? null;
      } catch (error) {
        this.deps.onState({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
        return null;
      } finally {
        document.removeEventListener('keyup', onKeyUp, true);
        window.removeEventListener('blur', onBlur);
        this.#transcript = '';
        this.#active = null;
        this.deps.onState({ phase: 'idle' });
        this.deps.recognizer.dispose?.();
      }
    })();
    this.#active = { abort, done, key };
    return done;
  }

  cancel(): void {
    this.#active?.abort.abort();
  }

  #transcript = '';
}
