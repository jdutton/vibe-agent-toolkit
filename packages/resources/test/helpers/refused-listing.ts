/**
 * A directory that REFUSES to be listed, produced on demand and by errno.
 *
 * ## Why a spy and not a `chmod`
 *
 * `chmod` can produce exactly one of the four errnos that mean "refused"
 * (`EACCES`), and only where POSIX mode bits bind — not on Windows, and not as
 * root, which ignores them. A suite built on `chmod` alone therefore pins one
 * row of the mapping and skips itself on the platforms where the other rows are
 * just as reachable.
 *
 * The other three are not exotic. `EMFILE` and `ENFILE` are descriptor
 * exhaustion, which a large corpus reaches under concurrency and which is
 * *transient* — the worst kind, because the run that hits it looks like an
 * ordinary run. `ELOOP` is a symlink cycle an adopter can commit to a
 * repository.
 *
 * ## ⛔ Why this is shared rather than copied
 *
 * Two lanes ask the same question of the same `FsLookupCache` — `vat okf
 * validate`'s cross-link judge and `vat resources validate`'s link judge — and
 * they had already drifted apart once on this exact distinction. Two copies of
 * the fixture is how they drift again, and the duplication gate would refuse it
 * anyway.
 */

import nodeFsPromises from 'node:fs/promises';

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { vi } from 'vitest';

/**
 * Every errno `listingFailure` maps to `directory_unreadable` — the whole set.
 *
 * The mapping is "anything that is not a recognised ABSENCE errno", so this is
 * the representative sample of a much larger space, chosen for what each one
 * means to an adopter rather than for coverage of a branch.
 */
export const REFUSAL_ERRNOS = ['EACCES', 'EMFILE', 'ENFILE', 'ELOOP'] as const;

/**
 * Run `body` with `readdir` of exactly `directory` rejecting with `code`.
 *
 * Every other directory is delegated to the real call, so what the walk sees is
 * one refused listing inside an otherwise ordinary tree — which is the shape
 * that matters: a judge that gave up on the whole walk would pass a test where
 * everything was refused.
 *
 * @param directory - Absolute path of the one directory to refuse
 * @param code - The errno to reject with
 * @param body - Runs while the refusal is in force
 * @returns Whatever `body` returned
 */
export async function withReaddirRefused<T>(
  directory: string,
  code: string,
  body: () => Promise<T>,
): Promise<T> {
  const original = nodeFsPromises.readdir.bind(nodeFsPromises);
  const spy = vi.spyOn(nodeFsPromises, 'readdir').mockImplementation((async (
    target: unknown,
    ...rest: unknown[]
  ) => {
    if (toForwardSlash(String(target)) === toForwardSlash(directory)) {
      throw Object.assign(new Error(`${code}: refused, scandir '${String(target)}'`), { code });
    }
    return await (original as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
  }) as unknown as typeof nodeFsPromises.readdir);

  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}
