/**
 * The doubles the `no-blind-catch` suites share for injecting a REFUSAL.
 *
 * Every one of those suites asks the same question — what does this lane do
 * when the filesystem (or a reader) refuses, rather than reports an absence? —
 * and answers it the same way: patch one named function at its module seam,
 * make it fail for exactly one path, and let everything else run for real. A
 * `chmod` fixture reaches one errno, only where POSIX modes bind, and not as
 * root, so the injection is a patch on purpose.
 *
 * Written once here because the third copy of the `vi.mock` spread and the
 * "fail only this target" implementation tripped the duplication gate.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { vi } from 'vitest';

/** An error shaped the way Node shapes a filesystem refusal: a message and an errno. */
export function errno(code: string, message = `${code}: refused`): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * A `vi.mock` factory body: the real module with the named exports wrapped in
 * `vi.fn` pass-throughs, so a test can `vi.mocked(name).mockImplementation(…)`
 * for one case and every other call still reaches the real function.
 *
 * Called from inside the factory — `vi.mock` hoists, so the factory cannot
 * see a top-level import, but it can `await import()` this module:
 *
 * ```ts
 * vi.mock('node:fs', async (importOriginal) =>
 *   (await import('../helpers/refusal-doubles.js')).spiedModule(importOriginal, ['statSync']));
 * ```
 */
export async function spiedModule(
  importOriginal: () => Promise<Record<string, unknown>>,
  names: readonly string[],
): Promise<Record<string, unknown>> {
  const actual = await importOriginal();
  const spied = Object.fromEntries(
    names.map((name) => [name, vi.fn(actual[name] as (...args: unknown[]) => unknown)]),
  );
  return { ...actual, ...spied };
}

/**
 * An implementation for a spied path-taking function that THROWS `error` for
 * exactly `target` and delegates every other call to `real`.
 *
 * A synchronous throw serves the async functions too: `await stat(p)` inside a
 * `try` catches a throw from the call as readily as a rejection.
 */
export function refusingOnly<F extends (...args: never[]) => unknown>(
  target: string,
  error: Error,
  real: F,
): F {
  const resolvedTarget = safePath.resolve(target);
  return ((path: unknown, ...rest: unknown[]) => {
    if (safePath.resolve(String(path)) === resolvedTarget) throw error;
    return (real as (...args: unknown[]) => unknown)(path, ...rest);
  }) as unknown as F;
}

/**
 * The real implementation a `spiedModule` pass-through was created with, for
 * handing to {@link refusingOnly} as the delegate.
 */
export function realBehind<F extends (...args: never[]) => unknown>(spied: F): F {
  return vi.mocked(spied as (...args: unknown[]) => unknown).getMockImplementation() as unknown as F;
}
