/**
 * What changed in a working tree since a base commit — the tree a projection holds (tracked files
 * as they stand on disk, plus untracked files git does not ignore), compared with that commit.
 *
 * ## What is compared, exactly
 *
 * - `git diff -M --name-status -z --no-relative <base> --` — the base commit against the WORKING
 *   TREE, staged or not. `-M` turns a delete-plus-add of similar content into one rename.
 * - `git ls-files -z --others --exclude-standard --full-name` — untracked, non-ignored files,
 *   each reported as added. ⚠️ git cannot pair one of these with a deletion as a rename: rename
 *   detection sees only paths the index knows, so `mv a b` without `git add` reads as `a` deleted
 *   and `b` added. That is git's answer, reported as git gives it.
 *
 * ## Paths are bytes until they are judged
 *
 * Both listings are read through {@link runGitBytes} and split on NUL, never decoded as a stream —
 * the rule for every path a repository supplies (see `runGitBytes`). A path under the root is decoded
 * EXACTLY (`decodeUtf8Exactly`); one that is not UTF-8 refuses the whole answer, naming its bytes,
 * rather than reporting a spelling the checkout does not write. A path outside the root is never
 * decoded, because it is never reported.
 *
 * ## The root may be a subdirectory of the repository
 *
 * Both listings name paths from the repository's top (`--no-relative` overrides a `diff.relative`
 * config; `--full-name` does the same for `ls-files`), and are then kept only under the root's
 * prefix and made relative to it. A rename or copy that crosses the root's boundary is reported as
 * what it is from INSIDE the root: renamed in from outside is `added`, renamed out is `deleted`,
 * copied in is `added`, and copied out is no change (the source stands as it was).
 */

import { compareCodeUnits } from './compare-code-units.js';
import { runGit, runGitBytes } from './git-run.js';
import { shownName } from './shown-text.js';
import { decodeUtf8Exactly } from './text-content.js';

/** What happened to one path between the base and the working tree. */
export type GitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';

/** One changed path, relative to the root, POSIX-spelled. */
export interface GitChangedFile {
  /** The path now — for a deletion, the path that was deleted. */
  readonly path: string;
  readonly status: GitChangeKind;
  /** Where a rename or copy came from; `null` for every other kind. */
  readonly oldPath: string | null;
  /** git's similarity score (0-100) for a rename or copy; `null` for every other kind. */
  readonly similarity: number | null;
}

/** One `--name-status -z` record, its paths still the bytes git wrote. */
interface GitNameStatusRecord {
  readonly status: GitChangeKind;
  readonly path: Uint8Array;
  readonly oldPath: Uint8Array | null;
  readonly similarity: number | null;
}

/** The changes, or why there is no answer. */
type GitChangedFilesOutcome =
  | { readonly ok: true; readonly files: readonly GitChangedFile[] }
  | { readonly ok: false; readonly reason: string };

/** {@link gitChangedFiles}'s answer: the changes and the commit they were measured from. */
export type GitChangedFilesResult =
  | { readonly ok: true; readonly baseCommit: string; readonly files: readonly GitChangedFile[] }
  | { readonly ok: false; readonly reason: string };

/** The one-letter statuses that carry a single path. `U` (unmerged) is a working-tree file that differs. */
const SINGLE_PATH_STATUS: ReadonlyMap<string, GitChangeKind> = new Map([
  ['A', 'added'],
  ['M', 'modified'],
  ['D', 'deleted'],
  ['T', 'type-changed'],
  ['U', 'modified'],
]);

/** The statuses that carry a score, a source and a destination. */
const TWO_PATH_STATUS: ReadonlyMap<string, GitChangeKind> = new Map([
  ['R', 'renamed'],
  ['C', 'copied'],
]);

/** A rename or copy status: its letter and a score of 1-3 digits. */
const SCORED_STATUS = /^([RC])(\d{1,3})$/;

/** The NUL byte that ends every `-z` field. */
const NUL = 0x00;

/** The newline `rev-parse --show-prefix` ends its answer with. */
const NEWLINE = 0x0a;

/**
 * Split a `-z` listing into its fields.
 *
 * @param bytes - The listing; every field ends in NUL
 * @returns The fields, as views of `bytes`
 * @throws Error When the listing does not end in NUL
 */
function nulFields(bytes: Uint8Array): Uint8Array[] {
  const fields: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    const end = bytes.indexOf(NUL, at);
    if (end === -1) throw malformed('the listing does not end in NUL');
    fields.push(bytes.subarray(at, end));
    at = end + 1;
  }
  return fields;
}

/** The error a listing git should never have written is thrown with. */
function malformed(what: string): Error {
  return new Error(`git diff --name-status -z wrote a listing VAT cannot read: ${what}.`);
}

/**
 * Read `git diff --name-status -z` output.
 *
 * @param bytes - The listing, byte for byte
 * @returns One record per changed path, in listing order
 * @throws Error When a status is unknown or a record is cut short — never guessed at
 */
export function parseNameStatusZ(bytes: Uint8Array): GitNameStatusRecord[] {
  const fields = nulFields(bytes);
  const records: GitNameStatusRecord[] = [];
  let at = 0;
  while (at < fields.length) {
    const status = fields[at] ?? new Uint8Array();
    // A status that is not UTF-8 is no status git writes: `''` matches nothing and is refused below.
    const letters = decodeUtf8Exactly(status) ?? '';
    const single = SINGLE_PATH_STATUS.get(letters);
    if (single !== undefined) {
      const path = fields[at + 1];
      if (path === undefined) throw malformed(`status ${shownName(status)} has no path`);
      records.push({ status: single, path, oldPath: null, similarity: null });
      at += 2;
      continue;
    }
    const scored = SCORED_STATUS.exec(letters);
    const kind = scored === null ? undefined : TWO_PATH_STATUS.get(scored[1] ?? '');
    if (scored === null || kind === undefined) throw malformed(`unknown status ${shownName(status)}`);
    const oldPath = fields[at + 1];
    const path = fields[at + 2];
    if (oldPath === undefined || path === undefined) throw malformed(`status ${shownName(status)} needs two paths`);
    records.push({ status: kind, path, oldPath, similarity: Number(scored[2]) });
    at += 3;
  }
  return records;
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
  // Renamed OUT of the root is a deletion there; copied out leaves the source as it was.
  if (oldIn && record.status === 'renamed') {
    return { status: 'deleted', path: record.oldPath, oldPath: null, similarity: null };
  }
  return undefined;
}

/** The text a path under the root names, relative to it — or undefined when it is not UTF-8. */
function relativeText(path: Uint8Array, prefix: Uint8Array): string | undefined {
  return decodeUtf8Exactly(path.subarray(prefix.length));
}

/**
 * Keep the changes under the root, relative to it, and add the untracked files.
 *
 * @param records - The `--name-status` records, paths from the repository's top
 * @param untracked - Untracked, non-ignored paths from the repository's top
 * @param prefix - The root's path from the repository's top: empty, or ending in `/`
 * @returns The changes sorted by path, or a refusal naming a path that is not UTF-8
 */
export function changedFilesUnderPrefix(
  records: readonly GitNameStatusRecord[],
  untracked: readonly Uint8Array[],
  prefix: Uint8Array,
): GitChangedFilesOutcome {
  const added = untracked.map((path): GitNameStatusRecord => ({ status: 'added', path, oldPath: null, similarity: null }));
  const files: GitChangedFile[] = [];
  for (const record of [...records, ...added]) {
    const seen = seenFromRoot(record, prefix);
    if (seen === undefined) continue;
    const path = relativeText(seen.path, prefix);
    const oldPath = seen.oldPath === null ? null : relativeText(seen.oldPath, prefix);
    if (path === undefined || oldPath === undefined) {
      const bytes = path === undefined ? seen.path : (seen.oldPath ?? seen.path);
      return {
        ok: false,
        reason: `The path ${shownName(bytes)} is not UTF-8, so VAT cannot name it; rename it in the repository.`,
      };
    }
    files.push({ path, status: seen.status, oldPath, similarity: seen.similarity });
  }
  files.sort((left, right) => compareCodeUnits(left.path, right.path) || compareCodeUnits(left.status, right.status));
  return { ok: true, files };
}

/** git's own words, for a refusal: what it said, or that it said nothing. */
function gitSaid(stderr: string): string {
  return stderr === '' ? '' : ` git said: ${stderr}`;
}

/**
 * Resolve a ref to the commit it names.
 *
 * @returns The full commit id, or a refusal naming the fix
 */
function resolveBase(root: string, base: string): { ok: true; commit: string } | { ok: false; reason: string } {
  // A leading `-` would be read as an option, never as a ref.
  if (base === '' || base.startsWith('-')) {
    return { ok: false, reason: `The base ${shownName(base)} is not a ref; pass a branch, tag or commit.` };
  }
  const result = runGit(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: root });
  if (!result.ok || result.stdout === '') {
    return {
      ok: false,
      reason: `The base ${shownName(base)} does not name a commit in this repository.`
        + ' Check the spelling, or fetch it first (a shallow CI clone often lacks it: git fetch origin <branch>).',
    };
  }
  return { ok: true, commit: result.stdout };
}

/**
 * Run one listing, or say why it could not be read.
 *
 * @returns Its stdout bytes, or a refusal
 */
function listing(root: string, args: readonly string[]): { ok: true; bytes: Buffer } | { ok: false; reason: string } {
  const result = runGitBytes(args, { cwd: root });
  if (!result.ok) return { ok: false, reason: `git ${args[0] ?? ''} failed.${gitSaid(result.stderr)}` };
  return { ok: true, bytes: result.stdout };
}

/**
 * The root's path from the repository's top, as bytes: empty at the top, else ending in `/`.
 *
 * @returns The prefix, or a refusal when the root is not inside a git working tree
 */
function rootPrefix(root: string): { ok: true; prefix: Uint8Array } | { ok: false; reason: string } {
  const result = runGitBytes(['rev-parse', '--show-prefix'], { cwd: root });
  if (!result.ok) {
    return {
      ok: false,
      reason: `${shownName(root)} is not inside a git working tree, so there is no base to compare it with.${gitSaid(result.stderr)}`,
    };
  }
  const bytes = result.stdout;
  return { ok: true, prefix: bytes.at(-1) === NEWLINE ? bytes.subarray(0, -1) : bytes };
}

/**
 * Every file that changed under `root` since `base`: tracked files as they stand on disk compared
 * with the base commit, plus untracked files git does not ignore (as added). See the module header
 * for exactly what is compared and how a path crossing the root's boundary is reported.
 *
 * Never throws for a condition the caller can fix — no repository, a ref that names no commit, a
 * path that is not UTF-8 — and reports it instead, with the fix.
 *
 * @param options - The question
 * @param options.root - Absolute directory inside a git working tree
 * @param options.base - A ref naming the base commit (`main`, `origin/main`, `HEAD~3`, a sha)
 * @returns The commit `base` resolved to and the changes relative to `root`, or why there are none
 * @throws Error When git writes a listing it should never write
 */
export function gitChangedFiles(options: { root: string; base: string }): GitChangedFilesResult {
  const { root, base } = options;
  const prefix = rootPrefix(root);
  if (!prefix.ok) return prefix;
  const resolved = resolveBase(root, base);
  if (!resolved.ok) return resolved;
  const diff = listing(root, ['diff', '-M', '--name-status', '-z', '--no-relative', resolved.commit, '--']);
  if (!diff.ok) return diff;
  const others = listing(root, ['ls-files', '-z', '--others', '--exclude-standard', '--full-name']);
  if (!others.ok) return others;
  const outcome = changedFilesUnderPrefix(parseNameStatusZ(diff.bytes), nulFields(others.bytes), prefix.prefix);
  return outcome.ok ? { ok: true, baseCommit: resolved.commit, files: outcome.files } : outcome;
}
