/**
 * What a directory entry IS — with the symlink question asked first.
 *
 * A `Dirent` from `readdir(…, { withFileTypes: true })` describes the entry
 * itself, so for a symlink BOTH `isFile()` and `isDirectory()` are false. A
 * walk written `if (e.isDirectory()) recurse(); else if (e.isFile()) read();`
 * therefore neither refuses a link nor follows it: it drops the entry on the
 * floor without a word. The sweep found staged skill trees, size accounting
 * and packaging walks with exactly that shape, every one reporting a tree
 * with a symlink in it as clean. `local/dirent-type-needs-symlink-check`
 * refuses that shape; these two helpers are what a walk says instead, and
 * each makes the caller pick a policy by name.
 *
 * - {@link direntKind} — lstat semantics. A link is `'symlink'`, never what it
 *   points at. For a walk that must NOT follow (a delete, a size count of
 *   what `rm -rf` will remove, a bundle that travels as a tarball).
 * - {@link direntKindFollowing} — stat semantics. A link is answered by its
 *   target: `'file'`, `'directory'`, or `'dangling'`. For a walk over a tree
 *   the caller trusts (its own build output, a dev-mode install, a fixture),
 *   where a link is simply how the entry got there.
 *
 * Neither helper decides for the caller. A `'symlink'` or `'dangling'` that
 * the caller ignores is still ignored — but it is ignored in a `case` the
 * reader can see, which is the whole difference.
 */

import type { Dirent } from 'node:fs';
import { statSync } from 'node:fs';
import fs from 'node:fs/promises';

import { isPathAbsentError } from './errors/errno.js';
import { VatError } from './errors/vat-error.js';
import { toForwardSlash } from './path-core.js';
import { normalizePath, safePath } from './path-utils.js';

/** What the entry itself is. A link is a link. */
export type DirentKind = 'file' | 'directory' | 'symlink' | 'other';

/** What the entry resolves to. A link is answered by its target, or is `dangling`. */
export type FollowedKind = 'file' | 'directory' | 'dangling' | 'other';

/**
 * Classify an entry WITHOUT following it.
 *
 * @param entry - A `Dirent` from a `withFileTypes` listing
 * @returns `'symlink'` for any link, else the entry's own type
 */
export function direntKind(entry: Dirent): DirentKind {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
}

/** The kind a `stat` result reports. */
function kindOfStats(stats: { isFile(): boolean; isDirectory(): boolean }): FollowedKind {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

/**
 * Classify an entry by what it resolves to, following a link with one `stat`.
 *
 * A non-link entry costs no syscall. A link whose target is absent is
 * `'dangling'`; a link the OS refuses to resolve (`ELOOP`, `EACCES`) is a
 * refusal, not an absence, and stays loud.
 *
 * @param dir - The directory `entry` was listed from
 * @param entry - A `Dirent` from a `withFileTypes` listing of `dir`
 * @returns The target's kind, or `'dangling'`
 */
export function direntKindFollowingSync(dir: string, entry: Dirent): FollowedKind {
  if (!entry.isSymbolicLink()) return kindOfStats(entry);
  try {
    return kindOfStats(statSync(safePath.join(dir, entry.name)));
  } catch (error) {
    if (isPathAbsentError(error)) return 'dangling';
    throw error;
  }
}

/** The async counterpart of {@link direntKindFollowingSync}. */
export async function direntKindFollowing(dir: string, entry: Dirent): Promise<FollowedKind> {
  if (!entry.isSymbolicLink()) return kindOfStats(entry);
  try {
    return kindOfStats(await fs.stat(safePath.join(dir, entry.name)));
  } catch (error) {
    if (isPathAbsentError(error)) return 'dangling';
    throw error;
  }
}

/** Thrown when a following walk is led back into a directory it has already entered. */
export class DirectoryWalkRevisitedError extends VatError {
  constructor(dir: string, enteredAs: string) {
    super(
      'DIRECTORY_WALK_REVISITED',
      `Refusing to enter ${dir}: it is the directory already walked as ${enteredAs} — a symlink leads the walk back into itself.`,
    );
  }
}

/**
 * The directories a FOLLOWING walk has entered, by realpath, so a link that
 * leads back into the walk is refused instead of recursed until
 * `ENAMETOOLONG`.
 *
 * A walk that follows links (`direntKindFollowing`) has no cycle guard by
 * construction: `scripts/loop -> .` makes a copy create `dest/loop/loop/…`,
 * writing every file at every level first, and a hashing walk do the same in
 * memory. Every following walk holds one of these and calls {@link enter}
 * on every directory it recurses into — the root included. A REVISIT is
 * refused, not just a cycle: two links to one directory make the walk's
 * output ambiguous (which spelling is the file's path?), and a refusal that
 * names both spellings is the answer the author can act on.
 */
export class FollowedWalk {
  readonly #entered = new Map<string, string>();

  /**
   * Record that the walk is entering `dir`. Synchronous on purpose — one
   * realpath per directory entered is nothing beside the listing itself, and
   * the sync and async walkers then share one guard.
   *
   * @param dir - A directory the walk is about to list, in any spelling
   * @throws {DirectoryWalkRevisitedError} When its realpath was entered before
   */
  enter(dir: string): void {
    const real = toForwardSlash(normalizePath(dir));
    const before = this.#entered.get(real);
    if (before !== undefined) throw new DirectoryWalkRevisitedError(dir, before);
    this.#entered.set(real, dir);
  }
}
