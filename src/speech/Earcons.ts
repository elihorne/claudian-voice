export type Earcon = 'start' | 'listen' | 'stop' | 'error';

/** Short synthesized cues so the user can hear state changes without looking. */
export class Earcons {
  #context: AudioContext | null = null;

  constructor(private readonly isEnabled: () => boolean) {}

  /** Resolves when the cue has finished, so a following recording does not capture it. */
  async play(kind: Earcon): Promise<void> {
    if (!this.isEnabled() || typeof AudioContext === 'undefined') return;
    const context = (this.#context ??= new AudioContext());
    await context.resume().catch(() => undefined);
    const notes = PATTERNS[kind];
    const start = context.currentTime + 0.02;
    let cursor = start;
    for (const note of notes) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = note.type ?? 'sine';
      osc.frequency.setValueAtTime(note.hz, cursor);
      gain.gain.setValueAtTime(0, cursor);
      gain.gain.linearRampToValueAtTime(note.gain ?? 0.18, cursor + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, cursor + note.ms / 1000);
      osc.connect(gain).connect(context.destination);
      osc.start(cursor);
      osc.stop(cursor + note.ms / 1000 + 0.02);
      cursor += (note.gapMs ?? note.ms) / 1000;
    }
    const total = (cursor - start) * 1000 + 60;
    await new Promise(resolve => window.setTimeout(resolve, total));
  }
}

interface Note { hz: number; ms: number; gapMs?: number; gain?: number; type?: OscillatorType }

const PATTERNS: Record<Earcon, Note[]> = {
  start: [{ hz: 587, ms: 110, gapMs: 90 }, { hz: 880, ms: 160 }],
  listen: [{ hz: 1047, ms: 70, gain: 0.1 }],
  stop: [{ hz: 880, ms: 110, gapMs: 90 }, { hz: 587, ms: 180 }],
  error: [{ hz: 196, ms: 220, gain: 0.14, type: 'triangle' }],
};
