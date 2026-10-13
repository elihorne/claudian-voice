import type { ClaudianApi, ClaudianChatHandle } from '../claudian/api';
import type { Speaker, SpeechRecognizer } from '../speech/types';
import { isCancelPhrase, SentenceCursor } from './speakable';

export type VoiceState =
  | { phase: 'idle' }
  | { phase: 'listening'; level: number }
  | { phase: 'transcribing' }
  | { phase: 'thinking'; tabId: string }
  | { phase: 'speaking'; tabId: string }
  | { phase: 'error'; message: string };

export interface VoiceSessionDeps {
  api: ClaudianApi;
  recognizer: SpeechRecognizer;
  speaker: Speaker;
  /** Continuous conversation: listen again after each reply. Off means one dictation. */
  isConversationMode: () => boolean;
  /** Speak replies at all; off makes this a dictation tool with auto-submit. */
  isSpeechEnabled: () => boolean;
  /** Insert the transcript into the composer instead of submitting directly. */
  shouldAutoSubmit: () => boolean;
  onState: (state: VoiceState) => void;
  /** Wait this long after the reply settles before listening again. */
  getTurnGapMs: () => number;
}

/**
 * The hands-free loop: listen, submit to the active Claudian tab, speak the reply as it
 * streams, then listen again. One session at a time; TTS is locked to the tab the prompt
 * went to, so background tabs never speak.
 */
export class VoiceSession {
  #running = false;
  #abort: AbortController | null = null;
  #unsubscribe: (() => void) | null = null;
  #state: VoiceState = { phase: 'idle' };

  constructor(private readonly deps: VoiceSessionDeps) {}

  get isRunning(): boolean {
    return this.#running;
  }

  get state(): VoiceState {
    return this.#state;
  }

  /** Start the loop. Resolves when the loop ends (stop, error, or single-shot completion). */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      do {
        const outcome = await this.#turn();
        if (outcome === 'stopped') break;
        if (outcome === 'turn-complete' && this.deps.isConversationMode()) {
          await sleep(this.deps.getTurnGapMs(), this.#abort?.signal);
        }
      } while (this.#running && this.deps.isConversationMode());
    } finally {
      this.#running = false;
      this.#cleanupTurn();
      if (this.#state.phase !== 'error') this.#setState({ phase: 'idle' });
    }
  }

  /** Stop listening and speaking. Does not cancel the agent's turn; that is the user's Stop in Claudian. */
  stop(): void {
    this.#running = false;
    this.#abort?.abort();
    this.deps.speaker.cancel();
  }

  /** Barge-in: the user wants to talk over the reply. Cuts audio and the agent's turn, then listens. */
  interrupt(): void {
    this.deps.speaker.cancel();
    const chat = this.deps.api.getActiveChat();
    if (chat?.isStreaming) chat.stop();
    this.#abort?.abort();
  }

  async #turn(): Promise<'turn-complete' | 'nothing-heard' | 'stopped'> {
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    try {
      this.#setState({ phase: 'listening', level: 0 });
      const heard = await this.deps.recognizer.listen(signal, level => {
        if (this.#state.phase === 'listening') this.#setState({ phase: 'listening', level });
      });
      if (!this.#running || signal.aborted) return 'stopped';
      if (!heard) return 'nothing-heard';
      if (isCancelPhrase(heard.text)) return 'nothing-heard';

      const chat = this.deps.api.getActiveChat();
      if (!chat) {
        this.#setState({ phase: 'error', message: 'No Claudian chat is open.' });
        return 'stopped';
      }

      if (!this.deps.shouldAutoSubmit()) {
        chat.appendText(heard.text);
        return 'turn-complete';
      }

      this.#setState({ phase: 'thinking', tabId: chat.tabId });
      const spoken = this.deps.isSpeechEnabled() ? this.#speakReply(chat, signal) : Promise.resolve();
      await chat.submit(heard.text);
      await spoken;
      return signal.aborted ? 'stopped' : 'turn-complete';
    } catch (error) {
      if (signal.aborted) return 'stopped';
      this.#setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
      return 'stopped';
    } finally {
      this.#cleanupTurn();
    }
  }

  /**
   * Resolves when the tab's turn has settled and every queued sentence has been spoken.
   * Subscribes before submit so the first chunk is never missed.
   */
  #speakReply(chat: ClaudianChatHandle, signal: AbortSignal): Promise<void> {
    const cursor = new SentenceCursor();
    const tabId = chat.tabId;
    let queue: Promise<void> = Promise.resolve();
    let sawStreaming = false;
    let lastText = '';

    const enqueue = (sentences: string[]) => {
      for (const sentence of sentences) {
        queue = queue.then(() => (signal.aborted ? undefined : this.deps.speaker.speak(sentence)));
      }
      if (sentences.length > 0 && this.#state.phase !== 'speaking') this.#setState({ phase: 'speaking', tabId });
    };

    return new Promise<void>(resolve => {
      const finish = () => {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        enqueue(cursor.flush());
        void queue.then(() => resolve());
      };
      const onAbort = () => { this.deps.speaker.cancel(); finish(); };
      signal.addEventListener('abort', onAbort, { once: true });

      this.#unsubscribe = chat.subscribe(() => {
        if (signal.aborted) return;
        if (chat.isStreaming) sawStreaming = true;
        const activity = chat.activity;
        if (activity?.kind === 'text' && activity.text !== lastText) {
          lastText = activity.text;
          enqueue(cursor.push(activity.text));
        }
        if (sawStreaming && !chat.isStreaming) {
          signal.removeEventListener('abort', onAbort);
          finish();
        }
      });
    });
  }

  #cleanupTurn(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#abort = null;
  }

  #setState(state: VoiceState): void {
    this.#state = state;
    this.deps.onState(state);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
