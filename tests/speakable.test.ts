import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isCancelPhrase, SentenceCursor, splitSentences, toSpeakable } from '../src/voice/speakable';

describe('toSpeakable', () => {
  it('drops closed code fences and holds back an open one', () => {
    assert.equal(toSpeakable('Run this:\n```sh\nnpm test\n```\nThen done.'), 'Run this:\nThen done.');
    assert.equal(toSpeakable('Here is code:\n```ts\nconst x = 1;'), 'Here is code:');
  });

  it('keeps list items and their numbers, dropping only the markers', () => {
    const input = '- Fetch the meetings\n- Write them down\n\n1. First step\n2. Second step';
    assert.equal(toSpeakable(input), 'Fetch the meetings\nWrite them down\n1, First step\n2, Second step');
    const { sentences } = splitSentences(`${toSpeakable(input)}\n`);
    assert.deepEqual(sentences, ['Fetch the meetings', 'Write them down', '1, First step', '2, Second step']);
  });

  it('strips urls, paths, inline code, and markdown markers but keeps link text', () => {
    const input = '## Title\n\n- See [the docs](https://example.com/x) and `foo()` at ./src/main.ts **now**.';
    assert.equal(toSpeakable(input), 'Title\nSee the docs and at now.');
  });
});

describe('splitSentences', () => {
  it('returns complete sentences and the unfinished tail', () => {
    const { sentences, rest } = splitSentences('First one. Second one! Third is still');
    assert.deepEqual(sentences, ['First one.', 'Second one!']);
    assert.equal(rest, 'Third is still');
  });

  it('treats a newline as a sentence boundary', () => {
    const { sentences, rest } = splitSentences('A heading line\nthen more');
    assert.deepEqual(sentences, ['A heading line']);
    assert.equal(rest, 'then more');
  });
});

describe('SentenceCursor', () => {
  it('yields each sentence once as the cumulative text grows', () => {
    const cursor = new SentenceCursor();
    assert.deepEqual(cursor.push('Hello th'), []);
    assert.deepEqual(cursor.push('Hello there. How are'), ['Hello there.']);
    assert.deepEqual(cursor.push('Hello there. How are you? Fine'), ['How are you?']);
    assert.deepEqual(cursor.flush(), ['Fine']);
    assert.deepEqual(cursor.flush(), []);
  });

  it('restarts when a new text block begins after a tool call', () => {
    const cursor = new SentenceCursor();
    assert.deepEqual(cursor.push('Let me check that'), []);
    // StreamController starts a fresh block: cumulative text no longer extends the old one.
    assert.deepEqual(cursor.push('The file has 3 lines.'), ['Let me check that', 'The file has 3 lines.']);
  });

  it('does not speak an unclosed code fence, then speaks what follows it', () => {
    const cursor = new SentenceCursor();
    assert.deepEqual(cursor.push('Try this. ```sh\nls'), ['Try this.']);
    assert.deepEqual(cursor.push('Try this. ```sh\nls\n``` That lists files.'), ['That lists files.']);
  });
});

describe('isCancelPhrase', () => {
  it('matches bare cancel words only', () => {
    assert.equal(isCancelPhrase('Never mind.'), true);
    assert.equal(isCancelPhrase('scratch that'), true);
    assert.equal(isCancelPhrase('never mind the file, rename it'), false);
  });
});
