import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EventRef } from 'obsidian';

import type { ClaudianBridge } from '../src/claudian/bridge';
import { type ClaudianPluginApi, PluginApiBridge, type SendStatus, type TurnEndedEvent, type TurnEventSource } from '../src/claudian/PluginApiBridge';

/** Stands in for `app.workspace`: records listeners and fires `claudian:turn-ended` on demand. */
class FakeWorkspace implements TurnEventSource {
  readonly #listeners = new Map<EventRef, (event: TurnEndedEvent) => void>();
  names: string[] = [];
  on(name: string, callback: (event: TurnEndedEvent) => void): EventRef {
    this.names.push(name);
    const ref = { name } as unknown as EventRef;
    this.#listeners.set(ref, callback);
    return ref;
  }
  offref(ref: EventRef): void { this.#listeners.delete(ref); }
  endTurn(sessionId: string): void { for (const listener of [...this.#listeners.values()]) listener({ sessionId }); }
  get listenerCount(): number { return this.#listeners.size; }
}

interface Recorded { sessionId: string; options: Parameters<ClaudianPluginApi['send']>[1] }

/** Scripted Claudian: `send` resolves with `status`, `read` with `reply`. */
function fakeApi(overrides: Partial<{ status: SendStatus; reply: () => string; onSend: (recorded: Recorded) => void }> = {}) {
  const sends: Recorded[] = [];
  const api: ClaudianPluginApi = {
    version: 1,
    getActiveSessionId: () => 's1',
    send: async (sessionId, options) => {
      const recorded = { sessionId, options };
      sends.push(recorded);
      overrides.onSend?.(recorded);
      return options.mode === 'interrupt' ? 'interrupted' : overrides.status ?? 'started';
    },
    read: async () => overrides.reply?.() ?? '',
  };
  return { api, sends };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('PluginApiBridge over Claudian 2.3.30 plugin.api', () => {
  it('sends the text as an options object, waits for turn-ended, then reads the final reply', async () => {
    const workspace = new FakeWorkspace();
    const { api, sends } = fakeApi({ reply: () => 'Two meetings today.' });
    const bridge = new PluginApiBridge(api, workspace);

    const pending = bridge.send('s1', 'what is on today?', { signal: new AbortController().signal });
    await tick();
    assert.deepEqual(sends, [{ sessionId: 's1', options: { text: 'what is on today?' } }]);
    assert.deepEqual(workspace.names, ['claudian:turn-ended']);

    workspace.endTurn('s1');
    assert.deepEqual(await pending, { text: 'Two meetings today.', outcome: 'completed' });
    assert.equal(workspace.listenerCount, 0, 'listener removed after the turn');
    assert.equal(bridge.kind, 'plugin-api');
    assert.equal(bridge.supportsStreaming, false);
    assert.equal((bridge as ClaudianBridge).appendText, undefined, 'no composer access on this API');
  });

  it('ignores turn-ended events for other sessions', async () => {
    const workspace = new FakeWorkspace();
    let reply = 'stale';
    const { api } = fakeApi({ reply: () => reply });
    const pending = new PluginApiBridge(api, workspace).send('s1', 'hi', { signal: new AbortController().signal });
    await tick();
    workspace.endTurn('other');
    await tick();
    reply = 'fresh';
    workspace.endTurn('s1');
    assert.equal((await pending).text, 'fresh');
  });

  it('counts an event that fires while send is still in flight', async () => {
    const workspace = new FakeWorkspace();
    const { api } = fakeApi({ reply: () => 'quick', onSend: () => workspace.endTurn('s1') });
    const result = await new PluginApiBridge(api, workspace).send('s1', 'hi', { signal: new AbortController().signal });
    assert.deepEqual(result, { text: 'quick', outcome: 'completed' });
  });

  it('waits for the second turn to end when the send was queued behind a running one', async () => {
    const workspace = new FakeWorkspace();
    let reply = 'reply to the earlier prompt';
    const { api } = fakeApi({ status: 'queued', reply: () => reply });
    const pending = new PluginApiBridge(api, workspace).send('s1', 'and after that?', { signal: new AbortController().signal });
    await tick();
    workspace.endTurn('s1'); // the running turn finishes; ours starts
    await tick();
    assert.equal(workspace.listenerCount, 1, 'still waiting for our own turn');
    reply = 'reply to ours';
    workspace.endTurn('s1');
    assert.equal((await pending).text, 'reply to ours');
  });

  it('maps the placeholders read returns for turns without text', async () => {
    for (const [placeholder, expected] of [
      ['(interrupted)', { text: '', outcome: 'interrupted' }],
      ['(error)', { text: 'The agent turn failed.', outcome: 'error' }],
      ['(no reply)', { text: '', outcome: 'completed' }],
    ] as const) {
      const workspace = new FakeWorkspace();
      const { api } = fakeApi({ reply: () => placeholder });
      const pending = new PluginApiBridge(api, workspace).send('s1', 'hi', { signal: new AbortController().signal });
      await tick();
      workspace.endTurn('s1');
      assert.deepEqual(await pending, expected, placeholder);
    }
  });

  it('interrupts the session and resolves as interrupted when the signal aborts', async () => {
    const workspace = new FakeWorkspace();
    const { api, sends } = fakeApi({ reply: () => 'never spoken' });
    const controller = new AbortController();
    const pending = new PluginApiBridge(api, workspace).send('s1', 'long task', { signal: controller.signal });
    await tick();
    controller.abort();
    assert.deepEqual(await pending, { text: '', outcome: 'interrupted' });
    assert.deepEqual(sends.map(s => s.options), [{ text: 'long task' }, { mode: 'interrupt' }]);
    assert.equal(workspace.listenerCount, 0);
  });

  it('cancel sends an interrupt without text', async () => {
    const { api, sends } = fakeApi();
    new PluginApiBridge(api, new FakeWorkspace()).cancel('s1');
    await tick();
    assert.deepEqual(sends, [{ sessionId: 's1', options: { mode: 'interrupt' } }]);
  });

  it('reports a rejected send as an error outcome and stops listening', async () => {
    const workspace = new FakeWorkspace();
    const api: ClaudianPluginApi = {
      version: 1,
      getActiveSessionId: () => 's1',
      send: async () => { throw new Error('The session does not exist or is archived'); },
      read: async () => '',
    };
    const result = await new PluginApiBridge(api, workspace).send('gone', 'hi', { signal: new AbortController().signal });
    assert.deepEqual(result, { text: 'The session does not exist or is archived', outcome: 'error' });
    assert.equal(workspace.listenerCount, 0);
  });

  it('gives up with an error when no turn-ended event arrives in time', async () => {
    const workspace = new FakeWorkspace();
    const { api } = fakeApi({ reply: () => 'late' });
    const result = await new PluginApiBridge(api, workspace, { replyTimeoutMs: 10 }).send('s1', 'hi', { signal: new AbortController().signal });
    assert.deepEqual(result, { text: 'Timed out waiting for the reply.', outcome: 'error' });
    assert.equal(workspace.listenerCount, 0);
  });
});
