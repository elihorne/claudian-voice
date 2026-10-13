import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTranscriptionPrompt, parseGlossary } from '../src/speech/glossary';

describe('parseGlossary', () => {
  it('reads bullets, plain lines, and comma lists, skipping headings and comments', () => {
    const text = '# Voice glossary\n\n- Claudian\nLovable, Supabase\n<!-- note -->\n* Nakul\n\n# Another heading\nTobias';
    assert.deepEqual(parseGlossary(text), ['Claudian', 'Lovable', 'Supabase', 'Nakul', 'Tobias']);
  });

  it('dedupes', () => {
    assert.deepEqual(parseGlossary('Claudian\nClaudian, Lovable'), ['Claudian', 'Lovable']);
  });
});

describe('buildTranscriptionPrompt', () => {
  it('is empty with no terms and phrases terms as a sentence otherwise', () => {
    assert.equal(buildTranscriptionPrompt([]), '');
    assert.equal(buildTranscriptionPrompt(['Claudian', 'Lovable']), 'Terms that may come up: Claudian, Lovable.');
  });

  it('stops adding terms at the character cap', () => {
    const terms = Array.from({ length: 200 }, (_, i) => `Term${i}`);
    const prompt = buildTranscriptionPrompt(terms, 100);
    assert.ok(prompt.length <= 'Terms that may come up: '.length + 101);
    assert.ok(prompt.includes('Term0'));
    assert.ok(!prompt.includes('Term199'));
  });
});
