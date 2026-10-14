/** A spoken instruction handled inside Obsidian, without the agent. */
export type LocalVerb =
  | { kind: 'capture'; text: string }
  | { kind: 'read-note' }
  | { kind: 'stop-reading' }
  | { kind: 'skip' };

/**
 * Capture openers. Each must be followed by a word boundary so "captured the bug" is not a
 * command, and bare "remember" is excluded because it opens ordinary questions too often.
 */
const CAPTURE_PREFIX = /^(note to self|capture|jot down|add to my notes|remember to|remember that|remind me to)(?=$|[\s,:;.!-])/i;

/** Recognises local verbs at the start of an utterance. Returns null when the agent should get it. */
export function parseLocalVerb(utterance: string): LocalVerb | null {
  const text = utterance.trim();
  const lower = text.toLowerCase().replace(/[.!?]+$/, '');
  const capture = CAPTURE_PREFIX.exec(text);
  if (capture) {
    const rest = text.slice(capture[0].length).replace(/^[\s,:;.!-]+/, '').trim();
    return rest ? { kind: 'capture', text: rest } : null;
  }
  if (/^(read (this|the) (note|page)( to me| aloud)?|read it to me|read from here)$/.test(lower)) return { kind: 'read-note' };
  if (/^(stop reading|stop)$/.test(lower)) return { kind: 'stop-reading' };
  if (/^(skip|next section|skip (this|that) section)$/.test(lower)) return { kind: 'skip' };
  return null;
}
