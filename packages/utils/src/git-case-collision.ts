/**
 * Two snapshot paths the volume holds as ONE file.
 *
 * git's index can hold `A.md` and `a.md` together (a commit made on a case-sensitive volume, or an
 * entry added with `update-index --cacheinfo`). Checked out where the volume folds case (or Unicode
 * normalisation), the two are one file on disk while the snapshot lists two entries, each with its
 * own staged bytes: at most one of them describes the disk. A tree key declines such a tree
 * (`case-collision`).
 *
 * The rule is exact per pair, never a guess from the platform: the snapshot's paths are folded in
 * memory by `foldedSegment` (stricter than any one volume), and only a pair that folds alike is
 * asked of the volume, by an `lstat` of both absolute spellings. It collides when both exist and
 * share `dev` and `ino`. No pair that folds alike costs no `lstat`.
 */

import { lstatSync } from 'node:fs';

import { fsFaultOf, isPathAbsentError } from './errors/errno-table.js';
import { foldedSegment } from './name-fold.js';

/** What `lstat` says a path is: the volume and the inode. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * The identity of what `absolutePath` names. Nothing there, or a stat the OS refuses, is
 * `undefined`: neither proves an alias.
 *
 * @param absolutePath - The path, as the snapshot spells it
 * @returns Its `dev` and `ino`, or `undefined`
 */
export function lstatIdentity(absolutePath: string): FileIdentity | undefined {
  try {
    const { dev, ino } = lstatSync(absolutePath, { bigint: true });
    return { dev, ino };
  } catch (error) {
    if (isPathAbsentError(error) || fsFaultOf(error) !== undefined) return undefined;
    throw error;
  }
}

/** Whether two identities name one file: both known, same volume and inode (an inode of 0 proves nothing). */
function sameFile(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (left === undefined || right === undefined || left.ino === 0n) return false;
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * The first pair of snapshot paths that fold alike and name one file on disk.
 *
 * @param entries - The snapshot's entries
 * @param identityOf - The volume's answer for one absolute path ({@link lstatIdentity})
 * @returns The two git paths, in snapshot order, or `undefined` when no pair collides
 */
export function caseCollisionOf(
  entries: ReadonlyArray<{ readonly absolutePath: string; readonly gitPath: string }>,
  identityOf: (absolutePath: string) => FileIdentity | undefined,
): readonly [string, string] | undefined {
  const folds = new Map<string, string>();
  const foldOf = (segment: string): string => {
    let folded = folds.get(segment);
    if (folded === undefined) {
      folded = foldedSegment(segment);
      folds.set(segment, folded);
    }
    return folded;
  };
  const seen = new Map<string, { readonly absolutePath: string; readonly gitPath: string }>();
  for (const entry of entries) {
    // A git path is `/`-separated by git's own contract: fold each segment between the slashes.
    const folded = entry.gitPath.replaceAll(/[^/]+/g, foldOf);
    const other = seen.get(folded);
    if (other === undefined) {
      seen.set(folded, entry);
    } else if (sameFile(identityOf(other.absolutePath), identityOf(entry.absolutePath))) {
      return [other.gitPath, entry.gitPath];
    }
  }
  return undefined;
}
