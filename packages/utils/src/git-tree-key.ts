/**
 * The key for a working tree: the snapshot's hash, when that hash describes the bytes on disk.
 *
 * `gitTreeSnapshot` stages the working tree through a COPY of the real index, and the copy keeps
 * the index's flags. A file flagged assume-unchanged or skip-worktree is one git does not read: the
 * hash holds its staged bytes whatever the disk holds, so an edit to it moves no key, and a key
 * taken while such a file is flagged and dirty equals the key of the clean tree. Anything filed
 * under that key (the projection store) would then describe bytes that are not there, on the run
 * that writes it and on the run that reads it. So the key declines for any tree whose index carries
 * either flag.
 *
 * Decided from the index flags alone — one `git ls-files -v` per snapshot, no file read, hashed or
 * stat'd. The price is a sparse checkout: every file outside its definition is skip-worktree, so a
 * sparse tree gets no key even though nothing on disk is hidden.
 *
 * ⚠️ One race stays open: the listing reads the REAL index after the snapshot copied it, so a flag
 * cleared in the milliseconds between the two (a concurrent `git update-index --no-skip-worktree`)
 * is missed and that file's disk bytes are not in the accepted hash. Closing it means listing the
 * snapshot's own index copy, which `@vibe-validate/git` makes and deletes inside one call. The
 * write path narrows it: the store files nothing unless a fresh key, listed again, agrees.
 *
 * The snapshot itself is unchanged: the crawl and `gitChangedFiles` still take it on such a tree
 * (`gitChangedFiles` makes its own refusal of hidden edits).
 */

import { hiddenEditEntriesOf, hiddenEditFlagsOf } from './git-changed-files.js';
import { runGitBytes } from './git-run.js';
import {
  freshGitTreeSnapshot,
  type GitHiddenEntry,
  type GitSnapshotOutcome,
  type GitTreeKeyFailure,
  type GitTreeKeyOutcome,
  type GitTreeSnapshot,
  gitTreeSnapshot,
} from './git-snapshot.js';
import { shownName } from './shown-text.js';

/** How many flagged entries a declined key names; the rest are counted. */
const NAMED_HIDDEN_ENTRIES = 2;

/**
 * The answer per snapshot OBJECT: inside a `withGitSnapshotCache` bracket the snapshot is one
 * object for the run, so its flags are listed once; a fresh snapshot is a new object and is
 * listed afresh, as it must be.
 */
const keyed = new WeakMap<GitTreeSnapshot, GitTreeSnapshot | GitTreeKeyFailure>();

/** The flag an entry's `ls-files -v` tag names, or `undefined` for an entry git reads. */
function hidingFlagOf(tag: string): GitHiddenEntry['flag'] | undefined {
  const { skipWorktree, assumeUnchanged } = hiddenEditFlagsOf(tag);
  if (skipWorktree && assumeUnchanged) return 'assume-unchanged and skip-worktree';
  if (skipWorktree) return 'skip-worktree';
  return assumeUnchanged ? 'assume-unchanged' : undefined;
}

/**
 * Whether git's index hides any working-tree bytes from `snapshot`.
 *
 * @param cwd - The directory the key was asked from
 * @param snapshot - The snapshot to key with
 * @returns The snapshot, or why it cannot key the tree
 */
function keyOf(cwd: string, snapshot: GitTreeSnapshot): GitTreeSnapshot | GitTreeKeyFailure {
  const { repositoryRoot } = snapshot;
  // Counted `git.calls` by the runner, as every spawn is.
  // The whole listing, however large: the runner clamps this to its own cap. A smaller default would
  // decline a large repository for a size that says nothing about its flags.
  const listed = runGitBytes(['ls-files', '-v', '-z'], { cwd: repositoryRoot, maxBuffer: Number.MAX_SAFE_INTEGER });
  if (!listed.ok) return { ok: false, kind: 'flags-unlisted', cwd, repositoryRoot, attempt: listed };
  const read = hiddenEditEntriesOf(listed.stdout);
  if (!read.ok) return { ok: false, kind: 'flags-unreadable', cwd, repositoryRoot, reason: read.reason };
  const hidden: GitHiddenEntry[] = [];
  let hiddenCount = 0;
  for (const entry of read.entries) {
    const flag = hidingFlagOf(entry.tag);
    if (flag === undefined) continue;
    hiddenCount += 1;
    if (hidden.length < NAMED_HIDDEN_ENTRIES) hidden.push({ shownPath: shownName(entry.path), flag });
  }
  return hiddenCount === 0 ? snapshot : { ok: false, kind: 'index-hides', cwd, repositoryRoot, hidden, hiddenCount };
}

/** {@link keyOf}, once per snapshot object. */
function keyFor(cwd: string, outcome: GitSnapshotOutcome): GitTreeKeyOutcome {
  if (!outcome.ok) return outcome;
  const known = keyed.get(outcome);
  if (known !== undefined) return known;
  const key = keyOf(cwd, outcome);
  keyed.set(outcome, key);
  return key;
}

/**
 * The tree's key: {@link gitTreeSnapshot}, unless git's index flags any file assume-unchanged or
 * skip-worktree (see the module header). Classify a failure with `gitSnapshotFailureOf`.
 *
 * @param options - Where to look
 * @param options.cwd - Any directory inside the repository; the key covers the whole repository
 * @returns The snapshot, or why git cannot key the tree
 */
export function gitTreeKey(options: { cwd: string }): GitTreeKeyOutcome {
  return keyFor(options.cwd, gitTreeSnapshot(options));
}

/**
 * {@link gitTreeKey} from a snapshot taken NOW (`freshGitTreeSnapshot`): the write path's check that
 * the bracket's key still describes the tree, flags included.
 *
 * @param options - Where to look
 * @param options.cwd - Any directory inside the repository
 * @returns The snapshot, or why git cannot key the tree
 */
export function freshGitTreeKey(options: { cwd: string }): GitTreeKeyOutcome {
  return keyFor(options.cwd, freshGitTreeSnapshot(options));
}
