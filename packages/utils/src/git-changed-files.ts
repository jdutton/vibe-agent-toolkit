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
 * - A file marked assume-unchanged or skip-worktree REFUSES the answer: git does not read it, so an
 *   edit to it, or its deletion, would be missing, and the refusal names every flag to clear. The
 *   one exemption is a skip-worktree file absent from disk in a sparse checkout
 *   (`core.sparseCheckout` true), absent by design rather than deleted.
 * - If the snapshot fails, one real `git add --all` into another throwaway index asks git why: a
 *   `fatal:` or `error:` it states is the repository's to fix; otherwise the cause is unknown, and
 *   the refusal says so (a time-out only when that second attempt was seen to time out).
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
 * Unicode normalisation), and a byte comparison would then drop it in silence. So every path on
 * either side of every row whose leading segments match the prefix as APFS compares names — Unicode
 * case and NFC/NFD alike — but not byte for byte refuses, naming both.
 *
 * Whether the filesystem folds is PROBED at the root (its path with one segment's case flipped,
 * compared by `dev`/`ino`), never read from `core.ignorecase`, a config that can disagree with the
 * disk. Where it folds, a `core.ignorecase` that is not true refuses, naming the fix, and the
 * spelling check runs whenever the root is a subdirectory. Where it does not, the check is skipped:
 * there `Docs/` beside a `docs/` root is another directory, and its changes are simply not the root's.
 */

import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, rmSync } from 'node:fs';

import { compareCodeUnits } from './compare-code-units.js';
import { fsFaultOf, isNoSuchEntryError, isOutputOverrunError, isPathAbsentError, isTimedOutError } from './errors/errno-table.js';
import { runGit, runGitBytes } from './git-run.js';
import { gitTreeSnapshot, unreadableSnapshotRefusal } from './git-snapshot.js';
import { isAbsoluteAnyPlatform, toForwardSlash } from './path-core.js';
import { normalizedTmpdir, normalizePath, safePath } from './path-utils.js';
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
 * told not to read, a folding filesystem whose `core.ignorecase` is not true, a tree git refuses to
 * snapshot, a damaged or partial clone, a root in another case, a path that is not UTF-8).
 */
export type GitChangedFilesRefusalKind = 'base' | 'git-failed' | 'repository';

/** A condition the caller can fix, whose fault it is, and the fix. */
interface Refusal {
  readonly ok: false;
  readonly kind: GitChangedFilesRefusalKind;
  readonly reason: string;
}

/** The refusal for a git that did not run, or did not answer, as a git that ran here would. */
function gitFailed(reason: string): Refusal {
  return { ok: false, kind: 'git-failed', reason };
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

/** The refusal for a listing git should never have written, naming the record. */
function malformed(what: string): Refusal {
  return { ok: false, kind: 'repository', reason: `${LISTING_COMMAND} wrote a listing VAT cannot read: ${what}.` };
}

/** One record read at `at`, and how many fields it took — or the refusal naming it. */
function readRecord(fields: readonly Uint8Array[], at: number): { record: GitNameStatusRecord; width: number } | Refusal {
  const status = fields[at] ?? new Uint8Array();
  // A status that is not UTF-8 is no status git writes: `''` matches nothing and is refused below.
  const letters = decodeUtf8Exactly(status) ?? '';
  const single = SINGLE_PATH_STATUS.get(letters);
  if (single !== undefined) {
    const path = fields[at + 1];
    if (path === undefined) return malformed(`status ${shownName(status)} has no path`);
    return { record: { status: single, path, oldPath: null, similarity: null }, width: 2 };
  }
  // A copy (`C`) or an unmerged path (`U`) lands here too: never asked for, so never guessed at.
  const score = RENAME_STATUS.exec(letters)?.[1];
  if (score === undefined) return malformed(`unknown status ${shownName(status)}`);
  const oldPath = fields[at + 1];
  const path = fields[at + 2];
  if (oldPath === undefined || path === undefined) return malformed(`status ${shownName(status)} needs two paths`);
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
  if (fields === undefined) return malformed('the listing does not end in NUL');
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
 * Refuse when a path on either side of a row is spelled under the root in another case or
 * normalisation: the byte filter would otherwise drop it, or re-kind its rename, in silence.
 *
 * @param records - The `--name-status` records, paths from the repository's top
 * @param prefix - The root's path from the repository's top: empty, or ending in `/`
 * @param folds - Whether the root's filesystem folds case ({@link rootFoldsCase}). Where it does
 *   not, a path in another case is another directory, simply not under the root
 * @returns A refusal naming both spellings, or undefined when every path agrees
 */
export function caseSpellingRefusal(records: readonly GitNameStatusRecord[], prefix: Uint8Array, folds: boolean): Refusal | undefined {
  if (!folds || prefix.length === 0) return undefined;
  const sides = records.flatMap((record) => (record.oldPath === null ? [record.path] : [record.oldPath, record.path]));
  const other = sides.map((path) => spellingInAnotherForm(path, prefix)).find((spelling) => spelling !== undefined);
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

/** One git invocation's outcome, as much of it as a refusal reads. */
interface Ran {
  readonly ok: boolean;
  readonly stderr: string;
  readonly error?: Error;
}

/**
 * The refusal for a git that did not run or did not finish — never the caller's ref or tree —
 * with the remedy for the way it failed.
 *
 * @param subcommand - The git subcommand that ran (`diff-tree`)
 * @param result - What running it did
 * @returns The refusal, or undefined when git ran to an exit status
 */
export function gitDidNotRun(subcommand: string, result: Ran): Refusal | undefined {
  const { error } = result;
  if (error === undefined) return undefined;
  const command = `git ${subcommand}`;
  let remedy = 'Check that git runs here.';
  if (isNoSuchEntryError(error)) {
    remedy = 'git was not found on PATH: install it, or put it on PATH.';
  } else if (isTimedOutError(error)) {
    remedy = `${command} did not finish within its time limit; compare against a nearer base, so there is less to diff.`;
  } else if (isOutputOverrunError(error)) {
    remedy = `${command} wrote more output than VAT reads; compare against a nearer base, so there is less to list.`;
  }
  return gitFailed(`${command} did not run to completion here (${error.message}). ${remedy}`);
}

/** Run one git command for its trimmed text answer, or the refusal for a git that did not finish. */
function ask(root: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } | Refusal {
  const result = runGit(args, { cwd: root });
  return gitDidNotRun(args[0] ?? '', result) ?? result;
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
  if (!result.ok) return gitDidNotRun('rev-parse', result) ?? notWorkTree(gitSaid(result.stderr));
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
 * Refuse a file under the root that git is told not to read: assume-unchanged (a lowercase
 * `ls-files -v` tag), skip-worktree (`S`), or both (`s`). The snapshot is git's own `add --all`,
 * which skips them, so an edit — or a deletion — of one is no row: a silent wrong answer. The one
 * flagged entry that holds nothing to miss is a sparse checkout's skip-worktree file, absent from
 * disk by design (`core.sparseCheckout` true).
 *
 * @returns A refusal naming the first such file and every flag to clear, or undefined
 */
function hiddenEditsRefusal(root: string): Refusal | undefined {
  const listed = bytesOf('ls-files', runGitBytes(['ls-files', '-v', '-z'], { cwd: root }));
  if (!listed.ok) return listed;
  let sparseAnswer: { ok: true; value: boolean } | Refusal | undefined;
  const sparse = (): { ok: true; value: boolean } | Refusal => (sparseAnswer ??= configIsTrue(root, 'core.sparseCheckout'));
  for (const entry of nulFields(listed.stdout) ?? []) {
    const flags = hiddenEditFlagsOf(String.fromCodePoint(entry[0] ?? 0));
    if (!flags.skipWorktree && !flags.assumeUnchanged) continue;
    const path = decodeUtf8Exactly(entry.subarray(2));
    const present = path === undefined || onDisk(safePath.join(root, path));
    // Absent and only skip-worktree: a sparse checkout's file, absent by design — else a deletion git hides.
    if (!present && !flags.assumeUnchanged) {
      const answer = sparse();
      if (!answer.ok) return answer;
      if (answer.value) continue;
    }
    return hiddenEditRefusal(shownName(path ?? entry.subarray(2)), flags);
  }
  return undefined;
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
 * @returns The tree's id, or a refusal saying why git could not take it
 */
function snapshotTree(root: string): { ok: true; tree: string } | Refusal {
  const snapshot = gitTreeSnapshot({ cwd: root });
  if (snapshot !== null) return { ok: true, tree: snapshot.hash };
  const unreadable = unreadableSnapshotRefusal(root);
  if (unreadable !== undefined) return { ok: false, kind: 'repository', reason: unreadable.message };
  return snapshotProbeRefusal(probeSnapshot(root));
}

/** The lines of git's stderr that state a refusal. */
const GIT_REFUSAL_LINE = /^(?:fatal|error): /;

/** What the snapshot is, as a refusal names it. */
const SNAPSHOT = '`git add --all` into a throwaway index, then `write-tree`';

/**
 * Ask git ONCE why the snapshot failed: a REAL `git add --all` into an index that does not exist yet
 * (so the real index is neither read nor locked). Real, not `--dry-run`: a dry run writes no object
 * and runs no clean filter, so it cannot meet the faults those raise.
 *
 * @returns What that second attempt did
 */
function probeSnapshot(root: string): Ran {
  const index = safePath.join(normalizedTmpdir(), `vat-snapshot-probe-${randomUUID()}.index`);
  try {
    return runGit(['add', '--all'], { cwd: root, env: { GIT_INDEX_FILE: index } });
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * Classify a failed snapshot by what its diagnostic second attempt did. A refusal git states
 * (`fatal:` or `error:` — a nested repository with no commit, an object it cannot write, a clean
 * filter that fails) is deterministic and the tree's to fix. A second attempt seen to time out or
 * not run is git's failure, named as such. Anything else — it succeeded, or failed stating no
 * refusal — leaves the first failure's cause unknown, and says so rather than guessing.
 *
 * @param probe - What the diagnostic `git add --all` did
 * @returns The refusal
 */
export function snapshotProbeRefusal(probe: Ran): Refusal {
  if (probe.error !== undefined && isTimedOutError(probe.error)) {
    return gitFailed(
      `git could not snapshot the working tree (${SNAPSHOT}), and a second \`git add --all\` here did not finish within`
        + ' its time limit either: the tree is large or cold. Run again once it is warm.',
    );
  }
  const didNotRun = gitDidNotRun('add --all', probe);
  if (didNotRun !== undefined) {
    return gitFailed(`git could not snapshot the working tree (${SNAPSHOT}), so there is nothing to compare with the base. ${didNotRun.reason}`);
  }
  const said = probe.ok ? [] : probe.stderr.split('\n').filter((line) => GIT_REFUSAL_LINE.test(line));
  if (said.length > 0) {
    return {
      ok: false,
      kind: 'repository',
      reason: `git refused to snapshot the working tree, so there is nothing to compare with the base. git said: ${said.join(' ')}`
        + ' Fix what git names (a nested repository with no commit: commit in it, or remove it), then run again.',
    };
  }
  return gitFailed(
    `git could not snapshot the working tree (${SNAPSHOT}), so there is nothing to compare with the base, and the`
      + ` cause is unknown: a second \`git add --all\` here ${probe.ok ? 'succeeded' : 'failed stating no refusal'}.`
      + ` Run again; if it keeps failing, run git add --all in a copy of the repository to see what git says.${gitSaid(probe.stderr)}`,
  );
}

/**
 * One history-sized git command's bytes — the diff, or a walk of the commits — or the
 * refusal for a git that did not finish or did not succeed. The argv goes to `runGitBytes` at the call site.
 *
 * @returns git's output, or a refusal
 */
function bytesOf(subcommand: string, result: ReturnType<typeof runGitBytes>): { ok: true; stdout: Uint8Array } | Refusal {
  if (result.ok) return { ok: true, stdout: result.stdout };
  return gitDidNotRun(subcommand, result) ?? { ok: false, kind: 'repository', reason: `git ${subcommand} failed.${gitSaid(result.stderr)}` };
}

/**
 * The one diff: the merge base against the snapshot, every path from the repository's top.
 *
 * @returns The records, or a refusal
 */
function diffRecords(root: string, from: string, to: string): { ok: true; records: GitNameStatusRecord[] } | Refusal {
  const listing = bytesOf('diff-tree', runGitBytes(['diff-tree', '-r', '-M', '-l0', '--name-status', '-z', from, to], { cwd: root }));
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
function isPartialClone(root: string): boolean {
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
  const between = bytesOf('rev-list', runGitBytes(['rev-list', 'HEAD', commits.base, '--not', commits.mergeBase], { cwd: root }));
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
 * to read, a folding filesystem git is told is case-sensitive, a tree git cannot snapshot, a
 * partial clone missing objects, a root spelled in another case, a path that is not UTF-8, a
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
  const unread = ignoreCaseRefusal(root, folds) ?? hiddenEditsRefusal(root);
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
