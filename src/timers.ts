/**
 * Timers bound to the window when one exists (Obsidian popout windows have their own), with
 * a fallback to the globals so the pure-logic modules run under node for tests.
 */
const host: Pick<Window, 'setTimeout' | 'clearTimeout'> =
  typeof window !== 'undefined' ? window : { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout } as unknown as Window;

export function setTimer(callback: () => void, ms: number): number {
  return host.setTimeout(callback, ms) as unknown as number;
}

export function clearTimer(id: number | null | undefined): void {
  if (id != null) host.clearTimeout(id);
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimer(resolve, ms); });
}
