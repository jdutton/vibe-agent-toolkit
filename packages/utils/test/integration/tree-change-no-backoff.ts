/**
 * What a tree-change suite puts in place of `node:timers/promises`, so the win32 rename retry's
 * backoff (50·2ⁿ ms, 1.55 s over six tries) is RECORDED instead of waited out:
 *
 * ```ts
 * vi.mock('node:timers/promises', () => import('./tree-change-no-backoff.js'));
 * ```
 *
 * A suite that refuses a rename on every try (`everyTry`) would otherwise spend the whole backoff
 * per case wherever renames are retried — on Windows itself, and under a stubbed win32. The bound
 * is pinned by what was asked for ({@link backoffWaits}), which a clock never could to the millisecond.
 */

/** Every wait the code under test asked for, in order, in milliseconds. A suite empties it before each test. */
export const backoffWaits: number[] = [];

/** `timers/promises` `setTimeout`, resolved at once: the wait is recorded, not served. */
export function setTimeout(ms: number): Promise<void> {
  backoffWaits.push(ms);
  return Promise.resolve();
}
