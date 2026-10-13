import { type App, type Editor, MarkdownView } from 'obsidian';

import type { Speaker } from '../speech/types';
import { toSpeakable } from './speakable';

export interface ReadAloudDeps {
  app: App;
  speaker: Speaker;
  onState: (reading: boolean) => void;
}

interface Paragraph {
  fromLine: number;
  toLine: number;
  text: string;
  isHeading: boolean;
}

/**
 * Reads the active note aloud paragraph by paragraph, highlighting and scrolling the editor
 * to the paragraph being spoken. Starts from the cursor's paragraph so "read from here"
 * works. Skip jumps to the next heading. Entirely local apart from speech synthesis.
 */
export class ReadAloud {
  #paragraphs: Paragraph[] = [];
  #index = 0;
  #running = false;
  #skipRequested = false;
  #editor: Editor | null = null;
  #savedSelection: { from: { line: number; ch: number }; to: { line: number; ch: number } } | null = null;

  constructor(private readonly deps: ReadAloudDeps) {}

  get isReading(): boolean {
    return this.#running;
  }

  async start(): Promise<boolean> {
    if (this.#running) return true;
    const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor;
    if (!editor) return false;
    this.#editor = editor;
    this.#paragraphs = splitParagraphs(editor.getValue());
    if (this.#paragraphs.length === 0) return false;
    const cursorLine = editor.getCursor().line;
    this.#index = Math.max(0, this.#paragraphs.findIndex(paragraph => paragraph.toLine >= cursorLine));
    this.#savedSelection = { from: editor.getCursor('from'), to: editor.getCursor('to') };
    this.#running = true;
    this.deps.onState(true);
    void this.#loop();
    return true;
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.deps.speaker.cancel();
    this.#restoreSelection();
    this.deps.onState(false);
  }

  /** Jump to the next heading (or the next paragraph when there is no later heading). */
  skip(): void {
    if (!this.#running) return;
    this.#skipRequested = true;
    this.deps.speaker.cancel();
  }

  async #loop(): Promise<void> {
    while (this.#running && this.#index < this.#paragraphs.length) {
      const paragraph = this.#paragraphs[this.#index];
      if (!paragraph) break;
      this.#highlight(paragraph);
      const speakable = toSpeakable(paragraph.text);
      if (speakable) await this.deps.speaker.speak(speakable);
      if (!this.#running) return;
      if (this.#skipRequested) {
        this.#skipRequested = false;
        const nextHeading = this.#paragraphs.findIndex((candidate, index) => index > this.#index && candidate.isHeading);
        this.#index = nextHeading === -1 ? this.#index + 1 : nextHeading;
      } else {
        this.#index += 1;
      }
    }
    if (this.#running) this.stop();
  }

  #highlight(paragraph: Paragraph): void {
    const editor = this.#editor;
    if (!editor) return;
    const lastLine = editor.getLine(paragraph.toLine) ?? '';
    editor.setSelection({ line: paragraph.fromLine, ch: 0 }, { line: paragraph.toLine, ch: lastLine.length });
    editor.scrollIntoView({ from: { line: paragraph.fromLine, ch: 0 }, to: { line: paragraph.toLine, ch: 0 } }, true);
  }

  #restoreSelection(): void {
    if (this.#editor && this.#savedSelection) {
      this.#editor.setSelection(this.#savedSelection.from, this.#savedSelection.to);
    }
    this.#savedSelection = null;
    this.#editor = null;
  }
}

/** Groups lines into paragraphs; headings stand alone so skip can target them. Frontmatter is dropped. */
export function splitParagraphs(markdown: string): Paragraph[] {
  const lines = markdown.split('\n');
  const paragraphs: Paragraph[] = [];
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) start = end + 1;
  }
  let current: string[] = [];
  let currentFrom = start;
  const flush = (toLine: number) => {
    const text = current.join('\n').trim();
    if (text) paragraphs.push({ fromLine: currentFrom, toLine, text, isHeading: false });
    current = [];
  };
  let inFence = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*```/.test(line)) inFence = !inFence;
    const isHeading = !inFence && /^\s{0,3}#{1,6}\s+/.test(line);
    if (isHeading) {
      flush(index - 1);
      paragraphs.push({ fromLine: index, toLine: index, text: line, isHeading: true });
      currentFrom = index + 1;
      continue;
    }
    if (!inFence && line.trim() === '') {
      flush(index - 1);
      currentFrom = index + 1;
      continue;
    }
    if (current.length === 0) currentFrom = index;
    current.push(line);
  }
  flush(lines.length - 1);
  return paragraphs;
}
