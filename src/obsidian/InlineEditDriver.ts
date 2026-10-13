import type { App } from 'obsidian';

const COMMAND_ID = 'realclaudian:inline-edit';
const INPUT_SELECTOR = 'input.claudian-inline-input';

/**
 * Runs Claudian's inline edit with a spoken instruction. Claudian has no programmatic
 * entry point for this yet, so we open its command and type into the modal's input, which
 * submits on Enter. Fragile by nature; replace with the API once one exists (see ROADMAP).
 */
export class InlineEditDriver {
  constructor(private readonly app: App) {}

  isAvailable(): boolean {
    const commands = (this.app as unknown as { commands?: { commands?: Record<string, unknown> } }).commands;
    return !!commands?.commands?.[COMMAND_ID];
  }

  /** Opens inline edit for the current selection (or cursor) and submits `instruction`. */
  async run(instruction: string): Promise<boolean> {
    const text = instruction.trim();
    if (!text) return false;
    const commands = (this.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands;
    if (!commands.executeCommandById(COMMAND_ID)) return false;
    const input = await waitFor(() => document.querySelector<HTMLInputElement>(INPUT_SELECTOR), 2500);
    if (!input) return false;
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return true;
  }
}

function waitFor<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
  return new Promise(resolve => {
    const started = performance.now();
    const tick = () => {
      const value = probe();
      if (value) return resolve(value);
      if (performance.now() - started > timeoutMs) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}
