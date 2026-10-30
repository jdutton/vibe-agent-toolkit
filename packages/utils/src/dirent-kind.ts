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
 *   target: `'file'`, `'directory'`, or `'dangling'`. The link's chain is read
 *   by its text beneath the tree the walk is in (`within`) before the kernel
 *   follows it (`link-following.ts`): a cycle is `'dangling'`, a link to a
 *   network or device path a `LinkChainRefusedError`.
 *
 * Neither helper decides for the caller. A `'symlink'` or `'dangling'` that
 * the caller ignores is still ignored — but it is ignored in a `case` the
 * reader can see, which is the whole difference.
 */

import type { Dirent } from 'node:fs';

import { type FollowedPathKind, followedKind, followedKindSync } from './link-following.js';
import { safePath } from './path-core.js';

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

/** A followed kind, a link that resolves to nothing named `dangling`. */
function followed(kind: FollowedPathKind): FollowedKind {
  return kind === 'absent' ? 'dangling' : kind;
}

/**
 * Classify an entry by what it resolves to, following a link only once its
 * chain is read beneath `within` (`link-following.ts`).
 *
 * A non-link entry costs no syscall. A link that resolves to nothing — absent,
 * a cycle — is `'dangling'`; a probe the OS refuses (`EACCES`) is a refusal, not
 * an absence, and stays loud, raw, for the caller's classifier.
 *
 * @param dir - The directory `entry` was listed from
 * @param entry - A `Dirent` from a `withFileTypes` listing of `dir`
 * @param within - The tree the walk is in: the operator's own input
 * @returns The target's kind, or `'dangling'`
 * @throws LinkChainRefusedError for a link to a network or device path
 */
export function direntKindFollowingSync(dir: string, entry: Dirent, within: string): FollowedKind {
  if (!entry.isSymbolicLink()) return kindOfStats(entry);
  return followed(followedKindSync(safePath.join(dir, entry.name), within));
}

/** The async counterpart of {@link direntKindFollowingSync}. */
export async function direntKindFollowing(dir: string, entry: Dirent, within: string): Promise<FollowedKind> {
  if (!entry.isSymbolicLink()) return kindOfStats(entry);
  return followed(await followedKind(safePath.join(dir, entry.name), within));
}
