/**
 * Adapter for Claudian's plugin API (YishenTu/claudian#1798, in Claudian 2.3.30 and later),
 * published as `app.plugins.getPlugin('realclaudian').api` with `version` 1.
 *
 * `send` resolves as soon as the text is accepted. The turn's end arrives as the workspace
 * event `claudian:turn-ended`, after which `read` returns the final reply as markdown. Final
 * answer only: no streaming partials and no composer access. Interrupt is `send` with
 * `mode: 'interrupt'` and no text.
 */
import type { App, EventRef } from 'obsidian';

import type { ClaudianBridge, SendOptions, TurnResult } from './bridge';
import { clearTimer, setTimer, type TimerId } from '../timers';

export const SUPPORTED_PLUGIN_API_VERSION = 1;
export const TURN_ENDED_EVENT = 'claudian:turn-ended';

export type SendMode = 'queue' | 'steer' | 'interrupt';
export type SendStatus = 'started' | 'queued' | 'steered' | 'uncertain' | 'interrupted' | 'idle';

export interface ClaudianPluginApi {
  readonly version: number;
  /** The session shown in the focused chat view, or null. */
  getActiveSessionId(): string | null;
  /** Delivers text as the user's own prompt; `interrupt` without text only stops the session. */
  send(sessionId: string, options: { text?: string; mode?: SendMode }): Promise<SendStatus>;
  /** The last finished turn's final reply as markdown; empty when no turn has finished. */
  read(sessionId: string): Promise<string>;
}

export interface TurnEndedEvent {
  sessionId: string;
}

/** The slice of `app.workspace` the bridge needs. Custom event names are not in Obsidian's typings. */
export interface TurnEventSource {
  on(name: string, callback: (event: TurnEndedEvent) => void): EventRef;
  offref(ref: EventRef): void;
}

/** Finds the plugin API on a Claudian plugin instance; null when it is absent or incomplete. */
export function pick(plugin: Record<string, unknown>): ClaudianPluginApi | null {
  const candidate = plugin.api as Partial<ClaudianPluginApi> | undefined;
  const complete = candidate !== undefined
    && typeof candidate.getActiveSessionId === 'function'
    && typeof candidate.send === 'function'
    && typeof candidate.read === 'function';
  return complete ? (candidate as ClaudianPluginApi) : null;
}

export function turnEventsOf(app: App): TurnEventSource {
  return app.workspace as unknown as TurnEventSource;
}

/** `read` returns one of these in place of text when the turn wrote nothing. */
const PLACEHOLDERS: Readonly<Record<string, TurnResult>> = {
  '(interrupted)': { text: '', outcome: 'interrupted' },
  '(error)': { text: 'The agent turn failed.', outcome: 'error' },
  '(no reply)': { text: '', outcome: 'completed' },
};

/** Safety net for a lost event. The turn itself keeps running in Claudian. */
const DEFAULT_REPLY_TIMEOUT_MS = 10 * 60 * 1000;

type TurnEnd = 'ended' | 'interrupted' | 'timeout';

interface TurnWatch {
  readonly ended: Promise<TurnEnd>;
  /** How many turn-ended events for this session belong to turns before and including ours. */
  expect(count: number): void;
  dispose(): void;
}

export class PluginApiBridge implements ClaudianBridge {
  readonly kind = 'plugin-api' as const;
  readonly supportsStreaming = false;
  readonly #replyTimeoutMs: number;

  constructor(
    private readonly api: ClaudianPluginApi,
    private readonly events: TurnEventSource,
    options: { replyTimeoutMs?: number } = {},
  ) {
    this.#replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  }

  getActiveSessionId(): string | null {
    return this.api.getActiveSessionId();
  }

  cancel(sessionId: string): void {
    void this.api.send(sessionId, { mode: 'interrupt' }).catch(() => undefined);
  }

  async send(sessionId: string, text: string, options: SendOptions): Promise<TurnResult> {
    const { signal } = options;
    if (signal.aborted) return { text: '', outcome: 'interrupted' };
    // Listen before sending so a turn that ends quickly cannot end unobserved.
    const turn = this.#watchTurn(sessionId, signal);
    let status: SendStatus;
    try {
      status = await this.api.send(sessionId, { text });
    } catch (error) {
      turn.dispose();
      return { text: error instanceof Error ? error.message : String(error), outcome: signal.aborted ? 'interrupted' : 'error' };
    }
    // `queued`: another turn is running and ends first; ours is the one after it.
    turn.expect(status === 'queued' ? 2 : 1);
    const ended = await turn.ended;
    if (ended === 'interrupted') return { text: '', outcome: 'interrupted' };
    if (ended === 'timeout') return { text: 'Timed out waiting for the reply.', outcome: 'error' };
    return this.#readReply(sessionId);
  }

  async #readReply(sessionId: string): Promise<TurnResult> {
    try {
      const text = (await this.api.read(sessionId)).trim();
      return PLACEHOLDERS[text] ?? { text, outcome: 'completed' };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), outcome: 'error' };
    }
  }

  /**
   * Counts `claudian:turn-ended` events for the session. Events seen before `expect` is called
   * still count, so an event that fires while `send` is in flight is not lost.
   */
  #watchTurn(sessionId: string, signal: AbortSignal): TurnWatch {
    let seen = 0;
    let expected: number | null = null;
    let done = false;
    let ref: EventRef | null = null;
    let timer: TimerId | null = null;
    let resolveEnded: (value: TurnEnd) => void = () => undefined;
    const ended = new Promise<TurnEnd>(resolve => { resolveEnded = resolve; });

    const finish = (value: TurnEnd) => {
      if (done) return;
      done = true;
      if (ref) this.events.offref(ref);
      clearTimer(timer);
      signal.removeEventListener('abort', onAbort);
      resolveEnded(value);
    };
    const onAbort = () => {
      this.cancel(sessionId);
      finish('interrupted');
    };
    const check = () => {
      if (expected !== null && seen >= expected) finish('ended');
    };

    signal.addEventListener('abort', onAbort, { once: true });
    ref = this.events.on(TURN_ENDED_EVENT, event => {
      if (event.sessionId !== sessionId) return;
      seen += 1;
      check();
    });
    timer = setTimer(() => finish('timeout'), this.#replyTimeoutMs);

    return {
      ended,
      expect: count => { expected = count; check(); },
      dispose: () => finish('interrupted'),
    };
  }
}
