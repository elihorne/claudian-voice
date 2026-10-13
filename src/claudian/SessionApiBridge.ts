/**
 * Adapter for the session-addressed API proposed by the Claudian maintainer in #1611:
 *
 *   interface ClaudianSessionApi {
 *     readonly version: 1;
 *     getActiveSessionId(): string | null;
 *     startSession(options?): Promise<string>;
 *     send(sessionId, text): Promise<{ text: string; outcome: 'completed' | 'interrupted' | 'error' }>;
 *     cancel?(sessionId): void;   // requested, not yet confirmed
 *   }
 *
 * Final answer only, no streaming. The property name on the plugin instance and the
 * exact shape are experimental; update `pick()` when the published version differs.
 */
import type { ClaudianBridge, SendOptions, TurnResult } from './bridge';

export const SUPPORTED_SESSION_API_VERSION = 1;

export interface ClaudianSessionApi {
  readonly version: number;
  getActiveSessionId(): string | null;
  send(sessionId: string, text: string): Promise<TurnResult>;
  cancel?(sessionId: string): void;
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

export class SessionApiBridge implements ClaudianBridge {
  readonly kind = 'session-api' as const;
  readonly supportsStreaming = false;

  constructor(private readonly api: ClaudianSessionApi) {}

  getActiveSessionId(): string | null {
    return this.api.getActiveSessionId();
  }

  async send(sessionId: string, text: string, options: SendOptions): Promise<TurnResult> {
    const onAbort = () => this.cancel(sessionId);
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.api.send(sessionId, text);
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), outcome: 'error' };
    } finally {
      options.signal.removeEventListener('abort', onAbort);
    }
  }

  cancel(sessionId: string): void {
    this.api.cancel?.(sessionId);
  }

  get canCancel(): boolean {
    return typeof this.api.cancel === 'function';
  }
}
