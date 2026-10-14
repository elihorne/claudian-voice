import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type ClaudianSessionApi, SessionApiBridge, type SessionTranscript } from '../src/claudian/SessionApiBridge';

function transcript(turns: Array<[string, string]>, status: SessionTranscript['status']): SessionTranscript {
  const content = turns.map(([u, a], i) => `## T${i + 1} user\n${u}\n\n## T${i + 1} assistant\n${a}`).join('\n\n');
  return { sessionId: 's1', status, content, totalTurns: turns.length };
}

describe('SessionApiBridge over the #1623 shape', () => {
  it('sends, waits for the turn to end, then reads the newest reply', async () => {
    let state = transcript([['hi', 'hello']], 'idle');
    const listeners = new Set<(e: { sessionId: string }) => void>();
    const api: ClaudianSessionApi = {
      version: 1,
      getActiveSessionId: () => 's1',
      send: async (sessionId, text) => {
        state = { ...transcript([['hi', 'hello'], [text, '']], 'running'), totalTurns: 1 };
        setTimeout(() => {
          state = transcript([['hi', 'hello'], [text, 'Two meetings today.']], 'idle');
          for (const l of listeners) l({ sessionId });
        }, 20);
        return { sessionId, status: 'started' };
      },
      readSession: async () => state,
      onTurnEnded: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      interrupt: () => undefined,
    };
    const bridge = new SessionApiBridge(api);
    const result = await bridge.send('s1', 'what is on today?', { signal: new AbortController().signal });
    assert.deepEqual(result, { text: 'Two meetings today.', outcome: 'completed' });
    assert.equal(bridge.canCancel, true);
  });

  it('still completes by polling when no turn-ended event exists', async () => {
    let state = transcript([['hi', 'hello']], 'idle');
    const api: ClaudianSessionApi = {
      version: 1,
      getActiveSessionId: () => 's1',
      send: async (sessionId, text) => {
        state = { ...state, status: 'running' };
        setTimeout(() => { state = transcript([['hi', 'hello'], [text, 'Polled reply.']], 'idle'); }, 30);
        return { sessionId, status: 'queued' };
      },
      readSession: async () => state,
    };
    const result = await new SessionApiBridge(api).send('s1', 'poll me', { signal: new AbortController().signal });
    assert.equal(result.text, 'Polled reply.');
  });

  it('passes through the immediate shape unchanged', async () => {
    const api: ClaudianSessionApi = {
      version: 1,
      getActiveSessionId: () => 's1',
      send: async () => ({ text: 'direct', outcome: 'completed' }),
    };
    const result = await new SessionApiBridge(api).send('s1', 'x', { signal: new AbortController().signal });
    assert.deepEqual(result, { text: 'direct', outcome: 'completed' });
  });
});
