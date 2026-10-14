/**
 * Timers bound to the window when one exists (Obsidian popout windows have their own), with
 * a fallback to the globals so the pure-logic modules run under node for tests.
 */
interface TimerHost {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const host: TimerHost = typeof window !== 'undefined'
  ? { setTimeout: (cb, ms) => window.setTimeout(cb, ms), clearTimeout: id => window.clearTimeout(id as number) }
  : { setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms), clearTimeout: id => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>) };

export type TimerId = unknown;

export function setTimer(callback: () => void, ms: number): TimerId {
  return host.setTimeout(callback, ms);
}

export function clearTimer(id: TimerId | null | undefined): void {
  if (id != null) host.clearTimeout(id);
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimer(resolve, ms); });
}
