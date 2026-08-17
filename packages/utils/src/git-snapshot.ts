/**
 * A **dirty-corrected git tree snapshot**, rebased onto absolute paths.
 *
 * `@vibe-validate/git`'s `getGitTreeSnapshot` answers the question git is
 * uniquely good at: every path git can see under a directory, each with a blob
 * OID naming *the bytes that are actually on disk right now* — dirty working-tree
 * edits included, not the stale committed-index SHA — plus one deterministic
 * `write-tree` hash over the whole set. Membership is `git add --all` without
 * `--force`, i.e. `tracked ∪ (untracked ∧ ¬ignored)`.
 *
 * This module is the thin layer VAT needs on top, and it exists for one reason
 * that is easy to get wrong: **git spells those paths relative to the repository
 * root, not to the directory you asked about.** A caller scanning
 * `<repo>/packages/foo` gets back `packages/foo/x.md`, and a caller that joined
 * those onto its own root would build `<repo>/packages/foo/packages/foo/x.md` —
 * a path that does not exist, so every consumer reads it as "absent" rather than
 * as a bug. Resolving against the repository root here makes that unrepresentable
 * at the call site.
 *
 * ## ⚠️ This is not a pure read
 *
 * Taking a snapshot runs `git add --all` against a throwaway index, which
 * **writes loose blob objects into the target repository's `.git/objects`** for
 * any content git has not already stored. The real index and working tree are
 * never touched, and the objects are ordinary unreferenced blobs that `git gc`
 * reclaims — but a command that advertises itself as read-only is, at the byte
 * level, not. `vibe-validate` accepts this cost on every commit it gates; a VAT
 * lane that adopts it inherits the same trade rather than a different one.
 *
 * ## ⚠️ A symlink's OID names its TARGET STRING, not a file's bytes
 *
 * Git stores a symlink as a blob whose content is the link target, under mode
 * `120000`. Two links with the same relative target but different resolutions
 * therefore share an OID while a consumer that follows them reads two different
 * documents. {@link GitSnapshotEntry.isSymlink} is computed here precisely so
 * that a consumer keying work off `oid` can exclude them — see
 * `packages/resources/src/content-key.ts`, whose standing rule is that a git SHA
 * may be a *lookup hint whose miss is free* and must never be the key itself.
 */

import { getGitTreeSnapshot, GIT_MODE_GITLINK, GIT_MODE_SYMLINK } from '@vibe-validate/git';

import { gitFindRoot } from './git-utils.js';
import { safePath } from './path-utils.js';

/** One path in a {@link GitTreeSnapshot}, located absolutely. */
export interface GitSnapshotEntry {
  /** Absolute, forward-slashed path, resolved against the repository root. */
  absolutePath: string;
  /**
   * Blob OID for this path's **on-disk** bytes.
   *
   * Equal OIDs mean equal bytes, which is what makes this usable as a lookup
   * hint. It is NOT usable as a content key — see the module docstring.
   */
  oid: string;
  /** Git's six-digit mode, verbatim: `100644`, `100755`, `120000`, `160000`. */
  mode: string;
  /** Mode `120000`. Its {@link GitSnapshotEntry.oid} is the target string. */
  isSymlink: boolean;
  /**
   * Mode `160000` — a submodule.
   *
   * The OID is a **commit**, not a blob, so `cat-file` on it yields no file
   * bytes, and none of the submodule's own files appear anywhere in the
   * snapshot. A consumer that needs them takes a second snapshot rooted there.
   */
  isSubmodule: boolean;
}

/** One repository's snapshot. */
export interface GitTreeSnapshot {
  /**
   * `git write-tree` over the snapshot — a deterministic key for the whole set.
   *
   * Byte-identical content always produces it, because a tree object carries no
   * timestamp. (A `stash create` would not: a stash is a commit, and two calls
   * over identical content agree only within the same wall-clock second.)
   */
  hash: string;
  /** The repository root every entry was resolved against, forward-slashed. */
  repositoryRoot: string;
  /** Every path git can see, in git's own order. */
  entries: GitSnapshotEntry[];
}

/**
 * Snapshot everything git can see under a directory.
 *
 * @param options - Where to look
 * @param options.cwd - Any directory inside the repository of interest. Git
 *   resolves upward to the worktree root, and the snapshot covers that whole
 *   root — NOT only the subtree named here. Narrowing is the caller's job, and
 *   is why {@link GitSnapshotEntry.absolutePath} is absolute
 * @returns The snapshot, or `null` when git could not answer — no `git` on
 *   `PATH`, not a repository, a bare or unreadable one. An empty `entries` is a
 *   real answer (an initialized repository with no files) and stays
 *   distinguishable from it
 */
export function gitTreeSnapshot(options: { cwd: string }): GitTreeSnapshot | null {
  // Resolved from the filesystem BEFORE spawning anything, and deliberately not
  // from a `rev-parse` of our own: `getGitTreeSnapshot` has already paid for that
  // question internally, and asking it twice invites the two answers to disagree
  // on a worktree, where the git directory and the worktree root are different
  // places. `gitFindRoot` is memoized, so this is free after the first call.
  const repositoryRoot = gitFindRoot(options.cwd);
  if (repositoryRoot === null) {
    return null;
  }

  const snapshot = getGitTreeSnapshot({ cwd: options.cwd });
  if (snapshot === null) {
    return null;
  }

  return {
    hash: snapshot.hash,
    repositoryRoot,
    entries: snapshot.entries.map((entry) => ({
      absolutePath: safePath.resolve(repositoryRoot, entry.path),
      oid: entry.oid,
      mode: entry.mode,
      isSymlink: entry.mode === GIT_MODE_SYMLINK,
      isSubmodule: entry.mode === GIT_MODE_GITLINK,
    })),
  };
}
