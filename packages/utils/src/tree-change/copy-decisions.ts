/**
 * The decisions of a tree copy that touch no filesystem: what it does about an entry already at a
 * name it is about to create, when two names are one, and the refusal two source entries with one
 * destination name get. `copy-tree.ts` is the half that makes the calls.
 */

import { FsFaultError } from '../errors/fs-fault.js';

/**
 * What a tree copy does about an entry ALREADY at a name it is about to create, below its root:
 * - `fresh`: the destination is new (a staged tree): anything there is refused (`EEXIST`), never adopted.
 * - `merge`: the destination is the caller's own output written again (a build directory): a real
 *   directory is adopted; a file or a link is REMOVED and made anew — never written through.
 *
 * Under both, an entry the copy itself made is never taken for one that was "already there": two
 * source names that are one name at the destination are refused ({@link aliasFault}).
 */
export type CopyOnto = 'fresh' | 'merge';

/** One entry the walk hands the copy: where it is, and where it is relative to the root (forward slashes). */
export interface CopiedEntry {
  readonly path: string;
  readonly relative: string;
}

/** The directory, relative to the root, that `relative` is in (`''`: the root). */
export const parentOf = (relative: string): string => (relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '');

/** The entry name of `relative`. */
export const nameOf = (relative: string): string => relative.slice(relative.lastIndexOf('/') + 1);

/** A name as a case- and normalisation-insensitive filesystem compares it, near enough to find a pair to name. */
const folded = (name: string): string => name.normalize('NFKD').toLowerCase();

/**
 * Whether two entry names are one name on a filesystem that folds letter case or Unicode form
 * (APFS, NTFS, exFAT, SMB). Asked only AFTER the OS answered `EEXIST` for the second of them, to say
 * which earlier entry it collided with: it names the pair, it never decides that there is one.
 */
export function sameNameWhereFolded(a: string, b: string): boolean {
  return folded(a) === folded(b);
}

/**
 * Whether a sibling this copy made, whose name folds to the name that just answered `EEXIST`, is the
 * entry it collided with — asked only when identity did not find one that is.
 *
 * It is not when the OS proved them TWO entries: both are there, each with an identity, none shared.
 * That is a tree that keeps the two names apart (case-sensitive), and what stands at the colliding
 * name was there before this copy — a `merge`'s previous output, to take over as any other.
 *
 * @param sameness - What identity answered for the sibling's copy against the colliding name
 * @param collidingPresent - Whether the colliding name holds an entry the copy can examine
 */
export function foldedNameIsTwin(sameness: 'same' | 'different' | 'unknown', collidingPresent: boolean): boolean {
  return !(sameness === 'different' && collidingPresent);
}

/**
 * What a copy does at a name that already holds an entry it did not make.
 *
 * @param onto - The copy's mode
 * @param kind - What the copy is about to make there
 * @param thereIsDirectory - Whether the entry there is a real directory (not a link to one); read only under `merge`
 * @returns `refuse` (rethrow the `EEXIST`), `adopt` (keep the directory), or `replace` (remove the file or link, make it anew)
 */
export function mayTakeOver(onto: CopyOnto, kind: 'directory' | 'leaf', thereIsDirectory: boolean): 'refuse' | 'adopt' | 'replace' {
  if (onto === 'fresh') return 'refuse';
  // A merge never swaps one kind for the other: a directory is not deleted for a file, nor a file for a directory.
  if (thereIsDirectory !== (kind === 'directory')) return 'refuse';
  return kind === 'directory' ? 'adopt' : 'replace';
}

/**
 * Two source entries that are ONE name where the copy goes: the source's own layout cannot be
 * copied there. A `source` fault (origin `content`) whatever side the tree is read on, naming both.
 */
export function aliasFault(first: CopiedEntry, second: CopiedEntry, cause: unknown): FsFaultError {
  return new FsFaultError({
    side: 'source',
    faultClass: 'occupied',
    errno: 'EEXIST',
    path: second.path,
    origin: 'content',
    action: `copy both ${first.path} and ${second.path}: where the copy goes their two names are one name (they differ only in letter case or Unicode form), so one would overwrite the other`,
    cause,
  });
}
