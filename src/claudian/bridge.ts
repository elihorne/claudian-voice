/**
 * What the voice loop needs from Claudian, independent of which API shape provides it.
 * Two adapters implement this: `PluginApiBridge` over Claudian's plugin API (2.3.30 and
 * later, YishenTu/claudian#1798), and `LocalShimBridge` over the interim tab-handle API in
 * the fork's feat/public-chat-api build.
 */
export type TurnOutcome = 'completed' | 'interrupted' | 'error';

export interface TurnResult {
  /** Final assistant answer as markdown; empty when interrupted before any text. */
  text: string;
  outcome: TurnOutcome;
}

export interface SendOptions {
  signal: AbortSignal;
  /** Cumulative text of the reply so far; only bridges with `supportsStreaming` call it. */
  onPartial?: (cumulativeMarkdown: string) => void;
}

export interface ClaudianBridge {
  readonly kind: 'plugin-api' | 'local-shim';
  readonly supportsStreaming: boolean;
  getActiveSessionId(): string | null;
  /** Resolves when the turn ends. Never rejects for agent errors; those surface as `outcome: 'error'`. */
  send(sessionId: string, text: string, options: SendOptions): Promise<TurnResult>;
  /** Cuts the in-flight turn; the pending send resolves with `'interrupted'`. */
  cancel(sessionId: string): void;
  /** Dictation without sending; absent when the API has no composer access. */
  appendText?(sessionId: string, text: string): boolean;
}

export type BridgeStatus =
  | { ok: true; bridge: ClaudianBridge }
  | { ok: false; reason: 'not-installed' | 'no-api' | 'version'; detail?: string };

export function describeBridgeFailure(status: Extract<BridgeStatus, { ok: false }>): string {
  switch (status.reason) {
    case 'not-installed': return 'Claudian is not installed or not enabled.';
    case 'no-api': return 'This Claudian version has no plugin API. Update Claudian to 2.3.30 or later.';
    case 'version': return status.detail ?? 'Incompatible Claudian API version.';
  }
}
