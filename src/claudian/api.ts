/**
 * Locates a compatible Claudian and wraps it in a bridge. Prefers the maintainer's
 * session API when present; falls back to the interim tab-handle shim.
 */
import type { App } from 'obsidian';

import { type BridgeStatus, describeBridgeFailure } from './bridge';
import { LocalShimBridge, pick as pickShim, SUPPORTED_SHIM_VERSION } from './LocalShimBridge';
import { pick as pickSessionApi, SessionApiBridge, SUPPORTED_SESSION_API_VERSION } from './SessionApiBridge';

export const CLAUDIAN_PLUGIN_ID = 'realclaudian';
export { describeBridgeFailure };

interface PluginsWithApi {
  plugins?: { plugins?: Record<string, Record<string, unknown> | undefined> };
}

export function resolveClaudianBridge(app: App): BridgeStatus {
  const plugin = (app as unknown as PluginsWithApi).plugins?.plugins?.[CLAUDIAN_PLUGIN_ID];
  if (!plugin) return { ok: false, reason: 'not-installed' };

  const sessionApi = pickSessionApi(plugin);
  if (sessionApi) {
    if (sessionApi.version !== SUPPORTED_SESSION_API_VERSION) {
      return { ok: false, reason: 'version', detail: `Claudian session API v${String(sessionApi.version)}; this plugin supports v${SUPPORTED_SESSION_API_VERSION}.` };
    }
    return { ok: true, bridge: new SessionApiBridge(sessionApi) };
  }

  const shim = pickShim(plugin);
  if (shim) {
    if (shim.version !== SUPPORTED_SHIM_VERSION) {
      return { ok: false, reason: 'version', detail: `Claudian chat API v${String(shim.version)}; this plugin supports v${SUPPORTED_SHIM_VERSION}.` };
    }
    return { ok: true, bridge: new LocalShimBridge(shim) };
  }

  return { ok: false, reason: 'no-api' };
}
