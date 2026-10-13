/**
 * Vocabulary the transcriber should know: product names, colleagues, project codenames.
 * Terms come from the plugin settings and from a markdown file in the vault, so they sync
 * with the vault across machines (the request in YishenTu/claudian#1030).
 */

/** Parses one term per line or comma-separated; ignores headings, blanks, and comments. */
export function parseGlossary(text: string): string[] {
  const terms = new Set<string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^\s*[-*+]\s+/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('<!--') || line.startsWith('//')) continue;
    for (const part of line.split(',')) {
      const term = part.trim();
      if (term) terms.add(term);
    }
  }
  return [...terms];
}

/**
 * Whisper's `prompt` is treated as preceding transcript, so a natural sentence that happens
 * to contain the terms steers spelling better than a bare list. Capped to stay well inside
 * the 224-token window whisper-1 reads.
 */
export function buildTranscriptionPrompt(terms: string[], maxChars = 600): string {
  if (terms.length === 0) return '';
  const unique = [...new Set(terms.map(term => term.trim()).filter(Boolean))];
  let body = '';
  for (const term of unique) {
    const next = body ? `${body}, ${term}` : term;
    if (next.length > maxChars) break;
    body = next;
  }
  return `Terms that may come up: ${body}.`;
}
