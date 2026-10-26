/**
 * Locates a compatible Claudian and wraps it in a bridge. Prefers the plugin API that shipped
 * in Claudian 2.3.30 (`plugin.api`, version 1); falls back to the fork's interim tab-handle
 * shim for builds that still carry it.
 */
import type { App } from 'obsidian';

import { type BridgeStatus, describeBridgeFailure } from './bridge';
import { LocalShimBridge, pick as pickShim, SUPPORTED_SHIM_VERSION } from './LocalShimBridge';
import { pick as pickPluginApi, PluginApiBridge, SUPPORTED_PLUGIN_API_VERSION, turnEventsOf } from './PluginApiBridge';

export const CLAUDIAN_PLUGIN_ID = 'realclaudian';
export { describeBridgeFailure };

interface PluginsWithApi {
  plugins?: { plugins?: Record<string, Record<string, unknown> | undefined> };
}

export function resolveClaudianBridge(app: App): BridgeStatus {
  const plugin = (app as unknown as PluginsWithApi).plugins?.plugins?.[CLAUDIAN_PLUGIN_ID];
  if (!plugin) return { ok: false, reason: 'not-installed' };

  const api = pickPluginApi(plugin);
  if (api) {
    if (api.version !== SUPPORTED_PLUGIN_API_VERSION) {
      return { ok: false, reason: 'version', detail: `Claudian plugin API v${String(api.version)}; this plugin supports v${SUPPORTED_PLUGIN_API_VERSION}. Update Claudian Voice.` };
    }
    return { ok: true, bridge: new PluginApiBridge(api, turnEventsOf(app)) };
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
