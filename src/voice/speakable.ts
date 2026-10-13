/**
 * Pure text transforms between the streamed reply and what gets spoken.
 * No DOM, no Obsidian, so they run under plain node tests.
 */

/** Drops fenced code (closed blocks and a trailing unclosed one), inline code, URLs, paths, and markdown markers. */
export function toSpeakable(markdown: string): string {
  let text = markdown.replace(/```[\s\S]*?```/g, ' ');
  // A fence still streaming: hold everything after it back until it closes.
  const openFence = text.indexOf('```');
  if (openFence !== -1) text = text.slice(0, openFence);
  return text
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:^|\s)(?:~|\.{1,2})?\/[\w./-]+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    // Keep list numbers so order survives in speech; a comma reads as "one, …" without ending the sentence.
    .replace(/^\s*(\d+)[.)]\s+/gm, '$1, ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(line => line.trim()).filter(line => line.length > 0).join('\n')
    .trim();
}

const SENTENCE_END = /([.!?…]+["')\]]?)(\s+|$)/g;

/**
 * Splits text into complete sentences, returning them plus the unfinished tail.
 * The tail stays unspoken until more text arrives or the turn ends.
 */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let cursor = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    const sentence = text.slice(cursor, end).trim();
    if (sentence) sentences.push(sentence);
    cursor = end;
  }
  const paragraphs = text.slice(cursor).split('\n');
  // A newline also closes a thought, even without terminal punctuation.
  while (paragraphs.length > 1) {
    const line = paragraphs.shift()?.trim();
    if (line) sentences.push(line);
  }
  return { sentences, rest: paragraphs[0] ?? '' };
}

/**
 * Tracks how much of a cumulative reply has been spoken and yields the newly
 * completed sentences each time the reply grows.
 */
export class SentenceCursor {
  #spokenChars = 0;
  #pending = '';
  #lastRaw = '';

  /**
   * Feed the cumulative markdown of the current text block. Claudian starts a new block
   * after thinking or a tool call, so text that no longer extends the previous block is
   * treated as a fresh block: the unfinished tail is spoken and the cursor restarts.
   */
  push(cumulativeMarkdown: string): string[] {
    const out: string[] = [];
    if (!cumulativeMarkdown.startsWith(this.#lastRaw)) {
      out.push(...this.flush());
      this.#spokenChars = 0;
    }
    this.#lastRaw = cumulativeMarkdown;
    const speakable = toSpeakable(cumulativeMarkdown);
    const fresh = speakable.slice(this.#spokenChars);
    const { sentences, rest } = splitSentences(fresh);
    this.#spokenChars += fresh.length - rest.length;
    this.#pending = rest;
    out.push(...sentences);
    return out;
  }

  /**
   * For the very first utterance: if the opening sentence is running long, take what is
   * complete up to a clause break so speech can start without waiting for the full stop.
   */
  takeLeadingClause(minChars: number): string | null {
    const pending = this.#pending;
    if (pending.length < minChars) return null;
    const match = new RegExp(`^([\\s\\S]{${minChars},}?[,;:])\\s`).exec(pending.slice(0, Math.max(minChars, 220)) + ' ');
    if (!match) return null;
    const clause = match[1] ?? '';
    const rest = pending.slice(clause.length).replace(/^\s+/, '');
    this.#spokenChars += pending.length - rest.length;
    this.#pending = rest;
    return clause.trim() || null;
  }

  /** The turn ended: whatever is left is a sentence now. */
  flush(): string[] {
    const rest = this.#pending.trim();
    this.#pending = '';
    this.#spokenChars += rest.length;
    return rest ? [rest] : [];
  }

  reset(): void {
    this.#spokenChars = 0;
    this.#pending = '';
    this.#lastRaw = '';
  }
}

const CANCEL_PHRASES = ['cancel', 'never mind', 'nevermind', 'scratch that', 'stop', 'forget it'];

/** True when an utterance is only a cancel phrase, so it should not be sent as a prompt. */
export function isCancelPhrase(utterance: string): boolean {
  const normalized = utterance.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  return CANCEL_PHRASES.includes(normalized);
}
