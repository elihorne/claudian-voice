/**
 * Adapter for Claudian's session-addressed API (YishenTu/claudian#1611, groundwork in #1623).
 *
 * Two shapes are handled, because the maintainer's sketch and the shipped internals differ:
 *
 *   A. `send(sessionId, text)` resolves when the turn ends with `{ text, outcome }`.
 *   B. `send(sessionId, text)` returns `{ sessionId, status: 'started' | 'queued' }` at once
 *      (the #1623 shape); the turn's end is observed via a `turn-ended` event when one exists,
 *      or by polling `readSession` until a new completed turn appears, and the final reply is
 *      read from the transcript.
 *
 * Final answer only, no streaming. The property name on the plugin instance and the exact
 * method names are experimental; `pick()` is the only place that knows them.
 */
import type { ClaudianBridge, SendOptions, TurnResult } from './bridge';
import { clearTimer, setTimer } from '../timers';

export const SUPPORTED_SESSION_API_VERSION = 1;

/** Shape A result. */
interface ImmediateResult { text: string; outcome: 'completed' | 'interrupted' | 'error' }
/** Shape B result. */
interface AcceptedResult { sessionId: string; status: 'started' | 'queued'; title?: string }

export interface SessionTranscript {
  sessionId: string;
  status?: string;
  content: string;
  totalTurns: number;
  fromTurn?: number;
  toTurn?: number;
}

export interface ClaudianSessionApi {
  readonly version: number;
  getActiveSessionId(): string | null;
  send(sessionId: string, text: string): Promise<ImmediateResult | AcceptedResult>;
  cancel?(sessionId: string): void;
  /** #1623 shipped stop-the-turn as `mode: 'interrupt'` on send; a dedicated method may also appear. */
  interrupt?(sessionId: string): void | Promise<unknown>;
  readSession?(sessionId: string, options?: { beforeTurn?: number }): Promise<SessionTranscript>;
  /** Subscribe to turn lifecycle; returns an unsubscribe. Optional, polling covers its absence. */
  onTurnEnded?(listener: (event: { sessionId: string }) => void): () => void;
}

/** Finds the session API on a Claudian plugin instance, whichever property it is published under. */
export function pick(plugin: Record<string, unknown>): ClaudianSessionApi | null {
  for (const key of ['sessionApi', 'sessions', 'api']) {
    const candidate = plugin[key] as Partial<ClaudianSessionApi> | undefined;
    if (candidate && typeof candidate.send === 'function' && typeof candidate.getActiveSessionId === 'function') {
      return candidate as ClaudianSessionApi;
    }
  }
  return null;
}

const POLL_MS = 400;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export class SessionApiBridge implements ClaudianBridge {
  readonly kind = 'session-api' as const;
  readonly supportsStreaming = false;

  constructor(private readonly api: ClaudianSessionApi) {}

  getActiveSessionId(): string | null {
    return this.api.getActiveSessionId();
  }

  get canCancel(): boolean {
    return typeof this.api.cancel === 'function' || typeof this.api.interrupt === 'function';
  }

  cancel(sessionId: string): void {
    if (this.api.cancel) { this.api.cancel(sessionId); return; }
    void this.api.interrupt?.(sessionId);
  }

  async send(sessionId: string, text: string, options: SendOptions): Promise<TurnResult> {
    const { signal } = options;
    const onAbort = () => this.cancel(sessionId);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const before = this.api.readSession ? await this.#safeRead(sessionId) : null;
      const result = await this.api.send(sessionId, text);
      if (isImmediate(result)) return result;
      if (signal.aborted) return { text: '', outcome: 'interrupted' };
      return await this.#awaitReply(result.sessionId || sessionId, before?.totalTurns ?? 0, signal);
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), outcome: signal.aborted ? 'interrupted' : 'error' };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Shape B: wait for the turn to end, then read the newest final reply. */
  async #awaitReply(sessionId: string, turnsBefore: number, signal: AbortSignal): Promise<TurnResult> {
    if (!this.api.readSession) {
      return { text: '', outcome: 'error' };
    }
    const ended = await this.#waitForTurnEnd(sessionId, turnsBefore, signal);
    if (signal.aborted) return { text: '', outcome: 'interrupted' };
    if (!ended) return { text: 'Timed out waiting for the reply.', outcome: 'error' };
    const transcript = await this.#safeRead(sessionId);
    return { text: transcript ? latestReply(transcript.content) : '', outcome: 'completed' };
  }

  /** Prefers a turn-ended event; otherwise polls the transcript for a new completed turn. */
  #waitForTurnEnd(sessionId: string, turnsBefore: number, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        if (timer) clearTimer(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish(false);
      signal.addEventListener('abort', onAbort, { once: true });

      if (this.api.onTurnEnded) {
        unsubscribe = this.api.onTurnEnded(event => { if (event.sessionId === sessionId) finish(true); });
      }
      // Polling runs alongside the event so a missed event cannot hang the loop.
      const started = performance.now();
      const poll = async () => {
        if (settled) return;
        const transcript = await this.#safeRead(sessionId);
        // #1623 statuses: 'idle' | 'running' | 'awaiting-user'. Only idle means the reply is final.
        const idle = transcript?.status ? transcript.status === 'idle' : true;
        if (transcript && transcript.totalTurns > turnsBefore && idle) return finish(true);
        if (performance.now() - started > POLL_TIMEOUT_MS) return finish(false);
        timer = setTimer(() => { void poll(); }, POLL_MS);
      };
      void poll();
    });
  }

  async #safeRead(sessionId: string): Promise<SessionTranscript | null> {
    try {
      return (await this.api.readSession?.(sessionId)) ?? null;
    } catch {
      return null;
    }
  }
}

function isImmediate(result: ImmediateResult | AcceptedResult): result is ImmediateResult {
  return 'outcome' in result;
}

/**
 * `read_session` content (#1623, formatSessionSnapshot) is `## T<n> user` / `## T<n> assistant`
 * blocks, latest turns last. Take the text after the last assistant marker; tolerate the
 * unnumbered variants in case the format shifts, and fall back to the final paragraph.
 */
export function latestReply(content: string): string {
  const markers = [/^#{1,4}\s*(?:T\d+\s+)?(assistant|reply|response)\b.*$/gim, /^\*\*(assistant|reply|response)\*\*:?\s*$/gim];
  for (const marker of markers) {
    let last: RegExpExecArray | null = null;
    for (const match of content.matchAll(marker)) last = match;
    if (last && last.index !== undefined) {
      const after = content.slice(last.index + last[0].length).trim();
      // Stop at the next turn's prompt marker if one follows.
      const next = /^#{1,4}\s*(?:T\d+\s+)?(user|prompt)\b.*$/im.exec(after);
      return (next && next.index !== undefined ? after.slice(0, next.index) : after).trim();
    }
  }
  const blocks = content.trim().split(/\n{2,}/);
  return blocks[blocks.length - 1]?.trim() ?? '';
}
