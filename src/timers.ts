/**
 * Timers bound to the window (Obsidian popout windows have their own), with a fallback so the
 * pure-logic modules also run under node for tests, where there is no window.
 */
interface TimerHost {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const nodeHost: TimerHost = {
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimeout: id => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
};

const host: TimerHost = typeof window === 'undefined' ? nodeHost : window;

export type TimerId = number;

export function setTimer(callback: () => void, ms: number): TimerId {
  return host.setTimeout(callback, ms);
}

export function clearTimer(id: TimerId | null | undefined): void {
  if (id != null) host.clearTimeout(id);
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimer(resolve, ms); });
}
