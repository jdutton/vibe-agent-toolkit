/**
 * What this change touched in a working tree — the tree a projection holds (tracked files as they
 * stand on disk, plus untracked files git does not ignore), compared with the MERGE BASE of the
 * base ref and HEAD (`git merge-base --all <ref> HEAD`): GitHub's "files changed", never what the
 * base branch moved since this branch left it.
 *
 * ## One snapshot, one diff
 *
 * The working tree is made a git TREE by the repository's one snapshot mechanism,
 * {@link gitTreeSnapshot} (`git add --all` into a throwaway index, then `write-tree`: tracked files
 * with their unstaged edits, plus untracked files git does not ignore). That tree is compared with
 * the merge base by ONE `git diff-tree -r -M -l0 --name-status -z`, so every path is judged once,
 * by git, against one answer:
 *
 * - A move is a rename whether or not it was `git add`ed: both sides are in the snapshot.
 * - A file removed from the index but unchanged on disk (`git rm --cached`) is no change.
 * - `-l0` lifts git's rename limit, so no rename is ever reported as a deletion plus an addition.
 * - No `-C`: a copy is an addition. A conflicted (unmerged) path is its working-tree file as it
 *   stands, conflict markers and all — usually one `modified` row.
 * - git's index flags are judged by the one rule ({@link judgeIndexFlags}): the snapshot clears
 *   assume-unchanged, and skip-worktree on a file present on disk, so an edit to such a file is in
 *   it. Two flagged states REFUSE the answer: a skip-worktree file on disk inside a directory a
 *   sparse index holds collapsed (its edit is missing from the snapshot), and a skip-worktree file
 *   absent from disk outside a sparse checkout (`core.sparseCheckout` not true), whose deletion git
 *   hides. Inside a sparse checkout an absent skip-worktree file is absent by design.
 * - A directory under the root git cannot list REFUSES the answer: `git add --all` only warns on it
 *   and exits 0, so the untracked files beneath it would be missing. It is asked of
 *   `git ls-files --others` under the unreadable-listing policy, never of the crawl lane.
 * - If the snapshot fails, the failure carries git's own account of why, and the ONE classifier
 *   the crawl uses too (`gitSnapshotFailureOf`, `git-no-answer.ts`) decides the cause: each cause
 *   has one code there, and one fault kind here ({@link GIT_CHANGED_FILES_KIND_BY_CODE}).
 *
 * In a shallow clone the merge base is trusted only when no commit between it and either tip is a
 * shallow boundary: one could hide a nearer merge base, so that refuses, naming how to deepen.
 * - A gitlink — a submodule, or a nested repository with a commit — is one row naming its
 *   directory, listed when the commit it records moved; its own files are never this tree's.
 *
 * Inside a `withGitSnapshotCache` bracket the snapshot is the one the projection took, so
 * the relation and the rows it is joined to describe the same tree.
 *
 * ## Paths are bytes until they are judged
 *
 * The listing is read through {@link runGitBytes} and split on NUL, never decoded as a stream — the
 * rule for every path a repository supplies (see `runGitBytes`). A path under the root is decoded
 * EXACTLY (`decodeUtf8Exactly`); one that is not UTF-8 refuses the whole answer, naming its bytes,
 * rather than reporting a spelling the checkout does not write. A path outside the root is never
 * decoded, because it is never reported.
 *
 * ## The root may be a subdirectory of the repository
 *
 * The diff names paths from the repository's top (`diff-tree` is plumbing: a `diff.relative` config
 * does not reach it); they are kept only under the root's prefix and made relative to it. A rename crossing
 * the root's boundary is reported as what it is from INSIDE the root: renamed in is `added`,
 * renamed out is `deleted`.
 *
 * 🚨 On a filesystem that folds case or normalisation, a path git lists can be spelled differently
 * from the prefix git reports (a case-only rename since the base, a root reached in another case or
 * Unicode normalisation), and a byte comparison would then drop it in silence. So every changed path,
 * and a rename's old side wherever its new side lands, whose leading segments match the prefix as
 * APFS compares names — Unicode case and NFC/NFD alike — but not byte for byte refuses, naming both:
 * an old side under another spelling was under the root already, so neither `added` nor `deleted`
 * would be true of it.
 *
 * Whether the filesystem folds is PROBED at the root (its path with one segment's case flipped,
 * compared by `dev`/`ino`), never read from `core.ignorecase`, a config that can disagree with the
 * disk. Where it folds, a `core.ignorecase` that is not true refuses, naming the fix, and the
 * spelling check runs whenever the root is a subdirectory. Where it does not, the check is skipped:
 * there `Docs/` beside a `docs/` root is another directory, and its changes are simply not the root's.
 */

import { lstatSync, readFileSync } from 'node:fs';

import { compareCodeUnits } from './compare-code-units.js';
import { fsFaultOf, isPathAbsentError } from './errors/errno-table.js';
import type { DirectoryRefusal } from './fs-utils.js';
import { type GitAttempt, type GitNoAnswer, type GitNoAnswerCode, gitRunFailureOf, gitSnapshotFailureOf, SPARSE_CHECKOUT_KEY } from './git-no-answer.js';
import { type GitBytesRunResult, runGit, runGitBytes } from './git-run.js';
import { type GitHiddenEntry, type GitTreeKeyFailure, gitTreeSnapshot } from './git-snapshot.js';
import { gitLsOthers } from './git-utils.js';
import { refusedListingMessage } from './listing-refusal.js';
import { isAbsoluteAnyPlatform, toForwardSlash } from './path-core.js';
import { normalizePath, safePath } from './path-utils.js';
import { shownName } from './shown-text.js';
import { decodeUtf8Exactly } from './text-content.js';

/** What happened to one path between the base and the working tree. */
export type GitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'type-changed';

/** One changed path, relative to the root, POSIX-spelled. */
export interface GitChangedFile {
  /** The path now — for a deletion, the path that was deleted. */
  readonly path: string;
  readonly status: GitChangeKind;
  /** Where a rename came from; `null` for every other kind. */
  readonly oldPath: string | null;
  /** git's similarity score (0-100) for a rename; `null` for every other kind. */
  readonly similarity: number | null;
}

/** One `--name-status -z` record, its paths still the bytes git wrote. */
interface GitNameStatusRecord {
  readonly status: GitChangeKind;
  readonly path: Uint8Array;
  readonly oldPath: Uint8Array | null;
  readonly similarity: number | null;
}

/**
 * Whose fault a refusal is: `base` — the ref passed (it names no commit, shares no history with
 * HEAD in a whole history, or has more than one merge base with HEAD); `git-failed` — git did not
 * run or did not finish (not on PATH, out of time, more output than VAT reads, a probe that
 * answered neither `true` nor `false`, a snapshot that failed for no cause git states);
 * `repository` — the tree cannot answer (not a working tree, no commits, a git that cannot resolve
 * HEAD, a shallow history cut off before the merge base or unable to vouch for it, a file git is
 * told not to read, a directory git cannot list, a folding filesystem whose `core.ignorecase` is not
 * true, a tree git refuses to snapshot, a
 * damaged or partial clone, a root in another case, a path that is not UTF-8, a listing VAT cannot read).
 */
export type GitChangedFilesRefusalKind = 'base' | 'git-failed' | 'repository';

/** A condition the caller can fix, whose fault it is, and the fix. */
interface Refusal {
  readonly ok: false;
  readonly kind: GitChangedFilesRefusalKind;
  readonly reason: string;
}

/** The fault kind of a git that did not run, or did not answer as a git that ran here would. */
const GIT_FAILED_KIND: GitChangedFilesRefusalKind = 'git-failed';

/** The refusal for a git that did not run, or did not answer, as a git that ran here would. */
function gitFailed(reason: string): Refusal {
  return { ok: false, kind: GIT_FAILED_KIND, reason };
}

/** The changes, or why there is no answer. */
type GitChangedFilesOutcome = { readonly ok: true; readonly files: readonly GitChangedFile[] } | Refusal;

/** {@link gitChangedFiles}'s answer: the changes and the commit they were measured from. */
export type GitChangedFilesResult =
  | { readonly ok: true; readonly baseCommit: string; readonly files: readonly GitChangedFile[] }
  | Refusal;

/** The one-letter statuses `diff-tree -M` writes with a single path. */
const SINGLE_PATH_STATUS: ReadonlyMap<string, GitChangeKind> = new Map([
  ['A', 'added'],
  ['M', 'modified'],
  ['D', 'deleted'],
  ['T', 'type-changed'],
]);

/** A rename status: `R` and a score of 1-3 digits. */
const RENAME_STATUS = /^R(\d{1,3})$/;

/** The NUL byte that ends every `-z` field. */
const NUL = 0x00;
/** The byte git separates path segments with. */
const SLASH = 0x2F;

/** The newline `rev-parse --show-prefix` ends its answer with. */
const NEWLINE = 0x0a;

/** The command whose listing {@link parseNameStatusZ} reads, as its errors name it. */
const LISTING_COMMAND = 'git diff-tree --name-status -z';

/** The command whose listing {@link hiddenEditEntriesOf} reads, as its errors name it. */
const FLAGS_LISTING_COMMAND = 'git ls-files -v -z';

/**
 * Split a `-z` listing into its fields.
 *
 * @param bytes - The listing; every field ends in NUL
 * @returns The fields, as views of `bytes`, or undefined when the listing does not end in NUL
 */
function nulFields(bytes: Uint8Array): Uint8Array[] | undefined {
  const fields: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    const end = bytes.indexOf(NUL, at);
    if (end === -1) return undefined;
    fields.push(bytes.subarray(at, end));
    at = end + 1;
  }
  return fields;
}

/** What {@link malformed} says of a `-z` listing cut short. */
const NOT_NUL_ENDED = 'the listing does not end in NUL';

/** The refusal for a listing git should never have written, naming the command and the record. */
function malformed(command: string, what: string): Refusal {
  return { ok: false, kind: 'repository', reason: `${command} wrote a listing VAT cannot read: ${what}.` };
}

/** One record read at `at`, and how many fields it took — or the refusal naming it. */
function readRecord(fields: readonly Uint8Array[], at: number): { record: GitNameStatusRecord; width: number } | Refusal {
  const status = fields[at] ?? new Uint8Array();
  // A status that is not UTF-8 is no status git writes: `''` matches nothing and is refused below.
  const letters = decodeUtf8Exactly(status) ?? '';
  const single = SINGLE_PATH_STATUS.get(letters);
  if (single !== undefined) {
    const path = fields[at + 1];
    if (path === undefined) return malformed(LISTING_COMMAND, `status ${shownName(status)} has no path`);
    return { record: { status: single, path, oldPath: null, similarity: null }, width: 2 };
  }
  // A copy (`C`) or an unmerged path (`U`) lands here too: never asked for, so never guessed at.
  const score = RENAME_STATUS.exec(letters)?.[1];
  if (score === undefined) return malformed(LISTING_COMMAND, `unknown status ${shownName(status)}`);
  const oldPath = fields[at + 1];
  const path = fields[at + 2];
  if (oldPath === undefined || path === undefined) return malformed(LISTING_COMMAND, `status ${shownName(status)} needs two paths`);
  return { record: { status: 'renamed', path, oldPath, similarity: Number(score) }, width: 3 };
}

/**
 * Read `git diff-tree -M --name-status -z` output.
 *
 * @param bytes - The listing, byte for byte
 * @returns One record per changed path, in listing order — or, for a status it does not know or a
 *   record cut short, the repository's refusal naming it: never guessed at, never thrown
 */
export function parseNameStatusZ(bytes: Uint8Array): { ok: true; records: GitNameStatusRecord[] } | Refusal {
  const fields = nulFields(bytes);
  if (fields === undefined) return malformed(LISTING_COMMAND, NOT_NUL_ENDED);
  const records: GitNameStatusRecord[] = [];
  let at = 0;
  while (at < fields.length) {
    const read = readRecord(fields, at);
    if ('kind' in read) return read;
    records.push(read.record);
    at += read.width;
  }
  return { ok: true, records };
}

/** Whether `path` lies under `prefix` (which is empty, or ends in `/`). */
function isUnder(path: Uint8Array, prefix: Uint8Array): boolean {
  return path.length > prefix.length && Buffer.from(prefix).equals(path.subarray(0, prefix.length));
}

/**
 * A record as seen from inside the root: kept, re-kinded at the boundary, or dropped.
 *
 * @returns The record's shape inside the root, or undefined when it does not reach the root
 */
function seenFromRoot(record: GitNameStatusRecord, prefix: Uint8Array): GitNameStatusRecord | undefined {
  const pathIn = isUnder(record.path, prefix);
  if (record.oldPath === null) return pathIn ? record : undefined;
  const oldIn = isUnder(record.oldPath, prefix);
  if (pathIn && oldIn) return record;
  if (pathIn) return { status: 'added', path: record.path, oldPath: null, similarity: null };
  return oldIn ? { status: 'deleted', path: record.oldPath, oldPath: null, similarity: null } : undefined;
}

/** The text a path under the root names, relative to it — or undefined when it is not UTF-8. */
function relativeText(path: Uint8Array, prefix: Uint8Array): string | undefined {
  return decodeUtf8Exactly(path.subarray(prefix.length));
}

/**
 * Keep the changes under the root, relative to it.
 *
 * @param records - The `--name-status` records, paths from the repository's top
 * @param prefix - The root's path from the repository's top: empty, or ending in `/`
 * @returns The changes sorted by path, or a refusal naming a path that is not UTF-8
 */
export function changedFilesUnderPrefix(records: readonly GitNameStatusRecord[], prefix: Uint8Array): GitChangedFilesOutcome {
  const files: GitChangedFile[] = [];
  for (const record of records) {
    const seen = seenFromRoot(record, prefix);
    if (seen === undefined) continue;
    const path = relativeText(seen.path, prefix);
    const oldPath = seen.oldPath === null ? null : relativeText(seen.oldPath, prefix);
    if (path === undefined || oldPath === undefined) {
      const bytes = path === undefined ? seen.path : (seen.oldPath ?? seen.path);
      return {
        ok: false,
        kind: 'repository',
        reason: `The path ${shownName(bytes)} is not UTF-8, so VAT cannot name it; rename it in the repository.`,
      };
    }
    files.push({ path, status: seen.status, oldPath, similarity: seen.similarity });
  }
  files.sort((left, right) => compareCodeUnits(left.path, right.path) || compareCodeUnits(left.status, right.status));
  return { ok: true, files };
}

/** A path segment as a case-insensitive, normalisation-insensitive filesystem (APFS) compares it. */
function foldSegment(segment: string): string {
  // No upper-case round trip: `'ß'.toUpperCase()` is `SS`, which would fold `straße` into
  // `strasse` — two names APFS keeps apart.
  return segment.normalize('NFD').toLowerCase();
}

/**
 * A git path's `/`-separated segments, split on the byte so no decode can move a separator.
 *
 * @returns Each segment's text, or undefined when one is not UTF-8
 */
function segmentsOf(path: Uint8Array): string[] | undefined {
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index <= path.length; index++) {
    if (index < path.length && path[index] !== SLASH) continue;
    const segment = decodeUtf8Exactly(path.subarray(start, index));
    if (segment === undefined) return undefined;
    segments.push(segment);
    start = index + 1;
  }
  return segments;
}

/**
 * The leading segments of `path` that spell `prefix` once both are case-folded and normalised, when
 * they are not `prefix` byte for byte.
 *
 * @param path - A path git listed, from the repository's top
 * @param prefix - The root's path from the repository's top, ending in `/`
 * @returns That other spelling, ending in `/`, or undefined when the path agrees or lies elsewhere
 */
function spellingInAnotherForm(path: Uint8Array, prefix: Uint8Array): string | undefined {
  if (isUnder(path, prefix)) return undefined;
  const wanted = segmentsOf(prefix)?.slice(0, -1);
  const segments = segmentsOf(path);
  // A segment that is not UTF-8 spells nothing to fold; the listing's own read refuses it.
  if (wanted === undefined || segments === undefined || segments.length <= wanted.length) return undefined;
  const leading = segments.slice(0, wanted.length);
  const agrees = leading.every((segment, index) => foldSegment(segment) === foldSegment(wanted[index] ?? ''));
  return agrees ? `${leading.join('/')}/` : undefined;
}

/**
 * The other spelling of the root a record names, if any: its path (a deletion's included), and a
 * rename's old side WHEREVER its new side lands. On a filesystem that folds case, an old side under
 * another spelling was under the root already, so a rename into the root (`Docs/a.md` ->
 * `docs/a.md`) is no addition, and a rename out of it is no plain deletion — one rule for all three.
 */
function reportedSpellingInAnotherForm(record: GitNameStatusRecord, prefix: Uint8Array): string | undefined {
  const reported = spellingInAnotherForm(record.path, prefix);
  if (reported !== undefined || record.oldPath === null) return reported;
  return spellingInAnotherForm(record.oldPath, prefix);
}

/**
 * Refuse when a changed path, or a rename's old side wherever its new side lands, is spelled under
 * the root in another case or normalisation: the byte filter would otherwise drop it in silence, or
 * report a rename the root never saw as an addition.
 *
 * @param records - The `--name-status` records, paths from the repository's top
 * @param prefix - The root's path from the repository's top: empty, or ending in `/`
 * @param folds - Whether the root's filesystem folds case ({@link rootFoldsCase}). Where it does
 *   not, a path in another case is another directory, simply not under the root
 * @returns A refusal naming both spellings, or undefined when every path agrees
 */
export function caseSpellingRefusal(records: readonly GitNameStatusRecord[], prefix: Uint8Array, folds: boolean): Refusal | undefined {
  if (!folds || prefix.length === 0) return undefined;
  const other = records.map((record) => reportedSpellingInAnotherForm(record, prefix)).find((spelling) => spelling !== undefined);
  if (other === undefined) return undefined;
  return {
    ok: false,
    kind: 'repository',
    reason: `git reports this root as ${shownName(prefix)} but the diff names a path under it as`
      + ` ${shownName(other)} (another case or Unicode normalisation), so its change cannot be matched to the root.`
      + ' Point VAT at the directory in the spelling git lists, or make the case agree in the repository.',
  };
}

/** The identity of what `path` names, or undefined when it names nothing; a stat the OS refuses throws. */
function entryIdentity(path: string): { dev: bigint; ino: bigint } | undefined {
  try {
    const { dev, ino } = lstatSync(path, { bigint: true });
    return { dev, ino };
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    throw error;
  }
}

/**
 * Whether the filesystem holding `root` folds case — PROBED, never assumed from the platform or
 * from `core.ignorecase`: the root's path with its last cased segment spelled in the other case is
 * looked up, and it folds when that names the same entry (`dev` and `ino`). A probe that cannot
 * decide — no cased segment, an `ino` of 0, a stat the OS refuses — answers true, which only ever
 * turns on checks that refuse.
 *
 * @param root - The absolute root
 * @returns Whether two spellings differing only in case name one entry there
 */
function rootFoldsCase(root: string): boolean {
  const segments = toForwardSlash(root).split('/');
  const at = segments.findLastIndex((segment) => segment.toUpperCase() !== segment.toLowerCase());
  const segment = segments[at];
  if (segment === undefined) return true;
  const flipped = segment === segment.toUpperCase() ? segment.toLowerCase() : segment.toUpperCase();
  try {
    const own = entryIdentity(root);
    const other = entryIdentity([...segments.slice(0, at), flipped, ...segments.slice(at + 1)].join('/'));
    if (other === undefined) return false;
    if (own === undefined || own.ino === 0n) return true;
    return own.dev === other.dev && own.ino === other.ino;
  } catch (error) {
    // A stat the OS refused cannot decide; anything else is a bug and propagates.
    if (fsFaultOf(error) !== undefined) return true;
    throw error;
  }
}

/**
 * On a filesystem that folds case, refuse a repository whose `core.ignorecase` is not true: git
 * then treats two spellings the disk holds as one file as two, and a case-only change is
 * misreported.
 *
 * @returns A refusal naming the fix, or undefined
 */
function ignoreCaseRefusal(root: string, folds: boolean): Refusal | undefined {
  if (!folds) return undefined;
  const ignoreCase = configIsTrue(root, 'core.ignorecase');
  if (!ignoreCase.ok) return ignoreCase;
  if (ignoreCase.value) return undefined;
  return {
    ok: false,
    kind: 'repository',
    reason: `${shownName(root)} is on a filesystem that folds case, but this repository's core.ignorecase is not true,`
      + ' so git can read one file as two and a case-only change would be misreported.'
      + ' Run git config core.ignorecase true, then run again.',
  };
}

/** git's own words, for a refusal: what it said, or that it said nothing. */
function gitSaid(stderr: string): string {
  return stderr === '' ? '' : ` git said: ${stderr}`;
}

/** Whose fault each of git's causes is, as this module reports it — the classifier's codes, one kind each. */
export const GIT_CHANGED_FILES_KIND_BY_CODE: Readonly<Record<GitNoAnswerCode, GitChangedFilesRefusalKind>> = {
  GIT_NOT_FOUND: GIT_FAILED_KIND,
  GIT_FAILED: GIT_FAILED_KIND,
  GIT_NO_ANSWER: 'repository',
  GIT_SNAPSHOT_UNREADABLE: 'repository',
  GIT_SNAPSHOT_REFUSED: 'repository',
  // The relation takes the snapshot, not the key, but refuses a tree whose sparse index hides an
  // edit by the key's own failure (`indexHidesFailure`), classified here: the repository's.
  GIT_SNAPSHOT_INDEX_HIDES: 'repository',
};

/** The refusal for a cause the one classifier (`git-no-answer.ts`) decided. */
function refusalOf(cause: GitNoAnswer): Refusal {
  return { ok: false, kind: GIT_CHANGED_FILES_KIND_BY_CODE[cause.code], reason: cause.reason };
}

/**
 * The refusal for a git that did not run or did not finish — never the caller's ref or tree — as
 * the one classifier words it ({@link gitRunFailureOf}).
 *
 * @param subcommand - The git subcommand that ran (`diff-tree`)
 * @param cwd - The directory it ran in
 * @param result - What running it did
 * @returns The refusal, or undefined when git ran to an exit status
 */
export function gitDidNotRun(subcommand: string, cwd: string, result: GitAttempt): Refusal | undefined {
  const cause = gitRunFailureOf(`git ${subcommand}`, cwd, result);
  return cause === undefined ? undefined : refusalOf(cause);
}

/** Run one git command for its trimmed text answer, or the refusal for a git that did not finish. */
function ask(root: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } | Refusal {
  const result = runGit(args, { cwd: root });
  return gitDidNotRun(args[0] ?? '', root, result) ?? result;
}

/**
 * Resolve a ref to the commit it names.
 *
 * @returns The full commit id, or a refusal naming the fix
 */
function resolveBase(root: string, base: string): { ok: true; commit: string } | Refusal {
  // A leading `-` would be read as an option, never as a ref.
  if (base === '' || base.startsWith('-')) {
    return { ok: false, kind: 'base', reason: `The base ${shownName(base)} is not a ref; pass a branch, tag or commit.` };
  }
  const result = ask(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if ('kind' in result) return result;
  if (!result.ok || result.stdout === '') {
    // A git that cannot resolve HEAD either is a repository that cannot answer, whatever ref was typed.
    const head = ask(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if ('kind' in head) return head;
    if (!head.ok || head.stdout === '') {
      return {
        ok: false,
        kind: 'repository',
        reason: `git could not resolve the base ${shownName(base)}, and it cannot resolve HEAD either, so the`
          + ` repository, not the ref, is what fails.${gitSaid(result.stderr || head.stderr)} Check the repository (git fsck).`,
      };
    }
    return {
      ok: false,
      kind: 'base',
      reason: `The base ${shownName(base)} does not name a commit in this repository.`
        + ' Check the spelling, or fetch it first (a shallow CI clone often lacks it: git fetch origin <branch>).',
    };
  }
  return { ok: true, commit: result.stdout };
}

/**
 * Refuse a repository whose HEAD is unborn: with no commit there is no merge base to name.
 *
 * @returns A refusal, or undefined when HEAD names a commit
 */
function unbornHeadRefusal(root: string): Refusal | undefined {
  const result = ask(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if ('kind' in result) return result;
  if (result.ok && result.stdout !== '') return undefined;
  return {
    ok: false,
    kind: 'repository',
    reason: 'This repository has no commits yet (HEAD is unborn), so there is no merge base to compare'
      + ' with. Commit first.',
  };
}

/**
 * Read `git merge-base --all` as the ONE merge base a diff can start from.
 *
 * @param base - The ref as the caller typed it
 * @param listing - git's answer: one commit per line
 * @param shallow - Whether the clone is shallow: then no merge base means the history is cut off
 *   before the two meet, not that they never do
 * @returns The commit, or a refusal for none or several (a criss-cross history)
 */
export function mergeBaseOf(base: string, listing: string, shallow: boolean): { ok: true; commit: string } | Refusal {
  const commits = listing.split('\n').filter((line) => line !== '');
  const [only] = commits;
  if (commits.length === 1 && only !== undefined) return { ok: true, commit: only };
  if (commits.length === 0) {
    // Shallow: the history is cut off, the repository's to deepen. Whole: the two never meet, so the
    // fix is another argument — the base's fault.
    return shallow
      ? {
        ok: false,
        kind: 'repository',
        reason: `This is a shallow clone, and the history it holds is cut off before the base ${shownName(base)} and HEAD`
          + ` meet, so there is no merge base to compare with. ${DEEPEN_REMEDY}`,
      }
      : {
        ok: false,
        kind: 'base',
        reason: `The base ${shownName(base)} shares no history with HEAD here, so there is no merge base to compare with.`
          + ' Pass a commit HEAD descends from.',
      };
  }
  // The base's fault: the fix is another argument, one of these.
  return {
    ok: false,
    kind: 'base',
    reason: `The base ${shownName(base)} has ${String(commits.length)} merge bases with HEAD (${commits.join(', ')}),`
      + ' so "what this change touched" has no single answer. Pass one of them, or another commit HEAD'
      + ' descends from, as the base.',
  };
}

/**
 * The merge base of the base commit and HEAD: where this change left the base.
 *
 * @returns The merge-base commit, or a refusal naming the fix when there is not exactly one
 */
function mergeBase(root: string, base: string, commit: string, shallow: boolean): { ok: true; commit: string } | Refusal {
  const result = ask(root, ['merge-base', '--all', commit, 'HEAD']);
  if ('kind' in result) return result;
  // `merge-base` exits 1, saying nothing, when there is none; anything else it says is a fault.
  if (!result.ok && result.stderr !== '') {
    return { ok: false, kind: 'repository', reason: `git merge-base failed.${gitSaid(result.stderr)}` };
  }
  return mergeBaseOf(base, result.ok ? result.stdout : '', shallow);
}

/**
 * The root's path from the repository's top, as bytes: empty at the top, else ending in `/`.
 *
 * Asks `--is-inside-work-tree` with the prefix, and refuses unless the first answer is exactly
 * `true`: a bare repository and a directory inside `.git` both answer a prefix, and neither holds a
 * working tree to snapshot.
 *
 * @returns The prefix, or a refusal when the root is not inside a git working tree
 */
function rootPrefix(root: string): { ok: true; prefix: Uint8Array } | Refusal {
  const result = runGitBytes(['rev-parse', '--is-inside-work-tree', '--show-prefix'], { cwd: root });
  const notWorkTree = (said: string): Refusal => ({
    ok: false,
    kind: 'repository',
    reason: `${shownName(root)} is not inside a git working tree (no repository, a bare one, or a directory inside .git),`
      + ` so there is no tree to compare with the base.${said}`,
  });
  if (!result.ok) return gitDidNotRun('rev-parse', root, result) ?? notWorkTree(gitSaid(result.stderr));
  const bytes = result.stdout;
  const firstEnd = bytes.indexOf(NEWLINE);
  if (firstEnd === -1 || decodeUtf8Exactly(bytes.subarray(0, firstEnd)) !== 'true') return notWorkTree('');
  const rest = bytes.subarray(firstEnd + 1);
  return { ok: true, prefix: rest.at(-1) === NEWLINE ? rest.subarray(0, -1) : rest };
}

/** The flags an `ls-files -v` tag carries that hide a file's edits from git. */
interface HiddenEditFlags {
  /** `S`, or `s` (both flags). */
  readonly skipWorktree: boolean;
  /** Any lowercase tag. */
  readonly assumeUnchanged: boolean;
}

/** The flags `tag` carries: `S` skip-worktree, a lowercase letter assume-unchanged, `s` both. */
function hiddenEditFlagsOf(tag: string): HiddenEditFlags {
  return { skipWorktree: tag === 'S' || tag === 's', assumeUnchanged: tag >= 'a' && tag <= 'z' };
}

/** One `ls-files -v` entry flagged skip-worktree: its flags and its path. */
export interface FlaggedEntry {
  readonly flags: HiddenEditFlags;
  /** The entry's path, decoded; `undefined` when it is not UTF-8. */
  readonly path: string | undefined;
  /** The entry's path as git listed it, repository-relative. */
  readonly bytes: Uint8Array;
}

/** What git's index flags say about a snapshot of the tree, by {@link judgeIndexFlags}. */
interface IndexFlagJudgment {
  readonly ok: true;
  /**
   * Skip-worktree entries with nothing on disk: the snapshot holds their staged bytes, but no file
   * is there (a sparse checkout's file, or one deleted under the flag).
   */
  readonly absent: ReadonlyArray<FlaggedEntry & { readonly path: string }>;
  /**
   * Skip-worktree entries on disk while the index holds a directory collapsed (a sparse index): the
   * snapshot keeps a collapsed directory's staged bytes, so an edit to one is missing from it. Empty
   * when the index holds no collapsed directory.
   */
  readonly hiding: readonly FlaggedEntry[];
}

/** A git command of {@link judgeIndexFlags} that gave no usable answer. */
type IndexFlagFailure =
  | { readonly ok: false; readonly kind: 'unlisted'; readonly command: string; readonly attempt: GitBytesRunResult }
  | { readonly ok: false; readonly kind: 'unreadable'; readonly command: string; readonly reason: string };

/** The command whose listing says whether the index holds a collapsed directory, as its errors name it. */
const SPARSE_LISTING_COMMAND = 'git ls-files --sparse -s -z';

/** How a collapsed directory's entry starts in {@link SPARSE_LISTING_COMMAND}'s listing: its tree mode. */
const COLLAPSED_DIRECTORY_MODE = new TextEncoder().encode('040000 ');

/** Whether `field` starts with `prefix`, byte for byte. */
function startsWithBytes(field: Uint8Array, prefix: Uint8Array): boolean {
  return field.length >= prefix.length && prefix.every((byte, at) => field[at] === byte);
}

/**
 * Whether the index is a sparse index holding any directory as one collapsed entry (mode `040000` in
 * `git ls-files --sparse -s`), read from the index's real state, never from `index.sparse`.
 */
function holdsCollapsedDirectory(root: string): { readonly ok: true; readonly collapsed: boolean } | IndexFlagFailure {
  // The whole listing, however large: the runner clamps this to its own cap.
  const listed = runGitBytes(['ls-files', '--sparse', '-s', '-z'], { cwd: root, maxBuffer: Number.MAX_SAFE_INTEGER });
  if (!listed.ok) return { ok: false, kind: 'unlisted', command: SPARSE_LISTING_COMMAND, attempt: listed };
  const fields = nulFields(listed.stdout);
  if (fields === undefined) {
    return { ok: false, kind: 'unreadable', command: SPARSE_LISTING_COMMAND, reason: malformed(SPARSE_LISTING_COMMAND, NOT_NUL_ENDED).reason };
  }
  return { ok: true, collapsed: fields.some((field) => startsWithBytes(field, COLLAPSED_DIRECTORY_MODE)) };
}

/**
 * The one rule for an index flag, shared by `changed_files` (`hiddenEditsRefusal`) and the store key
 * (`gitTreeKey`). The snapshot (`@vibe-validate/git`) stages through a copy of the index and clears,
 * in that copy only, assume-unchanged on every entry and skip-worktree on every entry present on
 * disk, so:
 *
 * - assume-unchanged alone hides nothing: the entry is never stat'd;
 * - skip-worktree with nothing on disk is ABSENT (the snapshot still holds its staged bytes);
 * - skip-worktree on disk hides nothing, unless the index is a sparse index holding a directory
 *   collapsed, where an edit inside it keeps its staged bytes in the snapshot: then every such entry
 *   HIDES. Asked of `git ls-files --sparse` only when there is such an entry, so a tree with no flag
 *   costs no spawn here.
 *
 * The existence check is an `lstat` of a skip-worktree entry's path, and nothing else: no file is
 * opened, read or hashed. A path that is not UTF-8, or one the OS will not stat, counts as present.
 *
 * @param root - The repository root the listing's paths are relative to
 * @param entries - The entries of {@link hiddenEditEntriesOf}
 * @returns The absent and the hiding entries, in git's order, or why git gave no usable answer
 */
export function judgeIndexFlags(root: string, entries: readonly TaggedEntry[]): IndexFlagJudgment | IndexFlagFailure {
  const absent: Array<FlaggedEntry & { readonly path: string }> = [];
  const present: FlaggedEntry[] = [];
  for (const entry of entries) {
    const flags = hiddenEditFlagsOf(entry.tag);
    if (!flags.skipWorktree) continue;
    const path = decodeUtf8Exactly(entry.path);
    if (path !== undefined && !onDisk(safePath.join(root, path))) absent.push({ flags, path, bytes: entry.path });
    else present.push({ flags, path, bytes: entry.path });
  }
  if (present.length === 0) return { ok: true, absent, hiding: [] };
  const sparse = holdsCollapsedDirectory(root);
  if (!sparse.ok) return sparse;
  return { ok: true, absent, hiding: sparse.collapsed ? present : [] };
}

/** How many hiding entries a declined key names; the rest are counted. */
const NAMED_HIDDEN_ENTRIES = 2;

/** The flags a hiding entry carries, as a declined key names them. */
function hidingFlagOf({ flags }: FlaggedEntry): GitHiddenEntry['flag'] {
  return flags.assumeUnchanged ? 'assume-unchanged and skip-worktree' : 'skip-worktree';
}

/**
 * The declined key for a tree whose index hides bytes from the snapshot ({@link judgeIndexFlags}'s
 * `hiding`), classified by `gitSnapshotFailureOf`: the one failure both callers report.
 *
 * @param cwd - The directory the answer was asked from
 * @param repositoryRoot - The repository root
 * @param hiding - The hiding entries; never empty
 * @returns The failure naming the first entries and counting them all
 */
export function indexHidesFailure(cwd: string, repositoryRoot: string, hiding: readonly FlaggedEntry[]): GitTreeKeyFailure {
  const hidden = hiding.slice(0, NAMED_HIDDEN_ENTRIES).map((entry) => ({ shownPath: shownName(entry.path ?? entry.bytes), flag: hidingFlagOf(entry) }));
  return { ok: false, kind: 'index-hides', cwd, repositoryRoot, hidden, hiddenCount: hiding.length };
}

/** Whether anything is at `path` on disk; a path the OS will not stat counts as there. */
function onDisk(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return !isPathAbsentError(error);
  }
}

/**
 * Whether a boolean git config is set to true here: unset, or any other value, is not.
 *
 * @returns The answer, or `git-failed` for a git that did not run
 */
function configIsTrue(root: string, key: string): { ok: true; value: boolean } | Refusal {
  const result = ask(root, ['config', '--type=bool', '--get', key]);
  if ('kind' in result) return result;
  return { ok: true, value: result.ok && result.stdout === 'true' };
}

/**
 * Refuse a tree whose index hides a change from the snapshot, by the one rule
 * ({@link judgeIndexFlags}): a skip-worktree file on disk in a directory a sparse index holds
 * collapsed (an edit to it is missing), or a skip-worktree file absent from disk outside a sparse
 * checkout (`core.sparseCheckout` not true), whose deletion git hides from the diff. Inside a sparse
 * checkout an absent skip-worktree file is absent by design, and no change.
 *
 * @returns A refusal naming the first such file and the fix, or undefined
 */
function hiddenEditsRefusal(root: string): Refusal | undefined {
  const listed = bytesOf('ls-files', root, runGitBytes(['ls-files', '-v', '-z'], { cwd: root }));
  if (!listed.ok) return listed;
  const read = hiddenEditEntriesOf(listed.stdout);
  if (!read.ok) return read;
  const judged = judgeIndexFlags(root, read.entries);
  if (!judged.ok) {
    if (judged.kind === 'unreadable') return { ok: false, kind: 'repository', reason: judged.reason };
    return gitDidNotRun('ls-files', root, judged.attempt) ?? { ok: false, kind: 'repository', reason: `${judged.command} failed.${gitSaid(judged.attempt.stderr)}` };
  }
  if (judged.hiding.length > 0) return refusalOf(gitSnapshotFailureOf(indexHidesFailure(root, root, judged.hiding)));
  return hiddenDeletionRefusal(root, judged.absent);
}

/**
 * Refuse an absent skip-worktree entry outside a sparse checkout: its deletion is one git hides.
 *
 * @returns A refusal naming the first such file and every flag to clear, or undefined
 */
function hiddenDeletionRefusal(root: string, absent: IndexFlagJudgment['absent']): Refusal | undefined {
  const [first] = absent;
  if (first === undefined) return undefined;
  const sparse = configIsTrue(root, SPARSE_CHECKOUT_KEY);
  if (!sparse.ok) return sparse;
  return sparse.value ? undefined : hiddenEditRefusal(shownName(first.path), first.flags);
}

/** One `ls-files -v -z` entry: its one-letter tag and its path, still the bytes git wrote. */
interface TaggedEntry {
  readonly tag: string;
  readonly path: Uint8Array;
}

/**
 * Read `git ls-files -v -z` output: each entry is a tag letter, a space, and the path.
 *
 * @param bytes - The listing, byte for byte
 * @returns The entries, or — for a listing that does not end in NUL — the repository's refusal
 *   naming it: a cut-short listing is never read as "no file flagged"
 */
export function hiddenEditEntriesOf(bytes: Uint8Array): { ok: true; entries: TaggedEntry[] } | Refusal {
  const fields = nulFields(bytes);
  if (fields === undefined) return malformed(FLAGS_LISTING_COMMAND, NOT_NUL_ENDED);
  return { ok: true, entries: fields.map((entry) => ({ tag: String.fromCodePoint(entry[0] ?? 0), path: entry.subarray(2) })) };
}

/** The refusal for one flagged file: every flag it carries, and the one command that clears them. */
function hiddenEditRefusal(named: string, flags: HiddenEditFlags): Refusal {
  const set = [
    ...(flags.skipWorktree ? [{ flag: 'skip-worktree', clear: '--no-skip-worktree' }] : []),
    ...(flags.assumeUnchanged ? [{ flag: 'assume-unchanged', clear: '--no-assume-unchanged' }] : []),
  ];
  const marked = set.map(({ flag }) => flag).join(' and ');
  const clear = set.map(({ clear: option }) => option).join(' ');
  return {
    ok: false,
    kind: 'repository',
    reason: `${named} is marked ${marked} in git's index, so git does not read it and a change to it (an edit, or`
      + ` its deletion) would be missing from the answer. Clear ${set.length > 1 ? 'the flags' : 'the flag'}`
      + ` (git update-index ${clear} -- ${named}) and run again.`,
  };
}

/**
 * The working tree as one git tree — see the module header.
 *
 * @returns The tree's id, or a refusal saying why git could not take it, as the one classifier
 *   (`gitSnapshotFailureOf`) decides for every lane
 */
function snapshotTree(root: string): { ok: true; tree: string } | Refusal {
  const snapshot = gitTreeSnapshot({ cwd: root });
  return snapshot.ok ? { ok: true, tree: snapshot.hash } : refusalOf(gitSnapshotFailureOf(snapshot));
}

/** What a person whose directory git cannot list can do about it. */
const UNLISTABLE_REMEDY = 'Fix its permissions so git can list it, or add it to .gitignore, then run again.';

/**
 * Refuse a directory under the root git cannot list. `git add --all` only WARNS on one and exits 0,
 * so the untracked files beneath it would be missing from a snapshot that still succeeds. Asked of
 * the repository's one unreadable-policy listing (`git ls-files --others`, the same warning the
 * snapshot meets), never of the crawl lane, so this relation answers the same whichever lane built
 * the projection.
 *
 * @returns A refusal naming the first such directory, or undefined
 */
function unlistableDirectoryRefusal(root: string): Refusal | undefined {
  const refused: DirectoryRefusal[] = [];
  const listed = gitLsOthers({ cwd: root, unreadable: { degrade: (refusal) => refused.push(refusal) } });
  const [first] = refused;
  if (first !== undefined) {
    const more = refused.length > 1 ? ` (and ${String(refused.length - 1)} more directories git could not list)` : '';
    const message = refusedListingMessage(first, { root, remedy: UNLISTABLE_REMEDY, side: 'source' });
    return { ok: false, kind: 'repository', reason: `${message}${more}` };
  }
  if (listed !== null) return undefined;
  return gitFailed('git ls-files --others gave no listing here, so VAT cannot tell whether every directory under the root'
    + ' was read. Check that git runs here.');
}

/**
 * One history-sized git command's bytes — the diff, or a walk of the commits — or the
 * refusal for a git that did not finish or did not succeed. The argv goes to `runGitBytes` at the call site.
 *
 * @returns git's output, or a refusal
 */
function bytesOf(subcommand: string, root: string, result: ReturnType<typeof runGitBytes>): { ok: true; stdout: Uint8Array } | Refusal {
  if (result.ok) return { ok: true, stdout: result.stdout };
  return gitDidNotRun(subcommand, root, result) ?? { ok: false, kind: 'repository', reason: `git ${subcommand} failed.${gitSaid(result.stderr)}` };
}

/**
 * The one diff: the merge base against the snapshot, every path from the repository's top.
 *
 * @returns The records, or a refusal
 */
function diffRecords(root: string, from: string, to: string): { ok: true; records: GitNameStatusRecord[] } | Refusal {
  const listing = bytesOf('diff-tree', root, runGitBytes(['diff-tree', '-r', '-M', '-l0', '--name-status', '-z', from, to], { cwd: root }));
  if (listing.ok) return parseNameStatusZ(listing.stdout);
  if (listing.kind !== 'repository' || !isPartialClone(root)) return listing;
  return {
    ok: false,
    kind: 'repository',
    reason: `${listing.reason} This is a partial clone, so the objects the diff needs may never have been fetched and`
      + ' its promisor remote could not supply them. Fetch them (git fetch --refetch), or use a clone with no --filter.',
  };
}

/** Whether the repository is a partial clone: `extensions.partialClone` or any `remote.<name>.promisor` set. */
export function isPartialClone(root: string): boolean {
  const extension = runGit(['config', '--get', 'extensions.partialClone'], { cwd: root });
  if (extension.ok && extension.stdout !== '') return true;
  const promisor = runGit(['config', '--get-regexp', String.raw`^remote\..*\.promisor$`], { cwd: root });
  return promisor.ok && promisor.stdout !== '';
}

/** The fix for a merge base a shallow history cannot vouch for. */
const DEEPEN_REMEDY = 'Fetch full history (e.g. actions/checkout fetch-depth: 0) or deepen until the history between'
  + ' the merge base and the tips is complete (git fetch --deepen=<n>).';

/**
 * A git probe whose answer must be exactly `true` or `false`.
 *
 * @returns The answer, or `git-failed` for a probe that failed or answered anything else
 */
function askBoolean(root: string, args: readonly string[]): { ok: true; value: boolean } | Refusal {
  const result = ask(root, args);
  if ('kind' in result) return result;
  if (result.ok && (result.stdout === 'true' || result.stdout === 'false')) return { ok: true, value: result.stdout === 'true' };
  return gitFailed(
    `git ${args.join(' ')} answered ${shownName(result.stdout)}, not true or false.${gitSaid(result.stderr)}`
      + ' Check that git runs here.',
  );
}

/**
 * The shallow boundary file's absolute path. Asked with `--path-format=absolute` (git 2.31+), so a
 * root reached through a symlink or junction cannot misplace a relative answer; an older git that
 * does not understand it answers more than one line, and its relative answer is then resolved
 * against the root's real path, which is where git ran.
 *
 * @returns The path, or a refusal
 */
function shallowFile(root: string): { ok: true; file: string } | Refusal {
  const absolute = ask(root, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow']);
  if ('kind' in absolute) return absolute;
  if (absolute.ok && !absolute.stdout.includes('\n') && isAbsoluteAnyPlatform(absolute.stdout)) {
    return { ok: true, file: absolute.stdout };
  }
  const relative = ask(root, ['rev-parse', '--git-path', 'shallow']);
  if ('kind' in relative) return relative;
  if (!relative.ok) return { ok: false, kind: 'repository', reason: `git rev-parse --git-path failed.${gitSaid(relative.stderr)}` };
  try {
    return { ok: true, file: safePath.resolve(normalizePath(root, { within: root }), relative.stdout) };
  } catch (error) {
    // A link cycle, or a link chain VAT refuses to follow: the reason carries git's root and the error.
    return { ok: false, kind: 'repository', reason: `${shownName(root)} has no real path VAT can resolve (${String(error)}).` };
  }
}

/**
 * The commits the shallow boundary file lists — or a refusal when it cannot be read, or is gone
 * while git still calls the repository shallow.
 *
 * @returns The boundary, `null` when the repository stopped being shallow, or a refusal
 */
function shallowBoundary(root: string): { ok: true; boundary: Set<string> | null } | Refusal {
  const file = shallowFile(root);
  if (!file.ok) return file;
  const read = readShallowBoundary(file.file);
  if (read.found === 'commits') return { ok: true, boundary: read.commits };
  if (read.found === 'unreadable') {
    return { ok: false, kind: 'repository', reason: `This shallow clone's boundary list (${shownName(file.file)}) cannot be read. ${DEEPEN_REMEDY}` };
  }
  // Gone between the two questions: unshallowed — unless git still says shallow, when VAT read the wrong file.
  const still = askBoolean(root, ['rev-parse', '--is-shallow-repository']);
  if (!still.ok) return still;
  if (!still.value) return { ok: true, boundary: null };
  return {
    ok: false,
    kind: 'repository',
    reason: `git calls this repository shallow, but its boundary list is not at ${shownName(file.file)}, so VAT cannot`
      + ` tell which commits are cut off. ${DEEPEN_REMEDY}`,
  };
}

/**
 * In a shallow clone, refuse a merge base a cut-off history could be hiding a nearer one behind:
 * one of the commits between it and either tip is a shallow boundary, whose parents are not here.
 * The merge base itself on the boundary is fine — nothing lies behind it that could be nearer.
 *
 * @param commits - The base commit and the merge base
 * @returns A refusal naming the fix, or undefined when the history is whole
 */
function shallowHistoryRefusal(root: string, commits: { base: string; mergeBase: string }): Refusal | undefined {
  const read = shallowBoundary(root);
  if (!read.ok) return read;
  const { boundary } = read;
  if (boundary === null) return undefined;
  const between = bytesOf('rev-list', root, runGitBytes(['rev-list', 'HEAD', commits.base, '--not', commits.mergeBase], { cwd: root }));
  if (!between.ok) return between;
  // Object names are hex, so an exact UTF-8 read cannot fail or re-spell one.
  const hidden = (decodeUtf8Exactly(between.stdout) ?? '').split('\n').find((commit) => boundary.has(commit));
  if (hidden === undefined) return undefined;
  return {
    ok: false,
    kind: 'repository',
    reason: `This is a shallow clone, and commit ${hidden} between the merge base and a tip is cut off from its`
      + ' parents, so a nearer merge base could be hidden behind it and the changes listed could be wrong.'
      + ` ${DEEPEN_REMEDY}`,
  };
}

/** What reading a shallow clone's boundary file found: its commits, no file, or a file that cannot be read. */
type BoundaryRead = { readonly found: 'commits'; readonly commits: Set<string> } | { readonly found: 'absent' | 'unreadable' };

/** Read a shallow clone's boundary file. */
function readShallowBoundary(file: string): BoundaryRead {
  try {
    const text = decodeUtf8Exactly(readFileSync(file));
    return text === undefined
      ? { found: 'unreadable' }
      : { found: 'commits', commits: new Set(text.split('\n').filter((line) => line !== '')) };
  } catch (error) {
    return { found: isPathAbsentError(error) ? 'absent' : 'unreadable' };
  }
}

/**
 * Every file this change touched under `root`: one snapshot of the working tree (untracked files
 * included) compared with the merge base of `base` and HEAD. See the module header for exactly
 * what is compared and how a path crossing the root's boundary is reported.
 *
 * Never throws for a condition the caller can fix — no working tree, no commits, a ref that names no
 * commit, no single merge base, a shallow history that cannot vouch for it, a file git is told not
 * to read, a directory git cannot list, a folding filesystem git is told is case-sensitive, a tree
 * git cannot snapshot, a partial clone missing objects, a root spelled in another case, a path that is not UTF-8, a
 * listing VAT cannot read —
 * and reports it instead, with whose fault it is and the fix.
 *
 * @param options - The question
 * @param options.root - Absolute directory inside a git working tree
 * @param options.base - A ref naming the base (`main`, `origin/main`, `HEAD~3`, a sha)
 * @returns The merge-base commit compared with and the changes relative to `root`, or why there are none
 */
export function gitChangedFiles(options: { root: string; base: string }): GitChangedFilesResult {
  const { root, base } = options;
  const prefix = rootPrefix(root);
  if (!prefix.ok) return prefix;
  const unborn = unbornHeadRefusal(root);
  if (unborn !== undefined) return unborn;
  const resolved = resolveBase(root, base);
  if (!resolved.ok) return resolved;
  const shallow = askBoolean(root, ['rev-parse', '--is-shallow-repository']);
  if (!shallow.ok) return shallow;
  const merged = mergeBase(root, base, resolved.commit, shallow.value);
  if (!merged.ok) return merged;
  const cutOff = shallow.value ? shallowHistoryRefusal(root, { base: resolved.commit, mergeBase: merged.commit }) : undefined;
  if (cutOff !== undefined) return cutOff;
  const folds = rootFoldsCase(root);
  const unread = ignoreCaseRefusal(root, folds) ?? hiddenEditsRefusal(root) ?? unlistableDirectoryRefusal(root);
  if (unread !== undefined) return unread;
  const snapshot = snapshotTree(root);
  if (!snapshot.ok) return snapshot;
  const diff = diffRecords(root, merged.commit, snapshot.tree);
  if (!diff.ok) return diff;
  const spelling = caseSpellingRefusal(diff.records, prefix.prefix, folds);
  if (spelling !== undefined) return spelling;
  const outcome = changedFilesUnderPrefix(diff.records, prefix.prefix);
  return outcome.ok ? { ok: true, baseCommit: merged.commit, files: outcome.files } : outcome;
}
