import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { latestReply } from '../src/claudian/SessionApiBridge';

describe('latestReply', () => {
  it('returns the text after the last reply marker, up to the next prompt', () => {
    const content = '## User\nWhat is in today?\n\n## Assistant\nSix meetings.\n\n## User\nAnd tomorrow?\n\n## Assistant\nTwo so far.\n';
    assert.equal(latestReply(content), 'Two so far.');
  });

  it('falls back to the final paragraph when there are no markers', () => {
    assert.equal(latestReply('Prompt text.\n\nFinal reply paragraph.'), 'Final reply paragraph.');
  });
});
