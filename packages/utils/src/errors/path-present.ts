/**
 * The one presence predicate: is something at this path — asked so that "I could
 * not look" can never read as "nothing there".
 *
 * `existsSync` answers `false` for `ENOENT` and equally for `EACCES` (a parent the
 * process may not search), `ELOOP` and every other errno, so a refused path goes on
 * as an absent one. Here only the classifier's `absent` class can answer `false`;
 * anything else is thrown classified (`local/no-existssync` points every caller here).
 */

import { lstatSync, statSync } from 'node:fs';

import { requireConfirmedAbsent } from './confirmed-absent.js';
import { isPathAbsentError } from './errno-table.js';
import { classifyFsFault, type FsFaultContext, type FsSide } from './fs-fault.js';

/**
 * Whether something is at `path`, asked the way the caller will USE the answer — so
 * neither choice is defaulted, and neither is inferred from `side`.
 *
 * `mode` — what counts as there:
 * - `'entry'` (`lstat`): is there a directory entry at all, a dangling link
 *   included? Right before writing there — `existsSync` calls a dangling link
 *   absent, and the copy then trips over it.
 * - `'follow'` (`stat`): does it resolve to something that can be read? Right
 *   before reading or staging from it — a dangling link is absent, so the caller
 *   refuses it by its own "not there" message instead of failing later.
 *
 * `absence` — how far a "nothing there" answer is believed:
 * - `'confirmed'`: only once the parent's listing agrees (`requireConfirmedAbsent`).
 *   Right when a wrong "absent" would silently do less or overwrite: a place about to
 *   be written, an output the run itself made, a part of a package whose absence
 *   means "install without it".
 * - `'probe'`: the probe's own word. Right when the caller refuses or skips an absent
 *   path by its own "not there" — a wrong answer is then loud or harmless — and the
 *   listing is not worth one more read of the parent per probe.
 *
 * A `stat`/`lstat` the OS refuses is a classified fault on the caller's side, never
 * "absent"; so is an absence the listing contradicts. Origin `content` is recorded
 * for every path, a typed one included (`vat claude plugin install`'s source): the
 * only fault raised here is about what is on disk at the path, and a typed path that
 * is simply absent answers `false` for the caller to refuse in its own words.
 *
 * @param side - The caller's side of `path`: `source` for one it reads or stages from,
 *   `destination` for one it is about to write or that the run itself wrote
 * @throws {FsFaultError} when the OS refuses the probe, or (`'confirmed'`) the parent lists what it called absent
 */
export function pathPresent(path: string, mode: 'entry' | 'follow', side: FsSide, absence: 'confirmed' | 'probe'): boolean {
  const ctx: FsFaultContext = { side, origin: 'content', action: 'examine the path', path };
  try {
    if (mode === 'entry') lstatSync(path);
    else statSync(path);
    return true;
  } catch (error) {
    if (!isPathAbsentError(error)) throw classifyFsFault(error, ctx);
    if (absence === 'confirmed') requireConfirmedAbsent(path, error, ctx, { follows: mode === 'follow' });
    return false;
  }
}
