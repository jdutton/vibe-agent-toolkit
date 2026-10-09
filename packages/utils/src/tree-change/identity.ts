/**
 * Entry identity: are two names ONE entry on disk?
 *
 * Two changes to a tree can alias without sharing a spelling — `plugins/Old` and
 * `plugins/old` on APFS or NTFS, a link and its target, two links to one target.
 * Comparing names cannot see it, and acting on a wrong "different" deletes what the
 * user just installed. So identity is asked of the filesystem:
 *
 * - `dev` and `ino` both nonzero → the id `${dev}:${ino}`, from a `bigint` `lstat` of
 *   the entry, plus a `stat` of a link's target. A link answers to BOTH: removing it
 *   removes only the link, but it aliases its target.
 * - Otherwise (a filesystem that reports `ino` 0) → a folded real path: the real
 *   parent, a `/`, the base name, NFC then lower-cased. The fold can only err toward
 *   "same", which keeps what it is asked to remove.
 *
 * An entry the OS refuses to examine is `unknown`, never `different`: the caller
 * keeps. {@link entryIdentities} throws the refusal as an `FsFaultError` on the side
 * the CALLER names, so whatever surfaces it reports a classified fault, not a raw errno.
 */

import { lstatSync, statSync, type BigIntStats } from 'node:fs';
import path from 'node:path';

import { requireConfirmedAbsent } from '../errors/confirmed-absent.js';
import { isPathAbsentError } from '../errors/errno-table.js';
import { classifyFsFault, isFsFaultError, type FsSide } from '../errors/fs-fault.js';
import { toForwardSlash, toNfc } from '../path-core.js';
import { normalizePath } from '../path-utils.js';

import { type EntryContainment, type EntrySameness, type Identity, identityOf, type IdentityOracle, identityOracleOver, insideBy, sameBy } from './identity-compare.js';

/** Run `work` for `entry`; a filesystem refusal is rethrown classified on `side`, anything else as it was. */
function guarded<T>(entry: string, side: FsSide, work: () => T): T {
  try {
    return work();
  } catch (error: unknown) {
    throw classifyFsFault(error, { side, action: 'examine the entry', path: entry });
  }
}

/** The fold of `real` (an absolute path): its real parent, a `/`, its base name, NFC then lower-cased. */
function foldedRealPath(entry: string, side: FsSide, real: string): Identity {
  return guarded(entry, side, () => ({
    foldedRealPath: toNfc(`${toForwardSlash(normalizePath(path.dirname(real)))}/${path.basename(real)}`).toLowerCase(),
  }));
}

/**
 * `stat(entry)` for an entry that may be absent: `undefined` when nothing is there — believed only when
 * the parent's listing agrees — and a classified fault when the OS refuses.
 */
function examine(entry: string, side: FsSide, stat: (entry: string, options: { bigint: true }) => BigIntStats): BigIntStats | undefined {
  const ctx = { side, action: 'examine the entry', path: entry };
  try {
    return stat(entry, { bigint: true });
  } catch (error: unknown) {
    if (!isPathAbsentError(error)) throw classifyFsFault(error, ctx);
    // A `stat` follows a link (a dangling one is absent); an `lstat` sees the link itself.
    requireConfirmedAbsent(entry, error, ctx, { follows: stat === statSync });
    return undefined;
  }
}

/**
 * Every identity `entry` answers to: `[]` when nothing is there; its own (`lstat`) for
 * anything; plus its target's (`stat`) when it is a link that resolves.
 *
 * @param entry - Absolute path to identify
 * @param side - The side of the verb that named `entry`; every fault (the `lstat`, the `stat`, the real path of a fold) is raised on it
 * @throws FsFaultError on `side` when the OS refuses to examine `entry`
 */
export function entryIdentities(entry: string, side: FsSide): readonly Identity[] {
  const own = examine(entry, side, lstatSync);
  if (own === undefined) return [];
  const identities: Identity[] = [identityOf(own, () => foldedRealPath(entry, side, entry))];
  if (!own.isSymbolicLink()) return identities;
  const target = examine(entry, side, statSync);
  if (target !== undefined) {
    identities.push(identityOf(target, () => foldedRealPath(entry, side, guarded(entry, side, () => normalizePath(entry)))));
  }
  return identities;
}

/**
 * The identities of `entry`, or `undefined` when the OS refuses to examine it. The
 * side is irrelevant here: a refusal becomes `unknown` and never surfaces.
 */
function identitiesOrUndecided(entry: string): readonly Identity[] | undefined {
  try {
    return entryIdentities(entry, 'destination');
  } catch (error: unknown) {
    if (isFsFaultError(error)) return undefined;
    throw error;
  }
}

/**
 * Whether `a` and `b` are one entry. Any shared identity is `same`; identities on
 * both sides with a filesystem id each and none shared is `different`; a folded path
 * on either side that does not match is `unknown`; an entry the OS refuses to
 * examine is `unknown`; an absent entry is `different` (nothing there can alias).
 *
 * @param a - Absolute path
 * @param b - Absolute path
 */
export function sameEntry(a: string, b: string): EntrySameness {
  return sameBy(identitiesOrUndecided, a, b);
}

/**
 * Whether `child` lies strictly under `ancestor`, judged by identity: some directory
 * on the way up from `child` is the same entry as `ancestor`, so a linked or
 * case-aliased spelling of the ancestor is still found. `child` need not exist.
 * `unknown` when no ancestor proved `same` and one could not be examined.
 *
 * ⚠️ On a filesystem that reports `ino` 0 the answer for an existing `ancestor` is
 * `unknown`, never `outside`: a fold cannot prove two names apart. A caller that
 * refuses on `inside` must not refuse on `unknown`, or every copy there is refused.
 *
 * @param child - Absolute path
 * @param ancestor - Absolute path
 */
export function isInsideByIdentity(child: string, ancestor: string): EntryContainment {
  return insideBy(identitiesOrUndecided, child, ancestor);
}

/**
 * {@link sameEntry} and {@link isInsideByIdentity} over one memo: each entry is examined once
 * (`entryIdentities(entry, 'destination')`), so every answer of a plan is built from one observation.
 */
export function identityOracle(): IdentityOracle {
  return identityOracleOver((entry) => entryIdentities(entry, 'destination'));
}
