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
 *
 * **Git LFS.** Under `filter=lfs` the snapshot holds a pointer blob, so one hash describes a file
 * pulled (its content on disk) and not pulled (its pointer on disk). After the flags, the key reads
 * which regular-file entries are pointers and whether each is pulled (`readLfsState`, three spawns
 * at most and one `lstat` per pointer, no file read), and appends a digest of the pointers' paths
 * and pulled bits. A pointer whose file is neither by size declines the key (`lfs-undecidable`).
 * Whether a `filter.lfs.*` key is configured is read too (only when there are pointers): it does not
 * enter the hash, since a stat-clean pulled file keys alike either way.
 */

import { createHash } from 'node:crypto';

import { compareCodeUnits } from './compare-code-units.js';
import { type FlaggedEntry, flaggedEntryOf, hiddenEditEntriesOf } from './git-changed-files.js';
import { lfsFilterConfigured, lfsMembersOf, type LfsPointerEntry, readLfsState } from './git-lfs.js';
import { runGitBytes } from './git-run.js';
import {
  freshGitTreeSnapshot,
  type GitHiddenEntry,
  type GitSnapshotOutcome,
  type GitTreeKey,
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
const keyed = new WeakMap<GitTreeSnapshot, GitTreeKey | GitTreeKeyFailure>();

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

/** The `+absent:` digest over the absent entries' paths, as git listed them (sorted: one set, one digest). */
function absentSuffix(absent: readonly Uint8Array[]): string {
  if (absent.length === 0) return '';
  const digest = createHash('sha256');
  for (const path of absent) digest.update(path).update(Uint8Array.of(0));
  return `+absent:${digest.digest('hex')}`;
}

/** The `+lfs:` digest over each pointer's git path and pulled bit, sorted by path; none without pointers. */
function lfsSuffix(pointers: readonly LfsPointerEntry[]): string {
  if (pointers.length === 0) return '';
  const digest = createHash('sha256');
  const sorted = [...pointers].sort((left, right) => compareCodeUnits(left.gitPath, right.gitPath));
  for (const { gitPath, pulled } of sorted) digest.update(gitPath).update('\0').update(pulled ? '1' : '0').update('\0');
  return `+lfs:${digest.digest('hex')}`;
}

/**
 * The tree's LFS reading for the key, or why it cannot key the tree.
 *
 * @param cwd - The directory the key was asked from
 * @param snapshot - The snapshot that keys the tree
 * @param absentPaths - The absent skip-worktree entries' absolute paths: never members
 * @returns The pointers and whether the filter is configured, or the declined key
 */
function lfsOf(
  cwd: string,
  snapshot: GitTreeSnapshot,
  absentPaths: ReadonlySet<string>,
): { pointers: readonly LfsPointerEntry[]; filterConfigured: boolean } | GitTreeKeyFailure {
  const { repositoryRoot } = snapshot;
  const state = readLfsState(repositoryRoot, lfsMembersOf(snapshot.entries, absentPaths));
  if (!state.ok) return { ...state, cwd, repositoryRoot };
  const { pointers, undecidable } = state;
  if (undecidable.length > 0) {
    const named = undecidable.slice(0, NAMED_HIDDEN_ENTRIES).map((path) => shownName(path));
    return { ok: false, kind: 'lfs-undecidable', cwd, repositoryRoot, undecidable: named, undecidableCount: undecidable.length };
  }
  if (pointers.length === 0) return { pointers, filterConfigured: false };
  const filter = lfsFilterConfigured(repositoryRoot);
  if (!filter.ok) return { ...filter, cwd, repositoryRoot };
  return { pointers, filterConfigured: filter.configured };
}

/**
 * Whether git's index hides any working-tree bytes from `snapshot`, and which LFS files are pulled.
 *
 * @param cwd - The directory the key was asked from
 * @param snapshot - The snapshot to key with
 * @returns The key: the snapshot, its hash extended by the absent paths and the LFS pointers' pulled
 *   bits when there are any; or why it cannot key the tree
 */
function keyOf(cwd: string, snapshot: GitTreeSnapshot): GitTreeKey | GitTreeKeyFailure {
  const reading = readingOf(cwd, snapshot);
  if ('ok' in reading) return reading;
  const { hidden, hiddenCount, absent, absentPaths } = reading;
  if (hiddenCount > 0) return { ok: false, kind: 'index-hides', cwd, repositoryRoot: snapshot.repositoryRoot, hidden, hiddenCount };
  const lfs = lfsOf(cwd, snapshot, absentPaths);
  if ('ok' in lfs) return lfs;
  return {
    ...snapshot,
    hash: `${snapshot.hash}${absentSuffix(absent)}${lfsSuffix(lfs.pointers)}`,
    lfs: {
      pointers: lfs.pointers.map(({ absolutePath, lfsOid, pulled }) => ({ absolutePath, lfsOid, pulled })),
      filterConfigured: lfs.filterConfigured,
    },
  };
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
 * skip-worktree that hides bytes, or an LFS file's disk bytes cannot be told (see the module header). Classify a failure with `gitSnapshotFailureOf`.
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
