/**
 * Window-bound timers, as Obsidian asks of plugins (popout windows have their own). Under
 * node, where the pure-logic modules are tested, tests/setup.ts aliases `window` to the
 * global object before any test file loads.
 */
export type TimerId = number;

export function setTimer(callback: () => void, ms: number): TimerId {
  return window.setTimeout(callback, ms);
}

export function clearTimer(id: TimerId | null | undefined): void {
  if (id != null) window.clearTimeout(id);
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimer(resolve, ms); });
}
