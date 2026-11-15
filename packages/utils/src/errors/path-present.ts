/**
 * The one presence predicate: is something at this path — asked so that "I could
 * not look" can never read as "nothing there".
 *
 * `existsSync` answers `false` for `ENOENT` and equally for `EACCES` (a parent the
 * process may not search), `ELOOP` and every other errno, so a refused path goes on
 * as an absent one. Here only the classifier's `absent` class can answer `false`;
 * anything else is thrown classified (`local/no-existssync` points every caller here).
 */

import { lstatSync } from 'node:fs';

import { requireFollowedStatSync } from '../link-following.js';
import { safePath } from '../path-core.js';
import { LinkChainRefusedError, walkHostChain } from '../tree-change/host-chain.js';
import { HOST_PATH_FLAVOR, type LinkChain } from '../tree-change/link-chain.js';

import { requireConfirmedAbsent } from './confirmed-absent.js';
import { isPathAbsentError, isUnresolvableLinkError } from './errno-table.js';
import { classifyFsFault, refusedPathOf, type SideOfPath } from './fs-fault.js';

/** How a presence probe treats a link: see {@link pathPresent}. */
export type PresenceMode = 'entry' | { readonly follow: string };

/**
 * Whether something is at `path`, asked the way the caller will USE the answer — so
 * neither choice is defaulted, and neither is inferred from `side`.
 *
 * `mode` — what counts as there:
 * - `'entry'` (`lstat`): is there a directory entry at all, a dangling link
 *   included? Right before writing there — `existsSync` calls a dangling link
 *   absent, and the copy then trips over it.
 * - `{ follow: within }` (`stat`): does it resolve to something that can be read? Right
 *   before reading or staging from it — a dangling link is absent, so the caller
 *   refuses it by its own "not there" message instead of failing later. `within` is the
 *   tree the path is crawled in (the operator's own input, or the path itself when it IS
 *   the operator's own): every link beneath it is read by its text before the kernel
 *   follows it (`link-following.ts`), and a chain VAT will not hand the kernel is a fault
 *   on `side`, of class `refused`.
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
 * @param sideOf - The caller's side of each path the probe may touch — `path` itself, each
 *   component a followed probe walks beneath `within`, and (`'confirmed'`) the parent it lists:
 *   `source` for one it reads or stages from, `destination` for one it is about to write or that
 *   the run itself wrote. A refusal is charged to the side of the path the OS refused.
 * @throws {FsFaultError} when the OS refuses the probe, or (`'confirmed'`) the parent lists what it called absent
 */
export function pathPresent(path: string, mode: PresenceMode, sideOf: SideOfPath, absence: 'confirmed' | 'probe'): boolean {
  const ctx = { origin: 'content', action: 'examine the path', path } as const;
  try {
    if (mode === 'entry') lstatSync(path);
    else requireFollowedStatSync(path, mode.follow);
    return true;
  } catch (error) {
    // Followed, a chain that leads to nothing — a dangle or a cycle — is absent, as a missing path is.
    const absent = mode === 'entry' ? isPathAbsentError(error) : isUnresolvableLinkError(error);
    if (!absent) throw classifyFsFault(error, { ...ctx, side: sideOf(refusedPathOf(error, path)) });
    if (absence === 'confirmed') requireConfirmedAbsent(path, error, ctx, { follows: mode !== 'entry', sideOf });
    return false;
  }
}

/** The NUL no filesystem name can hold. */
const NUL = String.fromCodePoint(0);

/**
 * Whether `name` is in the directory `dir`, its link followed — the probe of each level of a
 * root-discovery walk (`project-utils.ts`, `git-utils.ts`). Those walks climb from inside CRAWLED
 * trees (`vat audit` asks `findProjectRoot` of every skill directory it finds), so the entry can be
 * a link the tree's author planted.
 *
 * Answered by the link-chain walk ALONE — `lstat` and `readlink`, the kernel never asked to follow
 * anything: `dir` is taken as spelled (the walk is already standing in it), and the entry's chain
 * is read from there. A chain that ends at a file or a directory is present; one that leads to
 * nothing (absent, a dangle, a cycle) is not; one through a network or device path is a `refused`
 * fault on `source`, as a probe the OS refused is — never "absent". Neither `dir` nor its ancestors
 * are resolved by the kernel: a crawled directory's own chain is not this probe's to follow, and a
 * refused resolution of a corpus root stays the refusal of the lane that resolves it. A `dir` whose
 * spelling holds a NUL holds nothing (no filesystem has such a name), and the walk goes on to its
 * parent.
 *
 * @throws FsFaultError on `source` when the OS refuses a probe or the chain is one VAT will not follow
 */
export function entryPresentIn(dir: string, name: string): boolean {
  if (dir.includes(NUL)) return false;
  const path = safePath.join(dir, name);
  const ctx = { side: 'source', origin: 'content', action: 'examine the path', path } as const;
  let chain: LinkChain;
  try {
    chain = walkHostChain(path, { flavor: HOST_PATH_FLAVOR, root: safePath.resolve(dir), outside: 'follow' });
  } catch (error: unknown) {
    throw classifyFsFault(error, ctx);
  }
  if (chain.kind === 'refused') throw classifyFsFault(new LinkChainRefusedError(path, chain.refusal), ctx);
  return chain.kind === 'resolved';
}
