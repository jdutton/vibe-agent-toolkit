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
 * asked of the volume, by an `lstat` of each absolute spelling (once per spelling). Every pair within
 * a fold group is compared. A pair collides when both exist on one `dev` and share `ino`, or when
 * either reports `ino` 0 (some SMB and FAT volumes): such a volume cannot prove two spellings
 * apart, so they may be one file. No pair that folds alike costs no `lstat`.
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

/**
 * Whether two identities may name one file: both known, on one volume, and one inode, or an inode of
 * 0 on either side, which cannot prove them apart.
 */
function mayBeOneFile(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  if (left.dev !== right.dev) return false;
  return left.ino === 0n || right.ino === 0n || left.ino === right.ino;
}

/** The first pair of `group` (snapshot order) that may be one file; each spelling is asked of the volume once. */
function collisionIn(
  group: ReadonlyArray<{ readonly absolutePath: string; readonly gitPath: string }>,
  identityOf: (absolutePath: string) => FileIdentity | undefined,
): readonly [string, string] | undefined {
  const identities = group.map((entry) => identityOf(entry.absolutePath));
  for (let right = 1; right < group.length; right++) {
    for (let left = 0; left < right; left++) {
      if (mayBeOneFile(identities[left], identities[right])) return [group[left]?.gitPath ?? '', group[right]?.gitPath ?? ''];
    }
  }
  return undefined;
}

/**
 * The first pair of snapshot paths that fold alike and may name one file on disk.
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
  const groups = new Map<string, Array<{ readonly absolutePath: string; readonly gitPath: string }>>();
  for (const entry of entries) {
    // A git path is `/`-separated by git's own contract: fold each segment between the slashes.
    const folded = entry.gitPath.replaceAll(/[^/]+/g, foldOf);
    const group = groups.get(folded);
    if (group === undefined) groups.set(folded, [entry]);
    else group.push(entry);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const collision = collisionIn(group, identityOf);
    if (collision !== undefined) return collision;
  }
  return undefined;
}
