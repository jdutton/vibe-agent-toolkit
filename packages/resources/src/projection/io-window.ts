/**
 * The `io` window seam: inert unless the lab's counter installs it.
 *
 * The lab's I/O counter can restrict what it buckets to calls made while a
 * window is open, so a measurement names one stage (the resolve step, which
 * reads no disk) rather than the whole process. The counter installs a function
 * under `Symbol.for('vat.lab.io.window')` on `globalThis`, only when the lab
 * asked for a window. This module looks that symbol up and calls it; shipped
 * code reads no environment variable and allocates nothing when it is absent,
 * because the no-window answer is one shared function.
 */

/** The `globalThis` key the counter installs its window function under. */
const WINDOW_KEY = Symbol.for('vat.lab.io.window');

/** Closing a window that was never opened. Shared, so the inert path allocates nothing. */
const NO_CLOSE = (): void => {};

/**
 * Open an `io` window, when the lab's counter installed one.
 *
 * @returns The function that closes it; a shared no-op when no window is installed
 */
export function openIoWindow(): () => void {
  const open: unknown = Reflect.get(globalThis, WINDOW_KEY);
  if (typeof open !== 'function') {
    return NO_CLOSE;
  }
  const close: unknown = open();
  return typeof close === 'function' ? (close as () => void) : NO_CLOSE;
}
