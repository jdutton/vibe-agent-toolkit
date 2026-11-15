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
 * ordinary run. `EPERM` is the OS refusing outright where no mode bit is
 * involved (a Windows ACL deny, a macOS privacy protection).
 *
 * `ELOOP` is NOT one of them for a link judge: the link validator's existence
 * walk asks the one link predicate (`isUnresolvableLinkError`), so a listing
 * that fails `ELOOP` is a missing target there, as it is to the realpath beside
 * it — see {@link LINK_ABSENCE_ERRNOS}. Windows' ambiguous `EINVAL` and
 * `ENAMETOOLONG` ARE refusals: libuv answers each for more than one Win32 error,
 * so neither can mean "nothing there".
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
 * Errnos a link judge reads as a REFUSED listing (`directory_unreadable`).
 *
 * The mapping is "anything that is neither a recognised absence errno nor one
 * the link predicate calls unresolvable", so this is the representative sample
 * of a much larger space, chosen for what each one means to an adopter rather
 * than for coverage of a branch.
 */
const REFUSAL_MEANINGS = {
  EACCES: 'a mode bit refuses the listing',
  EPERM: 'the OS refuses outright, no mode bit involved',
  EMFILE: 'this process ran out of descriptors (transient)',
  ENFILE: 'the system ran out of descriptors (transient)',
  EINVAL: 'Windows: one of four Win32 errors libuv cannot tell apart (src/win/error.c:102-105)',
  ENAMETOOLONG: 'Windows: ERROR_BUFFER_OVERFLOW (src/win/error.c:129), not a name the link spells',
  ENETUNREACH: 'the network to a share failed mid-walk',
  EWHATEVER: 'an errno no table lists: still a refusal, never handed back raw',
} as const;

/** The errnos of {@link REFUSAL_MEANINGS}, each injected as a refused listing. */
export const REFUSAL_ERRNOS = Object.keys(REFUSAL_MEANINGS) as Array<keyof typeof REFUSAL_MEANINGS>;

/**
 * Listing errnos the link predicate calls unresolvable beyond the `absent` class (a committed
 * symlink cycle): a link judge reads them as a missing target — the answer the realpath beside the
 * walk gives the same link.
 */
const LINK_ABSENCE_MEANINGS = {
  ELOOP: 'a committed symlink cycle',
} as const;

/** The errnos of {@link LINK_ABSENCE_MEANINGS}, each injected as a failed listing. */
export const LINK_ABSENCE_ERRNOS = Object.keys(LINK_ABSENCE_MEANINGS) as Array<keyof typeof LINK_ABSENCE_MEANINGS>;

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
  // The walk under test always lists by string path; a Buffer or URL here would
  // be a new caller this helper has never met, and stringifying it silently
  // would only hide that.
  const spy = vi.spyOn(nodeFsPromises, 'readdir').mockImplementation((async (
    target: string,
    ...rest: unknown[]
  ) => {
    if (toForwardSlash(target) === toForwardSlash(directory)) {
      throw Object.assign(new Error(`${code}: refused, scandir '${target}'`), { code, syscall: 'scandir', path: target });
    }
    return await (original as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
  }) as unknown as typeof nodeFsPromises.readdir);

  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}
