import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { App } from 'obsidian';

import { describeBridgeFailure, resolveClaudianBridge } from '../src/claudian/api';

const noop = () => undefined;

/** An `App` with just the plugin registry and workspace events the resolver touches. */
function appWith(claudian: Record<string, unknown> | undefined): App {
  return {
    plugins: { plugins: claudian ? { realclaudian: claudian } : {} },
    workspace: { on: () => ({}), offref: noop },
  } as unknown as App;
}

const pluginApi = (version: number) => ({ version, getActiveSessionId: noop, send: noop, read: noop });

describe('resolveClaudianBridge', () => {
  it('reports Claudian missing or disabled', () => {
    const status = resolveClaudianBridge(appWith(undefined));
    assert.deepEqual(status, { ok: false, reason: 'not-installed' });
    assert.match(describeBridgeFailure(status as Extract<typeof status, { ok: false }>), /not installed/);
  });

  it('prefers the plugin API that shipped in Claudian 2.3.30', () => {
    const status = resolveClaudianBridge(appWith({ api: pluginApi(1) }));
    assert.ok(status.ok);
    assert.equal(status.bridge.kind, 'plugin-api');
  });

  it('refuses a plugin API version it does not know', () => {
    const status = resolveClaudianBridge(appWith({ api: pluginApi(2) }));
    assert.ok(!status.ok);
    assert.equal(status.reason, 'version');
    assert.match(status.detail ?? '', /v2.*supports v1/);
  });

  it('falls back to the fork build tab-handle shim', () => {
    const status = resolveClaudianBridge(appWith({ api: { version: 1, getActiveChat: noop } }));
    assert.ok(status.ok);
    assert.equal(status.bridge.kind, 'local-shim');
  });

  it('asks for a Claudian update when no known API is present', () => {
    for (const api of [undefined, {}, { version: 1, send: noop, getActiveSessionId: noop }]) {
      const status = resolveClaudianBridge(appWith({ api }));
      assert.deepEqual(status, { ok: false, reason: 'no-api' });
      assert.match(describeBridgeFailure(status as Extract<typeof status, { ok: false }>), /2\.3\.30/);
    }
  });
});
