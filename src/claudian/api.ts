/**
 * The contract this plugin consumes from Claudian, mirrored from
 * `src/features/chat/api/types.ts` in YishenTu/claudian. Only this file should
 * change if Claudian renames or reshapes the surface.
 */
import type { App } from 'obsidian';

export const SUPPORTED_API_VERSION = 1;
export const CLAUDIAN_PLUGIN_ID = 'realclaudian';

export type ChatActivity =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking' }
  | { kind: 'tool'; tool: unknown }
  | { kind: 'error'; message: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ClaudianChatHandle {
  readonly tabId: string;
  readonly conversationId: string | null;
  readonly providerId: string | null;
  appendText(text: string): boolean;
  submit(content?: string): Promise<void>;
  stop(): void;
  readonly isStreaming: boolean;
  readonly activity: ChatActivity | null;
  readonly messages: readonly ChatMessage[];
  subscribe(listener: () => void): () => void;
}

export interface ClaudianApi {
  readonly version: number;
  getActiveChat(): ClaudianChatHandle | null;
}

export type ClaudianApiStatus =
  | { ok: true; api: ClaudianApi }
  | { ok: false; reason: 'not-installed' | 'no-api' | 'version'; detail?: string };

interface PluginsWithApi {
  plugins?: { plugins?: Record<string, { api?: unknown } | undefined> };
}

/** Finds a compatible Claudian instance without importing it. */
export function resolveClaudianApi(app: App): ClaudianApiStatus {
  const plugin = (app as unknown as PluginsWithApi).plugins?.plugins?.[CLAUDIAN_PLUGIN_ID];
  if (!plugin) return { ok: false, reason: 'not-installed' };
  const api = plugin.api as Partial<ClaudianApi> | undefined;
  if (!api || typeof api.getActiveChat !== 'function') return { ok: false, reason: 'no-api' };
  if (api.version !== SUPPORTED_API_VERSION) {
    return { ok: false, reason: 'version', detail: `Claudian API v${String(api.version)}, this plugin needs v${SUPPORTED_API_VERSION}` };
  }
  return { ok: true, api: api as ClaudianApi };
}

export function describeApiFailure(status: Extract<ClaudianApiStatus, { ok: false }>): string {
  switch (status.reason) {
    case 'not-installed': return 'Claudian is not installed or not enabled.';
    case 'no-api': return 'This Claudian version does not expose the companion API yet. Update Claudian.';
    case 'version': return status.detail ?? 'Incompatible Claudian API version.';
  }
}
