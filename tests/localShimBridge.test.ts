import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type ChatHandle, LocalShimBridge } from '../src/claudian/LocalShimBridge';

type Activity = ChatHandle['activity'];

/** Minimal tab handle whose state the test drives by hand. */
class FakeHandle implements ChatHandle {
  readonly tabId = 'tab-1';
  isStreaming = false;
  activity: Activity = null;
  messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  stopped = 0;
  #listeners = new Set<() => void>();
  #resolveSubmit: (() => void) | null = null;
  appendText(): boolean { return true; }
  stop(): void { this.stopped += 1; }
  submit(): Promise<void> { return new Promise(resolve => { this.#resolveSubmit = resolve; }); }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  emit(): void { for (const listener of this.#listeners) listener(); }
  finishTurn(): void { this.isStreaming = false; this.emit(); this.#resolveSubmit?.(); }
}

describe('LocalShimBridge.send', () => {
  it('does not forward the previous reply left in activity when a new turn begins', async () => {
    const handle = new FakeHandle();
    handle.activity = { kind: 'text', text: 'Right now there is nothing attached.' };
    const bridge = new LocalShimBridge({ version: 1, getActiveChat: () => handle });
    const partials: string[] = [];
    const controller = new AbortController();

    const pending = bridge.send('tab-1', 'what did I highlight?', { signal: controller.signal, onPartial: text => partials.push(text) });
    // A notification arrives before anything about this turn has changed.
    handle.emit();
    // Then the user message is added, streaming starts, and a new block grows.
    handle.activity = { kind: 'user', text: 'what did I highlight?' }; handle.emit();
    handle.isStreaming = true;
    handle.activity = { kind: 'text', text: 'You highlighted' }; handle.emit();
    handle.activity = { kind: 'text', text: 'You highlighted four names.' }; handle.emit();
    handle.messages = [{ role: 'user', content: 'what did I highlight?' }, { role: 'assistant', content: 'You highlighted four names.' }];
    handle.finishTurn();
    const result = await pending;

    assert.deepEqual(partials, ['You highlighted', 'You highlighted four names.']);
    assert.deepEqual(result, { text: 'You highlighted four names.', outcome: 'completed' });
  });

  it('reports interrupted and stops the tab when the signal aborts', async () => {
    const handle = new FakeHandle();
    const bridge = new LocalShimBridge({ version: 1, getActiveChat: () => handle });
    const controller = new AbortController();
    const pending = bridge.send('tab-1', 'go', { signal: controller.signal });
    controller.abort();
    handle.finishTurn();
    const result = await pending;
    assert.equal(handle.stopped, 1);
    assert.equal(result.outcome, 'interrupted');
  });
});
