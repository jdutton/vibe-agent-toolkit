/**
 * Deciding sameness and containment from entry identities already read off the filesystem.
 * Pure: the examination is handed in, so the decision is the same whoever asked the OS.
 */

import path from 'node:path';

import { isFsFaultError } from '../errors/fs-fault.js';

/** One way an entry answers to being identified: a filesystem id, or a folded real path when the filesystem reports none. */
export type Identity = { readonly id: string } | { readonly foldedRealPath: string };

/** Whether two entries are one. `unknown` means it could not be decided: treat it as `same` when deciding whether to delete. */
export type EntrySameness = 'same' | 'different' | 'unknown';

/** Whether an entry lies strictly under another. `unknown` means it could not be decided. */
export type EntryContainment = 'inside' | 'outside' | 'unknown';

function hasFold(identities: readonly Identity[]): boolean {
  return identities.some((identity) => 'foldedRealPath' in identity);
}

/** One entry when both are filesystem ids and equal, or both are folds and equal; an id never equals a fold. */
function sameIdentity(left: Identity, right: Identity): boolean {
  if ('id' in left && 'id' in right) return left.id === right.id;
  return 'foldedRealPath' in left && 'foldedRealPath' in right && left.foldedRealPath === right.foldedRealPath;
}

function compare(left: readonly Identity[], right: readonly Identity[]): EntrySameness {
  if (left.length === 0 || right.length === 0) return 'different';
  if (left.some((l) => right.some((r) => sameIdentity(l, r)))) return 'same';
  return hasFold(left) || hasFold(right) ? 'unknown' : 'different';
}

/** What one round of identity questions needs: each entry's identities, or `undefined` when the OS refuses to examine it. */
export type Examiner = (entry: string) => readonly Identity[] | undefined;

export function sameBy(examine: Examiner, a: string, b: string): EntrySameness {
  const left = examine(a);
  const right = examine(b);
  return left === undefined || right === undefined ? 'unknown' : compare(left, right);
}

export function insideBy(examine: Examiner, child: string, ancestor: string): EntryContainment {
  const wanted = examine(ancestor);
  if (wanted === undefined) return 'unknown';
  let undecided = false;
  let current = child;
  for (let parent = path.dirname(current); parent !== current; parent = path.dirname(current)) {
    const found = examine(parent);
    const verdict = found === undefined ? 'unknown' : compare(found, wanted);
    if (verdict === 'same') return 'inside';
    if (verdict === 'unknown') undecided = true;
    current = parent;
  }
  return undecided ? 'unknown' : 'outside';
}

/**
 * The identity a `stat` answers with: the filesystem's own id when it reports both a device and an
 * inode, else the fold — which is only computed then, since it costs a `realpath`.
 *
 * @param stats - The `dev` and `ino` of a `bigint` stat
 * @param fold - The folded real path, for a filesystem that reports no inode
 */
export function identityOf(stats: { readonly dev: bigint; readonly ino: bigint }, fold: () => Identity): Identity {
  return stats.dev !== 0n && stats.ino !== 0n ? { id: `${stats.dev}:${stats.ino}` } : fold();
}

/** Sameness and containment over one memo, and the one throwing examination of an entry they share. */
export interface IdentityOracle {
  /** The entry's identities, read once: a refusal is remembered and thrown again. */
  readonly identities: (entry: string) => readonly Identity[];
  /** Whether the OS refuses to examine `entry` (the remembered answer of {@link IdentityOracle.identities}). */
  readonly refuses: (entry: string) => boolean;
  readonly sameEntry: (a: string, b: string) => EntrySameness;
  readonly isInside: (child: string, ancestor: string) => EntryContainment;
}

/**
 * Identity questions that examine each entry ONCE: every answer is built from the same
 * observation of each entry. One plan's decisions asked the filesystem again and again,
 * so a refusal seen by one (subsumption: `unknown`) and not by the next (the overlap
 * check: `inside`) made the planner refuse its own plan.
 *
 * @param read - The examination: an entry's identities, or a thrown classified fault when the OS
 *   refuses. Anything else it throws is a defect and is never remembered as a refusal.
 */
export function identityOracleOver(read: (entry: string) => readonly Identity[]): IdentityOracle {
  const memo = new Map<string, { readonly ok: readonly Identity[] } | { readonly refused: unknown }>();
  const identities = (entry: string): readonly Identity[] => {
    let seen = memo.get(entry);
    if (seen === undefined) {
      try {
        seen = { ok: read(entry) };
      } catch (error: unknown) {
        if (!isFsFaultError(error)) throw error;
        seen = { refused: error };
      }
      memo.set(entry, seen);
    }
    if ('refused' in seen) throw seen.refused;
    return seen.ok;
  };
  const undecided: Examiner = (entry) => {
    try {
      return identities(entry);
    } catch (error: unknown) {
      if (isFsFaultError(error)) return undefined;
      throw error;
    }
  };
  return {
    identities,
    refuses: (entry) => undecided(entry) === undefined,
    sameEntry: (a, b) => sameBy(undecided, a, b),
    isInside: (child, ancestor) => insideBy(undecided, child, ancestor),
  };
}
