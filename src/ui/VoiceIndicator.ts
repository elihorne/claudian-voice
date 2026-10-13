import { type App, setIcon } from 'obsidian';

import type { VoiceState } from '../voice/VoiceSession';

const CLAUDIAN_VIEW_TYPE = 'claudian-view';

/**
 * A small orb pinned to the top of every Claudian chat view while a voice session runs.
 * State is carried by colour and motion: red ring that breathes with your mic level while
 * listening, accent pulse while the agent thinks, green bars while it speaks. Text appears
 * only on hover, or when something went wrong. Uses only Obsidian's public workspace API.
 */
export class VoiceIndicator {
  #pills = new Map<HTMLElement, HTMLElement>();
  #state: VoiceState = { phase: 'idle' };

  constructor(private readonly app: App, private readonly onStop: () => void) {}

  update(state: VoiceState): void {
    this.#state = state;
    if (state.phase === 'idle') {
      this.unmount();
      return;
    }
    this.#mountAll();
    for (const pill of this.#pills.values()) this.#render(pill, state);
  }

  /** Re-attach after layout changes (new leaves, closed leaves). */
  refresh(): void {
    if (this.#state.phase === 'idle') return;
    this.#mountAll();
    for (const pill of this.#pills.values()) this.#render(pill, this.#state);
  }

  unmount(): void {
    for (const pill of this.#pills.values()) pill.remove();
    this.#pills.clear();
  }

  #mountAll(): void {
    const live = new Set<HTMLElement>();
    for (const leaf of this.app.workspace.getLeavesOfType(CLAUDIAN_VIEW_TYPE)) {
      const host = leaf.view.containerEl;
      live.add(host);
      if (this.#pills.has(host)) continue;
      const pill = host.createDiv({ cls: 'claudian-voice-pill' });
      pill.setAttribute('role', 'status');
      pill.setAttribute('aria-live', 'polite');
      const orb = pill.createDiv({ cls: 'claudian-voice-orb' });
      orb.createDiv({ cls: 'claudian-voice-orb-ring' });
      orb.createDiv({ cls: 'claudian-voice-orb-core' });
      const bars = orb.createDiv({ cls: 'claudian-voice-orb-bars' });
      for (let index = 0; index < 3; index += 1) bars.createDiv({ cls: 'claudian-voice-orb-bar' });
      pill.createSpan({ cls: 'claudian-voice-pill-label' });
      const stop = pill.createEl('button', { cls: 'claudian-voice-pill-stop clickable-icon', attr: { type: 'button', 'aria-label': 'Stop voice session' } });
      setIcon(stop, 'x');
      stop.addEventListener('click', event => { event.stopPropagation(); this.onStop(); });
      this.#pills.set(host, pill);
    }
    for (const [host, pill] of this.#pills) {
      if (!live.has(host) || !host.isConnected) {
        pill.remove();
        this.#pills.delete(host);
      }
    }
  }

  #render(pill: HTMLElement, state: VoiceState): void {
    pill.dataset.phase = state.phase;
    const text = labelFor(state);
    pill.setAttribute('aria-label', text);
    pill.setAttribute('title', text);
    const label = pill.querySelector<HTMLElement>('.claudian-voice-pill-label');
    // Words appear for the live transcript while you speak, and for errors; otherwise the orb carries it.
    if (label) {
      if (state.phase === 'error') label.setText(text);
      else if (state.phase === 'listening' && state.transcript) label.setText(state.transcript);
      else label.setText('');
    }
    pill.toggleClass('has-text', !!label?.textContent);
    if (state.phase === 'listening') {
      pill.style.setProperty('--claudian-voice-level', String(Math.min(1, state.level * 14)));
    }
  }
}

export function labelFor(state: VoiceState): string {
  switch (state.phase) {
    case 'idle': return 'Voice off';
    case 'listening': return 'Listening';
    case 'transcribing': return 'Transcribing';
    case 'thinking': return 'Waiting for reply';
    case 'speaking': return 'Speaking';
    case 'error': return state.message;
  }
}
