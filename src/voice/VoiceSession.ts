import type { ClaudianBridge, TurnResult } from '../claudian/bridge';
import type { Speaker, SpeechRecognizer } from '../speech/types';
import { type LocalVerb, parseLocalVerb } from './LocalVerbs';
import { isCancelPhrase, SentenceCursor } from './speakable';
import { clearTimer, setTimer, type TimerId } from '../timers';

/** Watches the mic while the agent speaks; resolves true when the user talks over it. */
export interface BargeInWatcher {
  watch(signal: AbortSignal): Promise<boolean>;
}

export type VoiceState =
  | { phase: 'idle' }
  | { phase: 'listening'; level: number; transcript: string }
  | { phase: 'transcribing' }
  | { phase: 'thinking'; sessionId: string }
  | { phase: 'speaking'; sessionId: string }
  | { phase: 'error'; message: string };

export interface VoiceSessionDeps {
  bridge: ClaudianBridge;
  recognizer: SpeechRecognizer;
  speaker: Speaker;
  /** Continuous conversation: listen again after each reply. Off means one dictation. */
  isConversationMode: () => boolean;
  /** Speak replies at all; off makes this a dictation tool with auto-submit. */
  isSpeechEnabled: () => boolean;
  /** Insert the transcript into the composer instead of submitting directly. */
  shouldAutoSubmit: () => boolean;
  /** Appended to spoken prompts so the agent answers at conversational length. */
  getPromptSuffix: () => string;
  /** Has this conversation already received the spoken-length hint? Owned by the plugin so it survives restarts. */
  hasHinted: (sessionId: string) => boolean;
  markHinted: (sessionId: string) => void;
  /** Context to prepend to the transcript (e.g. a wikilink to the active note); empty when none. */
  getContextPrefix?: (sessionId: string) => string;
  /** Handles an utterance inside Obsidian without the agent. Returns a short spoken confirmation, or null if unhandled. */
  handleLocalVerb?: (verb: LocalVerb) => Promise<string | null>;
  onState: (state: VoiceState) => void;
  /** Wait this long after the reply settles before listening again. */
  getTurnGapMs: () => number;
  /** Present when voice barge-in is enabled; null means interrupt only by command. */
  bargeIn?: BargeInWatcher | null;
  /** Audible state cues; each resolves when the cue has finished playing. */
  cue?: (kind: 'start' | 'listen' | 'stop' | 'error') => Promise<void>;
  /** Spoken while the agent works without producing text; null disables. */
  getProgressPhrases?: () => { first: string; again: string; firstAfterMs: number; everyMs: number } | null;
  /** End the session after this long with nothing heard (streaming audio is billed while idle). 0 disables. */
  getIdleStopMs?: () => number;
}

type TurnOutcome = 'turn-complete' | 'nothing-heard' | 'stopped';

/** Hold speech until at least this much text has accumulated, unless the turn is over. */
const MIN_UTTERANCE_CHARS = 60;
/** Start the first utterance at a clause break once this much of a long opening sentence exists. */
const FIRST_CLAUSE_CHARS = 50;

/**
 * The hands-free loop: listen, send to the active Claudian session, speak the reply, then
 * listen again. Speech streams sentence by sentence when the bridge supports it and is
 * spoken whole otherwise. One session at a time; speech is locked to the session the
 * prompt went to, so a background tab finishing a turn never speaks.
 */
export class VoiceSession {
  #running = false;
  #abort: AbortController | null = null;
  #state: VoiceState = { phase: 'idle' };
  #activeSessionId: string | null = null;
  /** Set by interrupt(): the current turn is being cut short to listen again, not to stop. */
  #interrupted = false;

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
    let firstTurn = true;
    let idleSince = performance.now();
    try {
      await this.deps.cue?.('start');
      do {
        // The tick plays over the start of listening; waiting for it would clip a quick reply.
        if (!firstTurn && this.#running) void this.deps.cue?.('listen');
        firstTurn = false;
        const outcome = await this.#turn();
        if (outcome === 'stopped') break;
        if (outcome === 'nothing-heard') {
          const idleStopMs = this.deps.getIdleStopMs?.() ?? 0;
          if (idleStopMs > 0 && performance.now() - idleSince > idleStopMs) break;
        } else {
          idleSince = performance.now();
        }
        if (outcome === 'turn-complete' && this.deps.isConversationMode()) {
          await sleep(this.deps.getTurnGapMs(), this.#abort?.signal);
        }
        // An interruption always listens again, even in single-shot mode: the user just spoke.
      } while (this.#running && (this.deps.isConversationMode() || this.#interrupted));
    } finally {
      this.#running = false;
      this.#abort = null;
      this.deps.recognizer.dispose?.();
      const errored = this.#state.phase === 'error';
      if (!errored) this.#setState({ phase: 'idle' });
      void this.deps.cue?.(errored ? 'error' : 'stop');
    }
  }

  /** Stop listening and speaking. The agent's turn, if any, is cancelled too. */
  stop(): void {
    this.#running = false;
    this.#abort?.abort();
    this.deps.speaker.cancel();
  }

  /** Barge-in: the user wants to talk over the reply. Cuts audio and the agent's turn, then listens. */
  interrupt(): void {
    if (!this.#running) return;
    this.#interrupted = true;
    this.deps.speaker.cancel();
    if (this.#activeSessionId) this.deps.bridge.cancel(this.#activeSessionId);
    this.#abort?.abort();
  }

  async #turn(): Promise<TurnOutcome> {
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.#interrupted = false;
    const outcome = await this.#runTurn(signal);
    this.#abort = null;
    // An interrupted turn is not a stopped session: fall through to the next listen.
    if (outcome === 'stopped' && this.#interrupted && this.#running) return 'nothing-heard';
    return outcome;
  }

  async #runTurn(signal: AbortSignal): Promise<TurnOutcome> {
    try {
      this.#setState({ phase: 'listening', level: 0, transcript: '' });
      const heard = await this.deps.recognizer.listen(signal, {
        onLevel: level => {
          if (this.#state.phase === 'listening') this.#setState({ ...this.#state, level });
        },
        onPartial: transcript => {
          if (this.#state.phase === 'listening') this.#setState({ ...this.#state, transcript });
        },
      });
      if (!this.#running || signal.aborted) return 'stopped';
      if (!heard || isCancelPhrase(heard.text)) return 'nothing-heard';

      // Capture, read-aloud and the like never need the agent; answer them here in milliseconds.
      const verb = this.deps.handleLocalVerb ? parseLocalVerb(heard.text) : null;
      if (verb && this.deps.handleLocalVerb) {
        const confirmation = await this.deps.handleLocalVerb(verb);
        if (confirmation !== null) {
          if (confirmation && this.deps.isSpeechEnabled()) await this.deps.speaker.speak(confirmation);
          return 'turn-complete';
        }
      }

      const sessionId = this.deps.bridge.getActiveSessionId();
      if (!sessionId) {
        this.#setState({ phase: 'error', message: 'No Claudian chat is open.' });
        return 'stopped';
      }
      this.#activeSessionId = sessionId;

      if (!this.deps.shouldAutoSubmit()) {
        if (!this.deps.bridge.appendText?.(sessionId, heard.text)) {
          // No composer access on this API: sending is the only option.
          await this.#sendAndSpeak(sessionId, heard.text, signal);
        }
        return signal.aborted ? 'stopped' : 'turn-complete';
      }

      await this.#sendAndSpeak(sessionId, heard.text, signal);
      if (signal.aborted) return 'stopped';
      return this.#state.phase === 'error' ? 'stopped' : 'turn-complete';
    } catch (error) {
      if (signal.aborted) return 'stopped';
      this.#setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
      return 'stopped';
    } finally {
      this.#activeSessionId = null;
    }
  }

  /** Sends the prompt and speaks the reply, streaming or whole, until both have finished. */
  async #sendAndSpeak(sessionId: string, transcript: string, signal: AbortSignal): Promise<void> {
    const { bridge, speaker } = this.deps;
    const speak = this.deps.isSpeechEnabled();
    const suffix = this.deps.getPromptSuffix().trim();
    // The hint goes out once per conversation; the agent keeps it in context afterwards.
    const includeHint = speak && suffix && !this.deps.hasHinted(sessionId);
    if (includeHint) this.deps.markHinted(sessionId);
    const prefix = this.deps.getContextPrefix?.(sessionId) ?? '';
    const body = prefix ? `${prefix}${transcript}` : transcript;
    const prompt = includeHint ? `${body}\n\n${suffix}` : body;

    this.#setState({ phase: 'thinking', sessionId });
    this.#watchForBargeIn(signal);

    const cursor = new SentenceCursor();
    const spoken: Promise<void>[] = [];
    let heardReply = false;
    // Very short fragments are held for the next sentence: one request per clause makes
    // some voices drift between calls and chops the prosody.
    let held = '';
    const flushHeld = () => {
      if (!held || signal.aborted) return;
      spoken.push(speaker.speak(held));
      held = '';
    };
    let spokenAnything = false;
    const enqueue = (sentences: string[], final = false) => {
      if (signal.aborted) return;
      if (sentences.length > 0) {
        heardReply = true;
        held = [held, ...sentences].filter(Boolean).join(' ');
        if (this.#state.phase !== 'speaking') this.#setState({ phase: 'speaking', sessionId });
      }
      // The first words go out as soon as one sentence is complete; later chunks are batched a little.
      const threshold = spokenAnything ? MIN_UTTERANCE_CHARS : 1;
      if (held.length >= threshold || final) {
        if (held) spokenAnything = true;
        flushHeld();
      }
    };
    // If the opening sentence runs long, start speaking at a clause break instead of waiting for it.
    const earlyStart = () => {
      if (spokenAnything || signal.aborted) return;
      const clause = cursor.takeLeadingClause(FIRST_CLAUSE_CHARS);
      if (clause) enqueue([clause]);
    };

    // Long tool-heavy turns are silent until the agent writes; say so rather than leave dead air.
    const progress = speak ? this.deps.getProgressPhrases?.() ?? null : null;
    let progressTimer: TimerId | null = null;
    const scheduleProgress = (delay: number, phrase: string) => {
      if (!progress) return;
      progressTimer = setTimer(() => {
        if (signal.aborted || heardReply) return;
        void speaker.speak(phrase);
        scheduleProgress(progress.everyMs, progress.again);
      }, delay);
    };
    scheduleProgress(progress?.firstAfterMs ?? 0, progress?.first ?? '');
    const clearProgress = () => { clearTimer(progressTimer); progressTimer = null; };

    const aborted = new Promise<TurnResult>(resolve => {
      signal.addEventListener('abort', () => resolve({ text: '', outcome: 'interrupted' }), { once: true });
    });
    const result = await Promise.race([
      bridge.send(sessionId, prompt, {
        signal,
        onPartial: speak && bridge.supportsStreaming ? partial => { enqueue(cursor.push(partial)); earlyStart(); } : undefined,
      }),
      aborted,
    ]);
    clearProgress();

    if (signal.aborted || result.outcome === 'interrupted') return;
    if (result.outcome === 'error') {
      this.#setState({ phase: 'error', message: result.text || 'The agent turn failed.' });
      return;
    }
    if (speak) {
      if (!bridge.supportsStreaming) enqueue(cursor.push(result.text));
      enqueue(cursor.flush(), true);
      await Promise.race([Promise.allSettled(spoken), aborted]);
    }
  }

  /** Runs the barge-in monitor for the life of this turn; a hit becomes interrupt(). */
  #watchForBargeIn(signal: AbortSignal): void {
    const watcher = this.deps.bargeIn;
    if (!watcher || !this.deps.isSpeechEnabled()) return;
    void watcher.watch(signal).then(bargedIn => {
      if (bargedIn && !signal.aborted) this.interrupt();
    }).catch(() => undefined); // mic unavailable: fall back to command-only interrupt
  }

  #setState(state: VoiceState): void {
    this.#state = state;
    this.deps.onState(state);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimer(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimer(timer); resolve(); }, { once: true });
  });
}
