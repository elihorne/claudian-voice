/**
 * Loaded before the test files (see the `test` script). The plugin's timers go through
 * `window`, which node does not have; alias it to the global object so they run.
 */
if (typeof window === 'undefined') {
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
}
