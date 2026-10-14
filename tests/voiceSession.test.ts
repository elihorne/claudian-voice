import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ClaudianBridge, SendOptions, TurnResult } from '../src/claudian/bridge';
import type { ListenCallbacks, RecognitionResult, Speaker, SpeechRecognizer } from '../src/speech/types';
import { VoiceSession, type VoiceSessionDeps, type VoiceState } from '../src/voice/VoiceSession';

/** Scripted recogniser: each listen() returns the next scripted utterance, or ends the script. */
class FakeRecognizer implements SpeechRecognizer {
  readonly id = 'openai-realtime' as const;
  disposed = 0;
  constructor(private readonly script: Array<string | null>, private readonly onDone: () => void) {}
  isAvailable(): boolean { return true; }
  async listen(signal: AbortSignal, callbacks?: ListenCallbacks): Promise<RecognitionResult | null> {
    if (this.script.length === 0) {
      this.onDone();
      // Park until stop() aborts us, but never beyond a short bound so a test cannot hang.
      await new Promise(r => { const t = setTimeout(r, 20); signal.addEventListener('abort', () => { clearTimeout(t); r(undefined); }, { once: true }); });
      return null;
    }
    const next = this.script.shift() ?? null;
    callbacks?.onPartial?.(next ?? '');
    await tick();
    return next ? { text: next } : null;
  }
  dispose(): void { this.disposed += 1; }
}

class FakeSpeaker implements Speaker {
  spoken: string[] = [];
  cancelled = 0;
  isSpeaking = false;
  async speak(text: string): Promise<void> { this.spoken.push(text); await tick(); }
  cancel(): void { this.cancelled += 1; }
}

interface Scripted { text: string; partials?: string[]; outcome?: TurnResult['outcome']; delayMs?: number }

class FakeBridge implements ClaudianBridge {
  readonly kind = 'local-shim' as const;
  supportsStreaming = true;
  sent: string[] = [];
  cancelled: string[] = [];
  constructor(private readonly replies: Scripted[]) {}
  getActiveSessionId(): string | null { return 'tab-1'; }
  cancel(sessionId: string): void { this.cancelled.push(sessionId); }
  async send(_sessionId: string, text: string, options: SendOptions): Promise<TurnResult> {
    this.sent.push(text);
    const reply = this.replies.shift() ?? { text: 'ok.' };
    for (const partial of reply.partials ?? []) { options.onPartial?.(partial); await tick(); }
    if (reply.delayMs) await new Promise(r => setTimeout(r, reply.delayMs));
    if (options.signal.aborted) return { text: '', outcome: 'interrupted' };
    return { text: reply.text, outcome: reply.outcome ?? 'completed' };
  }
}

function tick(): Promise<void> { return new Promise(r => setTimeout(r, 0)); }

function makeDeps(over: Partial<VoiceSessionDeps> & { bridge: ClaudianBridge; recognizer: SpeechRecognizer; speaker: Speaker }): { deps: VoiceSessionDeps; states: VoiceState[]; hinted: Set<string> } {
  const states: VoiceState[] = [];
  const hinted = new Set<string>();
  const deps: VoiceSessionDeps = {
    isConversationMode: () => true,
    isSpeechEnabled: () => true,
    shouldAutoSubmit: () => true,
    getPromptSuffix: () => '(voice)',
    hasHinted: id => hinted.has(id),
    markHinted: id => { hinted.add(id); },
    onState: state => states.push(state),
    getTurnGapMs: () => 0,
    getIdleStopMs: () => 0,
    ...over,
  };
  return { deps, states, hinted };
}

describe('VoiceSession', () => {
  it('sends the hint once per conversation and speaks streamed sentences as they complete', async () => {
    const bridge = new FakeBridge([
      { text: 'Hello there. Second sentence.', partials: ['Hello there.', 'Hello there. Second sentence.'] },
      { text: 'Fine.', partials: ['Fine.'] },
    ]);
    const speaker = new FakeSpeaker();
    let session: VoiceSession | null = null;
    const recognizer = new FakeRecognizer(['first question', 'follow up'], () => session?.stop());
    const { deps } = makeDeps({ bridge, recognizer, speaker });
    session = new VoiceSession(deps);
    await session.start();

    assert.equal(bridge.sent.length, 2);
    assert.match(bridge.sent[0] ?? '', /first question\n\n\(voice\)$/);
    assert.equal(bridge.sent[1], 'follow up', 'second prompt carries no hint');
    assert.ok(speaker.spoken.join(' ').includes('Hello there.'));
    assert.ok(speaker.spoken.join(' ').includes('Second sentence.'));
    assert.ok(speaker.spoken.join(' ').includes('Fine.'));
    assert.equal(recognizer.disposed, 1, 'recognizer released when the session ends');
  });

  it('handles local verbs without touching the agent', async () => {
    const bridge = new FakeBridge([]);
    const speaker = new FakeSpeaker();
    let session: VoiceSession | null = null;
    const recognizer = new FakeRecognizer(['note to self, call Nakul'], () => session?.stop());
    const seen: string[] = [];
    const { deps } = makeDeps({
      bridge, recognizer, speaker,
      handleLocalVerb: async verb => { seen.push(verb.kind); return verb.kind === 'capture' ? 'Noted.' : null; },
    });
    session = new VoiceSession(deps);
    await session.start();

    assert.deepEqual(seen, ['capture']);
    assert.equal(bridge.sent.length, 0);
    assert.deepEqual(speaker.spoken, ['Noted.']);
  });

  it('interrupt cancels the agent turn and listens again instead of ending the session', async () => {
    const bridge = new FakeBridge([{ text: 'long answer', partials: ['long answer that keeps'], delayMs: 50 }, { text: 'short.', partials: ['short.'] }]);
    const speaker = new FakeSpeaker();
    let session: VoiceSession | null = null;
    const recognizer = new FakeRecognizer(['start something long', 'actually stop'], () => session?.stop());
    const { deps } = makeDeps({ bridge, recognizer, speaker });
    session = new VoiceSession(deps);
    const run = session.start();
    await new Promise(r => setTimeout(r, 10));
    session.interrupt();
    await run;

    assert.deepEqual(bridge.cancelled, ['tab-1']);
    assert.equal(bridge.sent.length, 2, 'the session kept going after the interrupt');
    assert.ok(speaker.cancelled >= 1);
  });

  it('stops after sustained silence when idle auto-stop is set', async () => {
    const bridge = new FakeBridge([]);
    const speaker = new FakeSpeaker();
    const recognizer = new FakeRecognizer([null, null, null, null], () => undefined);
    const { deps, states } = makeDeps({ bridge, recognizer, speaker, getIdleStopMs: () => 1 });
    const session = new VoiceSession(deps);
    await session.start();

    assert.equal(bridge.sent.length, 0);
    assert.equal(states.at(-1)?.phase, 'idle');
    assert.equal(session.isRunning, false);
  });

  it('surfaces an agent error and ends the loop', async () => {
    const bridge = new FakeBridge([{ text: 'boom', outcome: 'error' }]);
    const speaker = new FakeSpeaker();
    const recognizer = new FakeRecognizer(['do a thing'], () => undefined);
    const { deps, states } = makeDeps({ bridge, recognizer, speaker });
    const session = new VoiceSession(deps);
    await session.start();

    assert.equal(states.at(-1)?.phase, 'error');
    assert.equal(speaker.spoken.length, 0);
  });

  it('speaks the whole final answer when the bridge cannot stream', async () => {
    const bridge = new FakeBridge([{ text: 'One. Two. Three.' }]);
    bridge.supportsStreaming = false;
    const speaker = new FakeSpeaker();
    let session: VoiceSession | null = null;
    const recognizer = new FakeRecognizer(['count'], () => session?.stop());
    const { deps } = makeDeps({ bridge, recognizer, speaker });
    session = new VoiceSession(deps);
    await session.start();

    assert.equal(speaker.spoken.join(' '), 'One. Two. Three.');
  });
});
