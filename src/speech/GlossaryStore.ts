import type { App } from 'obsidian';

import { buildTranscriptionPrompt, parseGlossary } from './glossary';

export interface GlossaryStoreOptions {
  getSettingsTerms: () => string;
  /** Vault-relative path, e.g. `.claudian/voice-glossary.md`. Empty disables the file. */
  getFilePath: () => string;
}

/** Merges settings terms with the vault glossary file and caches the prompt between reads. */
export class GlossaryStore {
  #fileTerms: string[] = [];
  #loadedPath = '';
  #loadedAt = 0;

  constructor(private readonly app: App, private readonly options: GlossaryStoreOptions) {}

  /** Cheap to call per utterance; re-reads the file at most every few seconds. */
  async refresh(): Promise<void> {
    const path = this.options.getFilePath().trim();
    const now = Date.now();
    if (!path) { this.#fileTerms = []; this.#loadedPath = ''; return; }
    if (path === this.#loadedPath && now - this.#loadedAt < 5000) return;
    this.#loadedPath = path;
    this.#loadedAt = now;
    try {
      const exists = await this.app.vault.adapter.exists(path);
      this.#fileTerms = exists ? parseGlossary(await this.app.vault.adapter.read(path)) : [];
    } catch {
      this.#fileTerms = [];
    }
  }

  terms(): string[] {
    return [...new Set([...parseGlossary(this.options.getSettingsTerms()), ...this.#fileTerms])];
  }

  prompt(): string {
    return buildTranscriptionPrompt(this.terms());
  }

  /** Appends terms to the vault file, creating it (and its folder) when missing. */
  async addToFile(terms: string[]): Promise<void> {
    const path = this.options.getFilePath().trim();
    if (!path || terms.length === 0) return;
    const adapter = this.app.vault.adapter;
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (folder && !(await adapter.exists(folder))) await adapter.mkdir(folder);
    const existing = (await adapter.exists(path)) ? await adapter.read(path) : '# Voice glossary\n\nOne term per line. Names, products, and jargon the transcriber should spell correctly.\n\n';
    const known = new Set(parseGlossary(existing));
    const fresh = terms.map(term => term.trim()).filter(term => term && !known.has(term));
    if (fresh.length === 0) return;
    const body = existing.endsWith('\n') ? existing : `${existing}\n`;
    await adapter.write(path, `${body}${fresh.map(term => `- ${term}`).join('\n')}\n`);
    this.#loadedAt = 0;
  }
}
