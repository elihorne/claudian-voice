import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseLocalVerb } from '../src/voice/LocalVerbs';

describe('parseLocalVerb', () => {
  it('recognises capture prefixes and strips them', () => {
    assert.deepEqual(parseLocalVerb('Note to self, call Nakul tomorrow.'), { kind: 'capture', text: 'call Nakul tomorrow.' });
    assert.deepEqual(parseLocalVerb('remember to book the room'), { kind: 'capture', text: 'book the room' });
    assert.deepEqual(parseLocalVerb('Remind me to send the deck'), { kind: 'capture', text: 'send the deck' });
    assert.equal(parseLocalVerb('note to self'), null, 'a bare prefix captures nothing');
  });

  it('recognises reading controls', () => {
    assert.deepEqual(parseLocalVerb('Read this note to me'), { kind: 'read-note' });
    assert.deepEqual(parseLocalVerb('skip'), { kind: 'skip' });
    assert.deepEqual(parseLocalVerb('Stop reading.'), { kind: 'stop-reading' });
  });

  it('leaves ordinary prompts for the agent', () => {
    assert.equal(parseLocalVerb('What did I highlight?'), null);
    assert.equal(parseLocalVerb('Remember when we discussed the retro? What was decided?'), null);
    assert.equal(parseLocalVerb('Captured the bug in the retro app'), null);
  });
});
