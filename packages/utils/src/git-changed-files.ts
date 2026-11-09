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
 * - A file marked assume-unchanged or skip-worktree is seen as git sees it: an edit to one is no row.
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
 * 🚨 Under `core.ignorecase` a path git lists can be spelled differently from the prefix git
 * reports (a case-only rename since the base, a root reached in another case or Unicode
 * normalisation), and a byte comparison would then drop it in silence. So every path on either side
 * of every row whose leading segments match the prefix as APFS compares names — Unicode case and
 * NFC/NFD alike — but not byte for byte refuses, naming both.
 */

import { readFileSync } from 'node:fs';

import { compareCodeUnits } from './compare-code-units.js';
import { isNoSuchEntryError, isOutputOverrunError, isPathAbsentError, isTimedOutError } from './errors/errno-table.js';
import { runGit, runGitBytes } from './git-run.js';
import { gitTreeSnapshot, unreadableSnapshotRefusal } from './git-snapshot.js';
import { safePath } from './path-utils.js';
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
 * Whose fault a refusal is: `base` — the ref passed (it names no commit, or has more than one
 * merge base with HEAD); `git-failed` — git did not run or did not finish (not on PATH, out of time,
 * more output than VAT reads, a snapshot that failed with no cause); `repository` — the tree cannot
 * answer (not a working tree, no commits, no merge base, a shallow history that cannot vouch for the
 * merge base, a damaged repository, a root in another case, a path that is not UTF-8).
 */
export type GitChangedFilesRefusalKind = 'base' | 'git-failed' | 'repository';

/** A condition the caller can fix, whose fault it is, and the fix. */
interface Refusal {
  readonly ok: false;
  readonly kind: GitChangedFilesRefusalKind;
  readonly reason: string;
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
  return segment.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD');
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
 * Under `core.ignorecase`, refuse when a path on either side of a row is spelled under the root in
 * another case: the byte filter would otherwise drop it, or re-kind its rename, in silence.
 *
 * @param records - The `--name-status` records, paths from the repository's top
 * @param prefix - The root's path from the repository's top: empty, or ending in `/`
 * @returns A refusal naming both spellings, or undefined when every path agrees
 */
export function caseSpellingRefusal(records: readonly GitNameStatusRecord[], prefix: Uint8Array): Refusal | undefined {
  if (prefix.length === 0) return undefined;
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
    remedy = 'Put git on PATH.';
  } else if (isTimedOutError(error)) {
    remedy = `${command} did not finish within its time limit; compare against a nearer base, so there is less to diff.`;
  } else if (isOutputOverrunError(error)) {
    remedy = `${command} wrote more output than VAT reads; compare against a nearer base, so there is less to list.`;
  }
  return { ok: false, kind: 'git-failed', reason: `${command} did not run to completion here (${error.message}). ${remedy}` };
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
 * @returns The commit, or a refusal for none or several (a criss-cross history)
 */
export function mergeBaseOf(base: string, listing: string): { ok: true; commit: string } | Refusal {
  const commits = listing.split('\n').filter((line) => line !== '');
  const [only] = commits;
  if (commits.length === 1 && only !== undefined) return { ok: true, commit: only };
  if (commits.length === 0) {
    return {
      ok: false,
      kind: 'repository',
      reason: `The base ${shownName(base)} shares no history with HEAD here, so there is no merge base to compare with.`
        + ' A shallow clone lacks it: fetch more history (git fetch --unshallow, or --deepen=<n>), or pass a commit'
        + ' HEAD descends from.',
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
function mergeBase(root: string, base: string, commit: string): { ok: true; commit: string } | Refusal {
  const result = ask(root, ['merge-base', '--all', commit, 'HEAD']);
  if ('kind' in result) return result;
  // `merge-base` exits 1, saying nothing, when there is none; anything else it says is a fault.
  if (!result.ok && result.stderr !== '') {
    return { ok: false, kind: 'repository', reason: `git merge-base failed.${gitSaid(result.stderr)}` };
  }
  return mergeBaseOf(base, result.ok ? result.stdout : '');
}

/**
 * The root's path from the repository's top, as bytes: empty at the top, else ending in `/`.
 *
 * @returns The prefix, or a refusal when the root is not inside a git working tree
 */
function rootPrefix(root: string): { ok: true; prefix: Uint8Array } | Refusal {
  const result = runGitBytes(['rev-parse', '--show-prefix'], { cwd: root });
  if (!result.ok) {
    return gitDidNotRun('rev-parse', result) ?? {
      ok: false,
      kind: 'repository',
      reason: `${shownName(root)} is not inside a git working tree, so there is no base to compare it with.${gitSaid(result.stderr)}`,
    };
  }
  const bytes = result.stdout;
  return { ok: true, prefix: bytes.at(-1) === NEWLINE ? bytes.subarray(0, -1) : bytes };
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
  // The snapshot reports no cause, so what it cannot tell apart is named, never classed as the tree's.
  return {
    ok: false,
    kind: 'git-failed',
    reason: 'git could not snapshot the working tree (`git add --all` into a throwaway index, then `write-tree`),'
      + ' so there is nothing to compare with the base. Either git did not finish within the snapshot\'s 30 s limit'
      + ' (a large or cold tree: run again once it is warm), or git refused the tree (a nested repository with no'
      + ' commit is one cause). Run `git add --all --dry-run` here to see git\'s own reason.',
  };
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
  return listing.ok ? parseNameStatusZ(listing.stdout) : listing;
}

/** The fix for a merge base a shallow history cannot vouch for. */
const DEEPEN_REMEDY = 'Fetch full history (actions/checkout fetch-depth: 0) or deepen until the merge base is reachable'
  + ' (git fetch --deepen=<n>).';

/**
 * In a shallow clone, refuse a merge base a cut-off history could be hiding a nearer one behind:
 * one of the commits between it and either tip is a shallow boundary, whose parents are not here.
 * The merge base itself on the boundary is fine — nothing lies behind it that could be nearer.
 *
 * @param commits - The base commit and the merge base
 * @returns A refusal naming the fix, or undefined when the history is whole (or not shallow at all)
 */
function shallowHistoryRefusal(root: string, commits: { base: string; mergeBase: string }): Refusal | undefined {
  const shallow = ask(root, ['rev-parse', '--is-shallow-repository']);
  if ('kind' in shallow) return shallow;
  if (shallow.stdout !== 'true') return undefined;
  const file = ask(root, ['rev-parse', '--git-path', 'shallow']);
  if ('kind' in file) return file;
  const boundary = readShallowBoundary(safePath.resolve(root, file.stdout));
  if (boundary === undefined) {
    return { ok: false, kind: 'repository', reason: `This shallow clone's boundary list cannot be read. ${DEEPEN_REMEDY}` };
  }
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

/** The commits a shallow clone's boundary file lists, or undefined when it cannot be read. */
function readShallowBoundary(file: string): Set<string> | undefined {
  try {
    const text = decodeUtf8Exactly(readFileSync(file));
    return text === undefined ? undefined : new Set(text.split('\n').filter((line) => line !== ''));
  } catch (error) {
    // Removed between the two questions: git unshallowed it, so nothing is a boundary.
    return isPathAbsentError(error) ? new Set() : undefined;
  }
}

/**
 * Every file this change touched under `root`: one snapshot of the working tree (untracked files
 * included) compared with the merge base of `base` and HEAD. See the module header for exactly
 * what is compared and how a path crossing the root's boundary is reported.
 *
 * Never throws for a condition the caller can fix — no repository, no commits, a ref that names no
 * commit, no single merge base, a shallow history that cannot vouch for it, a tree git cannot
 * snapshot, a root spelled in another case, a path that is not UTF-8, a listing VAT cannot read —
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
  const merged = mergeBase(root, base, resolved.commit);
  if (!merged.ok) return merged;
  const cutOff = shallowHistoryRefusal(root, { base: resolved.commit, mergeBase: merged.commit });
  if (cutOff !== undefined) return cutOff;
  const snapshot = snapshotTree(root);
  if (!snapshot.ok) return snapshot;
  const diff = diffRecords(root, merged.commit, snapshot.tree);
  if (!diff.ok) return diff;
  const foldsCase = runGit(['config', '--bool', 'core.ignorecase'], { cwd: root }).stdout === 'true';
  const spelling = foldsCase ? caseSpellingRefusal(diff.records, prefix.prefix) : undefined;
  if (spelling !== undefined) return spelling;
  const outcome = changedFilesUnderPrefix(diff.records, prefix.prefix);
  return outcome.ok ? { ok: true, baseCommit: merged.commit, files: outcome.files } : outcome;
}
