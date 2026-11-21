/**
 * The key for a working tree: the snapshot's hash, when that hash describes the bytes on disk.
 *
 * `gitTreeSnapshot` stages the working tree through a COPY of the real index, and the copy keeps
 * the index's flags. A file flagged assume-unchanged or skip-worktree is one git does not read: the
 * hash holds its staged bytes whatever the disk holds, so an edit to it moves no key, and a key
 * taken while such a file is flagged and dirty equals the key of the clean tree. Anything filed
 * under that key (the projection store) would then describe bytes that are not there, on the run
 * that writes it and on the run that reads it. So the key declines for any tree whose index carries
 * either flag on an entry that hides bytes.
 *
 * The one flagged entry that hides none is skip-worktree only with nothing on disk (a sparse
 * checkout's file): the rule is `flaggedEntryOf`, the same one `gitChangedFiles` refuses by. Its
 * check is an `lstat` of each skip-worktree path, existence only; no file is read or hashed. Such a
 * tree keys, but not under the snapshot's bare hash: the snapshot still holds the absent file's
 * staged bytes, so the same tree with the file back (`git sparse-checkout disable`) writes the same
 * hash. The key appends a digest of the absent paths, so a store filed while they were absent never
 * serves the tree where they are present. The snapshot lists those entries all the same, so the git
 * crawl lane drops them ({@link gitSnapshotAbsentEntries}), from the same listing.
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

import { createHash } from 'node:crypto';

import { type FlaggedEntry, flaggedEntryOf, hiddenEditEntriesOf } from './git-changed-files.js';
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
import { safePath } from './path-utils.js';
import { shownName } from './shown-text.js';

/** How many flagged entries a declined key names; the rest are counted. */
const NAMED_HIDDEN_ENTRIES = 2;

/** What git's index flags say about one snapshot's tree. */
interface IndexFlagReading {
  /** The first flagged entries that hide bytes, named. */
  readonly hidden: readonly GitHiddenEntry[];
  /** How many flagged entries hide bytes in all. */
  readonly hiddenCount: number;
  /** The absent skip-worktree entries, as git listed them: repository-relative bytes, in git's order. */
  readonly absent: readonly Uint8Array[];
  /** The same entries, absolute and forward-slashed, as a snapshot entry names its path. */
  readonly absentPaths: ReadonlySet<string>;
}

/**
 * The reading per snapshot OBJECT: inside a `withGitSnapshotCache` bracket the snapshot is one
 * object for the run, so its flags are listed once, for the key and the crawl together; a fresh
 * snapshot is a new object and is listed afresh, as it must be.
 */
const readings = new WeakMap<GitTreeSnapshot, IndexFlagReading | GitTreeKeyFailure>();

/** The key per snapshot object, so one snapshot keys as one object every time it is asked. */
const keyed = new WeakMap<GitTreeSnapshot, GitTreeSnapshot | GitTreeKeyFailure>();

/** The flags a flagged entry carries, as a declined key names them. */
function hidingFlagOf({ flags }: FlaggedEntry): GitHiddenEntry['flag'] {
  if (flags.skipWorktree && flags.assumeUnchanged) return 'assume-unchanged and skip-worktree';
  return flags.skipWorktree ? 'skip-worktree' : 'assume-unchanged';
}

/**
 * List git's index flags for `snapshot`'s repository and judge each flagged entry by the one rule.
 *
 * @param cwd - The directory the answer was asked from
 * @param snapshot - The snapshot whose tree is judged
 * @returns The reading, or why the flags could not be listed
 */
function readFlags(cwd: string, snapshot: GitTreeSnapshot): IndexFlagReading | GitTreeKeyFailure {
  const { repositoryRoot } = snapshot;
  // Counted `git.calls` by the runner, as every spawn is.
  // The whole listing, however large: the runner clamps this to its own cap. A smaller default would
  // decline a large repository for a size that says nothing about its flags.
  const listed = runGitBytes(['ls-files', '-v', '-z'], { cwd: repositoryRoot, maxBuffer: Number.MAX_SAFE_INTEGER });
  if (!listed.ok) return { ok: false, kind: 'flags-unlisted', cwd, repositoryRoot, attempt: listed };
  const read = hiddenEditEntriesOf(listed.stdout);
  if (!read.ok) return { ok: false, kind: 'flags-unreadable', cwd, repositoryRoot, reason: read.reason };
  const hidden: GitHiddenEntry[] = [];
  const absent: Uint8Array[] = [];
  const absentPaths = new Set<string>();
  let hiddenCount = 0;
  for (const entry of read.entries) {
    const flagged = flaggedEntryOf(repositoryRoot, entry);
    if (flagged === undefined) continue;
    if (flagged.absentSkipWorktree && flagged.path !== undefined) {
      absent.push(entry.path);
      absentPaths.add(safePath.resolve(repositoryRoot, flagged.path));
      continue;
    }
    hiddenCount += 1;
    if (hidden.length < NAMED_HIDDEN_ENTRIES) hidden.push({ shownPath: shownName(entry.path), flag: hidingFlagOf(flagged) });
  }
  return { hidden, hiddenCount, absent, absentPaths };
}

/** {@link readFlags}, once per snapshot object. */
function readingOf(cwd: string, snapshot: GitTreeSnapshot): IndexFlagReading | GitTreeKeyFailure {
  const known = readings.get(snapshot);
  if (known !== undefined) return known;
  const reading = readFlags(cwd, snapshot);
  readings.set(snapshot, reading);
  return reading;
}

/**
 * The snapshot, its hash extended by the absent skip-worktree paths when there are any.
 *
 * @param snapshot - The snapshot that keys the tree
 * @param absent - The absent entries' paths, as git listed them (sorted, so one set is one digest)
 * @returns The snapshot itself when nothing is absent
 */
function keyedSnapshot(snapshot: GitTreeSnapshot, absent: readonly Uint8Array[]): GitTreeSnapshot {
  if (absent.length === 0) return snapshot;
  const digest = createHash('sha256');
  for (const path of absent) digest.update(path).update(Uint8Array.of(0));
  return { ...snapshot, hash: `${snapshot.hash}+absent:${digest.digest('hex')}` };
}

/**
 * Whether git's index hides any working-tree bytes from `snapshot`.
 *
 * @param cwd - The directory the key was asked from
 * @param snapshot - The snapshot to key with
 * @returns The key, or why it cannot key the tree
 */
function keyOf(cwd: string, snapshot: GitTreeSnapshot): GitTreeSnapshot | GitTreeKeyFailure {
  const reading = readingOf(cwd, snapshot);
  if ('ok' in reading) return reading;
  const { hidden, hiddenCount, absent } = reading;
  if (hiddenCount > 0) return { ok: false, kind: 'index-hides', cwd, repositoryRoot: snapshot.repositoryRoot, hidden, hiddenCount };
  return keyedSnapshot(snapshot, absent);
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
 * The tree's key: {@link gitTreeSnapshot}, unless git's index flags a file assume-unchanged or
 * skip-worktree that hides bytes (see the module header). Classify a failure with `gitSnapshotFailureOf`.
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

/**
 * The snapshot entries absent from disk under a skip-worktree flag (a sparse checkout's files): the
 * snapshot lists them with their staged bytes, but no file is there, so the git crawl lane drops
 * them, as a walk never meets them. Read from the key's own listing, so inside a
 * `withGitSnapshotCache` bracket it costs no second spawn.
 *
 * @param options - Where to look
 * @param options.cwd - The directory the snapshot was asked from
 * @param options.snapshot - The snapshot whose entries are judged
 * @returns Their absolute, forward-slashed paths, or why git's flags could not be listed
 */
export function gitSnapshotAbsentEntries(options: { cwd: string; snapshot: GitTreeSnapshot }): ReadonlySet<string> | GitTreeKeyFailure {
  const reading = readingOf(options.cwd, options.snapshot);
  return 'ok' in reading ? reading : reading.absentPaths;
}
