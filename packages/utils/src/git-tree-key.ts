/**
 * The key for a working tree: the snapshot's hash, when that hash describes the bytes on disk.
 *
 * `gitTreeSnapshot` stages the working tree through a COPY of the real index, clearing in that copy
 * assume-unchanged on every entry and skip-worktree on every entry present on disk, so an edit to a
 * flagged file is in the hash. The flags are judged by the one rule, `judgeIndexFlags`, the same
 * one `gitChangedFiles` refuses by:
 *
 * - One index still hides bytes: a SPARSE INDEX holding a directory as one collapsed entry, where a
 *   file edited inside it keeps its staged bytes in the snapshot. Anything filed under that key (the
 *   projection store) would describe bytes that are not there, so the key declines (`index-hides`)
 *   when a skip-worktree file is on disk and the index holds a collapsed directory.
 * - A skip-worktree entry with nothing on disk (a sparse checkout's file) hides no bytes, but the
 *   snapshot still holds its staged bytes, so the same tree with the file back (`git sparse-checkout
 *   disable`) writes the same hash. The key appends a digest of the absent paths, so a store filed
 *   while they were absent never serves the tree where they are present, and carries them
 *   (`absent`). The snapshot lists those entries all the same, so the git crawl lane drops them
 *   ({@link gitSnapshotAbsentEntries}), from the same listing.
 *
 * The checks are an `lstat` of each skip-worktree path, existence only; no file is read or hashed.
 *
 * **Case collisions.** Two snapshot paths the volume holds as one file (`A.md` and `a.md` on a
 * volume that folds case) are two entries for bytes the disk holds once: the key declines
 * (`case-collision`), by `caseCollisionOf`.
 *
 * ⚠️ One race stays open: the listing reads the REAL index after the snapshot copied it, so a flag
 * or a sparse directory changed in the milliseconds between the two (a concurrent
 * `git update-index --no-skip-worktree`, a `git sparse-checkout` run) is judged as it is after the
 * snapshot, not as the snapshot saw it. Closing it means listing the
 * snapshot's own index copy, which `@vibe-validate/git` makes and deletes inside one call. The
 * write path narrows it: the store files nothing unless a fresh key, listed again, agrees.
 *
 * The snapshot itself is unchanged: the crawl and `gitChangedFiles` still take it on such a tree
 * (`gitChangedFiles` makes its own refusal of hidden edits).
 *
 * **Git LFS.** Under `filter=lfs` the snapshot holds a pointer blob, so one hash describes a file
 * pulled (its content on disk) and not pulled (its pointer on disk). After the flags, the key reads
 * which regular-file entries are pointers and whether each is pulled (`readLfsState`, three spawns
 * at most and one `lstat` per pointer; a file is read only when it is small enough to be a pointer),
 * and appends a digest of the pointers' paths and pulled bits. A pointer whose file is absent or no
 * regular file declines the key (`lfs-undecidable`), as does a pointer's file the OS will not let
 * VAT look at (`lfs-file-unread`). Whether a `filter.lfs.*` key is
 * configured is read too (only when there are pointers, else `not-asked`): it does not enter the
 * hash, since a stat-clean pulled file keys alike either way.
 */

import { createHash } from 'node:crypto';

import { compareCodeUnits } from './compare-code-units.js';
import { caseCollisionOf, lstatIdentity } from './git-case-collision.js';
import { type FlaggedEntry, hiddenEditEntriesOf, indexHidesFailure, judgeIndexFlags } from './git-changed-files.js';
import { lfsFilterConfigured, lfsMembersOf, type LfsPointerEntry, readLfsState } from './git-lfs.js';
import { runGitBytes } from './git-run.js';
import {
  freshGitTreeSnapshot,
  type GitSnapshotOutcome,
  type GitTreeKey,
  type GitTreeKeyFailure,
  type GitTreeKeyOutcome,
  type GitTreeSnapshot,
  gitTreeSnapshot,
  type LfsReading,
} from './git-snapshot.js';
import { safePath } from './path-utils.js';
import { shownName } from './shown-text.js';

/** How many paths a declined key names; the rest are counted. */
const NAMED_PATHS = 2;

/** What git's index flags say about one snapshot's tree. */
interface IndexFlagReading {
  /** The entries whose bytes the snapshot misses ({@link judgeIndexFlags}); the key declines when any. */
  readonly hiding: readonly FlaggedEntry[];
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

/** The command whose listing the flags are read from, as a declined key names it. */
const FLAGS_LISTING = 'git ls-files -v';

/**
 * List git's index flags for `snapshot`'s repository and judge them by the one rule
 * ({@link judgeIndexFlags}).
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
  if (!listed.ok) return { ok: false, kind: 'flags-unlisted', cwd, repositoryRoot, command: FLAGS_LISTING, attempt: listed };
  const read = hiddenEditEntriesOf(listed.stdout);
  if (!read.ok) return { ok: false, kind: 'flags-unreadable', cwd, repositoryRoot, reason: read.reason };
  const judged = judgeIndexFlags(repositoryRoot, read.entries);
  if (!judged.ok) {
    return judged.kind === 'unlisted'
      ? { ok: false, kind: 'flags-unlisted', cwd, repositoryRoot, command: judged.command, attempt: judged.attempt }
      : { ok: false, kind: 'flags-unreadable', cwd, repositoryRoot, reason: judged.reason };
  }
  return {
    hiding: judged.hiding,
    absent: judged.absent.map((entry) => entry.bytes),
    absentPaths: new Set(judged.absent.map((entry) => safePath.resolve(repositoryRoot, entry.path))),
  };
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

/** What the LFS pass read, or why git gave no usable answer. */
type LfsReadState = ReturnType<typeof readLfsState>;

/** The first paths a declined key names, as a message shows them. */
function namedPaths(paths: readonly string[]): string[] {
  return paths.slice(0, NAMED_PATHS).map((path) => shownName(path));
}

/**
 * Why the LFS pass's reading cannot key the tree: a file it could not look at, or a pointer neither
 * pulled nor not; `undefined` when it can.
 */
function lfsDeclineOf(cwd: string, repositoryRoot: string, state: Extract<LfsReadState, { ok: true }>): GitTreeKeyFailure | undefined {
  const { undecidable, unread } = state;
  const [first] = unread;
  if (first !== undefined) {
    const { gitPath, operation, errno } = first;
    return { ok: false, kind: 'lfs-file-unread', cwd, repositoryRoot, path: shownName(gitPath), operation, errno, unreadCount: unread.length };
  }
  if (undecidable.length > 0) {
    return { ok: false, kind: 'lfs-undecidable', cwd, repositoryRoot, undecidable: namedPaths(undecidable), undecidableCount: undecidable.length };
  }
  return undefined;
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
): { pointers: readonly LfsPointerEntry[]; filter: LfsReading['filter'] } | GitTreeKeyFailure {
  const { repositoryRoot } = snapshot;
  const state = readLfsState(repositoryRoot, lfsMembersOf(snapshot.entries, absentPaths));
  if (!state.ok) return { ...state, cwd, repositoryRoot };
  const declined = lfsDeclineOf(cwd, repositoryRoot, state);
  if (declined !== undefined) return declined;
  const { pointers } = state;
  if (pointers.length === 0) return { pointers, filter: 'not-asked' };
  const filter = lfsFilterConfigured(repositoryRoot);
  if (!filter.ok) return { ...filter, cwd, repositoryRoot };
  return { pointers, filter: filter.configured ? 'configured' : 'not-configured' };
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
  const { hiding, absent, absentPaths } = reading;
  if (hiding.length > 0) return indexHidesFailure(cwd, snapshot.repositoryRoot, hiding);
  const collision = caseCollisionOf(snapshot.entries, lstatIdentity);
  if (collision !== undefined) {
    return { ok: false, kind: 'case-collision', cwd, repositoryRoot: snapshot.repositoryRoot, paths: [shownName(collision[0]), shownName(collision[1])] };
  }
  const lfs = lfsOf(cwd, snapshot, absentPaths);
  if ('ok' in lfs) return lfs;
  return {
    ...snapshot,
    hash: `${snapshot.hash}${absentSuffix(absent)}${lfsSuffix(lfs.pointers)}`,
    absent: absentPaths,
    lfs: {
      pointers: lfs.pointers.map(({ absolutePath, lfsOid, pulled, extended }) => ({ absolutePath, lfsOid, pulled, extended })),
      filter: lfs.filter,
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
 * The tree's key: {@link gitTreeSnapshot}, unless a sparse index hides an edit from it, two of its
 * paths are one file on disk, or an LFS file's disk bytes cannot be told (see the module header).
 * Classify a failure with `gitSnapshotFailureOf`.
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
