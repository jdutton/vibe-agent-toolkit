/**
 * Why git gave no answer — the ONE classifier every site that meets git's silence goes through, so
 * none can blame the repository for a git that never ran, and each cause carries one code in every
 * lane (the crawl throws it; `gitChangedFiles` reports it as a fault kind).
 *
 * | Cause | Code | Whose |
 * |---|---|---|
 * | git missing from PATH | `GIT_NOT_FOUND` | the environment's |
 * | git out of time or output, a spawn that failed otherwise, a snapshot failure git states no cause for | `GIT_FAILED` | the environment's |
 * | not a git repository (or one git could not read, for a listing) | `GIT_NO_ANSWER` | the tree's |
 * | a file in the repository the OS will not let git read | `GIT_SNAPSHOT_UNREADABLE` | the tree's |
 * | an untracked path outside a sparse checkout's definition | `GIT_SNAPSHOT_OUTSIDE_SPARSE` | the tree's |
 * | a snapshot git refuses, its `fatal:`/`error:` quoted | `GIT_SNAPSHOT_REFUSED` | the tree's |
 *
 * ⛔ The two sentences of {@link gitNoAnswerFor} are the only place their wording lives: an ESLint
 * `no-restricted-syntax` ban refuses them as literals anywhere else in product source.
 */

import { isNoSuchEntryError, isOutputOverrunError, isTimedOutError } from './errors/errno-table.js';
import { VatError } from './errors/vat-error.js';
import { gitIsMissing, runGit } from './git-run.js';
import { type GitSnapshotFailure, unreadableSnapshotReason } from './git-snapshot.js';
import { shownName } from './shown-text.js';

/** git's silence was a git binary missing from PATH: the environment's, repaired by installing git. */
export const GIT_NOT_FOUND_CODE = 'GIT_NOT_FOUND';

/** git ran and gave no answer for the root: not a git repository, or one git could not read. */
export const GIT_NO_ANSWER_CODE = 'GIT_NO_ANSWER';

/**
 * git did not run to completion (out of time, more output than VAT reads, a spawn that failed for
 * another reason), or a snapshot failed for a cause git does not state: the environment's.
 */
export const GIT_FAILED_CODE = 'GIT_FAILED';

/**
 * The `VatError` code of a snapshot git refused because a file in the repository is one the OS
 * will not let it read — the INPUT's refusal, never a defect in VAT and never "not a git repository".
 */
export const GIT_SNAPSHOT_UNREADABLE_CODE = 'GIT_SNAPSHOT_UNREADABLE';

/** A snapshot git will not take because an untracked path lies outside a sparse checkout's definition: the tree's. */
export const GIT_SNAPSHOT_OUTSIDE_SPARSE_CODE = 'GIT_SNAPSHOT_OUTSIDE_SPARSE';

/** A snapshot git refuses with a `fatal:` or `error:` it states: the tree's, git's words quoted. */
export const GIT_SNAPSHOT_REFUSED_CODE = 'GIT_SNAPSHOT_REFUSED';

/** The remedy for a git binary missing from PATH, as a sentence a refusal can carry. */
export const GIT_NOT_FOUND_REMEDY = 'git was not found on PATH: install it, or put it on PATH.';

/** Every cause's code — see the module header. */
export type GitNoAnswerCode =
  | typeof GIT_NOT_FOUND_CODE
  | typeof GIT_FAILED_CODE
  | typeof GIT_NO_ANSWER_CODE
  | typeof GIT_SNAPSHOT_UNREADABLE_CODE
  | typeof GIT_SNAPSHOT_OUTSIDE_SPARSE_CODE
  | typeof GIT_SNAPSHOT_REFUSED_CODE;

/** Which cause git's silence was, and the reason naming it. */
export interface GitNoAnswer {
  readonly code: GitNoAnswerCode;
  readonly reason: string;
}

/** The reason for a root git did not answer for, git being on PATH (no trailing period). */
function notARepositoryReason(root: string): string {
  return `git did not answer for "${root}" — it is not a git repository, or git could not read it`;
}

/**
 * Classify git's silence for `root`. Call it only after git gave no answer: it spawns
 * `git --version` to tell a missing binary from everything else.
 *
 * @param root - The root git was asked about, as the reason should name it
 * @returns The cause's code and a reason naming `root` (no trailing period)
 */
export function gitNoAnswerFor(root: string): GitNoAnswer {
  return gitIsMissing()
    ? {
      code: GIT_NOT_FOUND_CODE,
      reason: `git was not found on PATH (install it, or put it on PATH), so "${root}" cannot be read as a git repository`,
    }
    : { code: GIT_NO_ANSWER_CODE, reason: notARepositoryReason(root) };
}

/**
 * {@link gitNoAnswerFor} as the error to throw: coded by cause, its message the reason followed by
 * what the caller would otherwise have had to do with the silence.
 *
 * @param root - The root git was asked about
 * @param consequence - One or more sentences: why the caller refuses rather than answers
 * @returns The coded error
 */
export function gitNoAnswerError(root: string, consequence: string): VatError {
  const { code, reason } = gitNoAnswerFor(root);
  return new VatError(code, `${reason}. ${consequence}`);
}

/** One git invocation's outcome, as much of it as a classification reads. */
export interface GitAttempt {
  readonly ok: boolean;
  readonly stderr: string;
  readonly error?: Error;
}

/**
 * Why one git command did not run to completion — never the caller's ref or tree.
 *
 * @param command - The git command that ran, as the reason names it (`git diff-tree`)
 * @param attempt - What running it did
 * @returns The cause, or undefined when git ran to an exit status
 */
export function gitRunFailureOf(command: string, attempt: GitAttempt): GitNoAnswer | undefined {
  const { error } = attempt;
  if (error === undefined) return undefined;
  const ran = `${command} did not run to completion here (${error.message}).`;
  if (isNoSuchEntryError(error)) return { code: GIT_NOT_FOUND_CODE, reason: `${ran} ${GIT_NOT_FOUND_REMEDY}` };
  let remedy = 'Check that git runs here.';
  if (isTimedOutError(error)) {
    remedy = `${command} did not finish within its time limit; ask it for less (for changed_files, a nearer base), or run again once the tree is warm.`;
  } else if (isOutputOverrunError(error)) {
    remedy = `${command} wrote more output than VAT reads; ask it for less (for changed_files, a nearer base).`;
  }
  return { code: GIT_FAILED_CODE, reason: `${ran} ${remedy}` };
}

/** What the snapshot is, as a reason names it. */
const SNAPSHOT = '`git add --all` into a throwaway index, then `write-tree`';

/** The command a snapshot failure's own account comes from. */
const SNAPSHOT_ATTEMPT = 'git add --all';

/** The lines of git's stderr that state a refusal. */
const GIT_REFUSAL_LINE = /^(?:fatal|error): /;

/** git's words, in the C locale, for an untracked path `add --all` will not take: it is outside the sparse definition. */
const OUTSIDE_SPARSE_DEFINITION = 'outside of your sparse-checkout definition';

/** The line ending git's header before it lists those paths, one per line, up to its `hint:` lines. */
const OUTSIDE_SPARSE_LIST_HEADER = 'updated in the index:';

/** The config that turns a sparse checkout on. */
export const SPARSE_CHECKOUT_KEY = 'core.sparseCheckout';

/**
 * The paths git lists after its sparse-definition header, or none when it wrote no header: a
 * listing VAT cannot find is never guessed at, so git's own sentence is never named as a path.
 */
function outsideSparsePaths(stderr: string): string[] {
  const lines = stderr.split('\n');
  const header = lines.findIndex((line) => line.trim() === OUTSIDE_SPARSE_LIST_HEADER);
  if (header === -1) return [];
  const listed = lines.slice(header + 1);
  const end = listed.findIndex((line) => line === '' || line.startsWith('hint:'));
  return end === -1 ? listed : listed.slice(0, end);
}

/**
 * The cause git's own account of a failed snapshot states: what a real `git add --all` into a
 * throwaway index did ({@link GitSnapshotFailure.attempt}).
 *
 * - Seen not to run or not to finish: git's failure ({@link gitRunFailureOf}).
 * - An untracked path outside a sparse checkout's definition: the tree's, though git states it with
 *   no `fatal:` — read only where `core.sparseCheckout` is true, never from git's text alone.
 * - A `fatal:` or `error:` git states (a nested repository with no commit, an object it cannot
 *   write, a clean filter that fails): deterministic, the tree's, quoted.
 * - Anything else — it succeeded, or failed stating no refusal: the cause is unknown, and the
 *   reason says so rather than guessing.
 *
 * @param root - The root the snapshot was taken of, as the reason names it
 * @param attempt - What the diagnostic `git add --all` did (C locale)
 * @param sparseCheckout - Whether `core.sparseCheckout` is true there
 * @returns The cause
 */
export function snapshotAttemptCause(root: string, attempt: GitAttempt, sparseCheckout: boolean): GitNoAnswer {
  const could = `git could not snapshot the working tree at ${shownName(root)} (${SNAPSHOT})`;
  const ran = gitRunFailureOf(SNAPSHOT_ATTEMPT, attempt);
  if (ran !== undefined) return { code: ran.code, reason: `${could}, and a second attempt failed: ${ran.reason}` };
  if (!attempt.ok && sparseCheckout && attempt.stderr.includes(OUTSIDE_SPARSE_DEFINITION)) {
    const paths = outsideSparsePaths(attempt.stderr);
    const named = paths.length === 0 ? 'An untracked path' : paths.map((path) => shownName(path)).join(', ');
    return {
      code: GIT_SNAPSHOT_OUTSIDE_SPARSE_CODE,
      reason: `${named} lies outside this sparse checkout's sparse-checkout definition, so git will not snapshot it.`
        + ' Add the path to the sparse definition (git sparse-checkout add <path>), remove the path, or ignore it'
        + ' (.gitignore), then run again.',
    };
  }
  const said = attempt.ok ? [] : attempt.stderr.split('\n').filter((line) => GIT_REFUSAL_LINE.test(line));
  if (said.length > 0) {
    return {
      code: GIT_SNAPSHOT_REFUSED_CODE,
      reason: `git refused to snapshot the working tree at ${shownName(root)}. git said: ${said.join(' ')}`
        + ' Fix what git names (a nested repository with no commit: commit in it, or remove it), then run again.',
    };
  }
  const gitSaid = attempt.stderr === '' ? '' : ` git said: ${attempt.stderr}`;
  return {
    code: GIT_FAILED_CODE,
    reason: `${could}, and the cause is unknown: a second \`git add --all\` here`
      + ` ${attempt.ok ? 'succeeded' : 'failed stating no refusal'}. Run again; if it keeps failing, run git add --all`
      + ` in a copy of the repository to see what git says.${gitSaid}`,
  };
}

/**
 * Why a snapshot failed — the one classifier for {@link GitSnapshotFailure}, used by the crawl and
 * by `gitChangedFiles` alike. A git that did not run is git's; a root in no repository is
 * `GIT_NO_ANSWER`; a file the OS will not let git read is named; everything else is what git's own
 * account states ({@link snapshotAttemptCause}).
 *
 * @param failure - What {@link gitTreeSnapshot} returned instead of a snapshot
 * @returns The cause, its reason one or more whole sentences
 */
export function gitSnapshotFailureOf(failure: GitSnapshotFailure): GitNoAnswer {
  const ran = gitRunFailureOf(SNAPSHOT_ATTEMPT, failure.attempt);
  if (ran !== undefined) return snapshotAttemptCause(failure.cwd, failure.attempt, false);
  if (failure.repositoryRoot === null) return { code: GIT_NO_ANSWER_CODE, reason: `${notARepositoryReason(failure.cwd)}.` };
  const unreadable = unreadableSnapshotReason(failure.repositoryRoot);
  if (unreadable !== undefined) return { code: GIT_SNAPSHOT_UNREADABLE_CODE, reason: unreadable };
  const sparse = runGit(['config', '--type=bool', '--get', SPARSE_CHECKOUT_KEY], { cwd: failure.repositoryRoot });
  const sparseRan = gitRunFailureOf('git config', sparse);
  if (sparseRan !== undefined) return sparseRan;
  return snapshotAttemptCause(failure.repositoryRoot, failure.attempt, sparse.ok && sparse.stdout === 'true');
}

/**
 * {@link gitSnapshotFailureOf} as the error to throw: coded by cause, its message the reason
 * followed by what the caller would otherwise have had to do with the failure.
 *
 * @param failure - What {@link gitTreeSnapshot} returned instead of a snapshot
 * @param consequence - One or more sentences: why the caller refuses rather than answers
 * @returns The coded error
 */
export function gitSnapshotError(failure: GitSnapshotFailure, consequence: string): VatError {
  const { code, reason } = gitSnapshotFailureOf(failure);
  return new VatError(code, `${reason} ${consequence}`);
}
