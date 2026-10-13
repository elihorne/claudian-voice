/**
 * Adapter over the interim tab-handle API from the local `feat/public-chat-api` build of
 * Claudian (`app.plugins.plugins.realclaudian.api.getActiveChat()`). This is the bridge we
 * develop against until the maintainer publishes the session API; it also provides
 * streaming partials and composer insert, which that API will not.
 */
import type { ClaudianBridge, SendOptions, TurnResult } from './bridge';

export const SUPPORTED_SHIM_VERSION = 1;

type ChatActivity =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking' }
  | { kind: 'tool'; tool: unknown }
  | { kind: 'error'; message: string };

export interface ChatHandle {
  readonly tabId: string;
  appendText(text: string): boolean;
  submit(content?: string): Promise<void>;
  stop(): void;
  readonly isStreaming: boolean;
  readonly activity: ChatActivity | null;
  readonly messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  subscribe(listener: () => void): () => void;
}

export interface ChatHandleApi {
  readonly version: number;
  getActiveChat(): ChatHandle | null;
}

export function pick(plugin: Record<string, unknown>): ChatHandleApi | null {
  const candidate = plugin.api as Partial<ChatHandleApi> | undefined;
  return candidate && typeof candidate.getActiveChat === 'function' ? (candidate as ChatHandleApi) : null;
}

export class LocalShimBridge implements ClaudianBridge {
  readonly kind = 'local-shim' as const;
  readonly supportsStreaming = true;
  #handles = new Map<string, ChatHandle>();

  constructor(private readonly api: ChatHandleApi) {}

  getActiveSessionId(): string | null {
    const chat = this.api.getActiveChat();
    if (!chat) return null;
    this.#handles.set(chat.tabId, chat);
    return chat.tabId;
  }

  appendText(sessionId: string, text: string): boolean {
    return this.#handle(sessionId)?.appendText(text) ?? false;
  }

  cancel(sessionId: string): void {
    this.#handle(sessionId)?.stop();
  }

  async send(sessionId: string, text: string, options: SendOptions): Promise<TurnResult> {
    const chat = this.#handle(sessionId);
    if (!chat) return { text: 'Chat tab is no longer available.', outcome: 'error' };
    const { signal, onPartial } = options;
    let interrupted = false;
    let lastPartial = '';
    // Activity still holds the previous reply when we subscribe; only forward text once this
    // turn has started (our user message appears, or streaming begins with a new text block).
    const stale = chat.activity;
    let armed = false;
    const unsubscribe = chat.subscribe(() => {
      const activity = chat.activity;
      if (!armed) {
        if (activity?.kind === 'user') armed = true;
        else if (chat.isStreaming && activity !== stale && activity?.kind !== 'text') armed = true;
        else if (chat.isStreaming && activity?.kind === 'text' && (stale?.kind !== 'text' || activity.text !== stale.text)) armed = true;
        if (!armed) return;
      }
      if (activity?.kind === 'text' && activity.text !== lastPartial) {
        lastPartial = activity.text;
        onPartial?.(activity.text);
      }
    });
    const onAbort = () => { interrupted = true; chat.stop(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await chat.submit(text);
      const last = [...chat.messages].reverse().find(message => message.role === 'assistant');
      return { text: last?.content ?? lastPartial, outcome: interrupted ? 'interrupted' : 'completed' };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), outcome: interrupted ? 'interrupted' : 'error' };
    } finally {
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
    }
  }

  #handle(sessionId: string): ChatHandle | null {
    const active = this.api.getActiveChat();
    if (active?.tabId === sessionId) return active;
    return this.#handles.get(sessionId) ?? null;
  }
}
