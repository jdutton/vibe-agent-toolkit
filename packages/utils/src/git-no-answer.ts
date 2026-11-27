/**
 * Why git gave no answer — the ONE classifier every site that meets git's silence goes through, so
 * none can blame the repository for a git that never ran, and each cause carries one code in every
 * lane (the crawl throws it; `gitChangedFiles` reports it as a fault kind).
 *
 * | Cause | Code | Whose |
 * |---|---|---|
 * | git missing from PATH | `GIT_NOT_FOUND` | the environment's |
 * | git out of time or output, a spawn that failed otherwise, a snapshot failure git states no cause for | `GIT_FAILED` | the environment's |
 * | not a git repository (or one git could not read, for a listing), or a directory that does not exist | `GIT_NO_ANSWER` | the tree's |
 * | a file in the repository the OS will not let git read | `GIT_SNAPSHOT_UNREADABLE` | the tree's |
 * | a snapshot git refuses, its `fatal:`/`error:` quoted | `GIT_SNAPSHOT_REFUSED` | the tree's |
 *
 * ⛔ The two sentences of {@link gitNoAnswerFor} are the only place their wording lives: an ESLint
 * `no-restricted-syntax` ban refuses them as literals anywhere else in product source.
 */

import { isNoSuchEntryError, isOutputOverrunError, isTimedOutError } from './errors/errno-table.js';
import { VatError } from './errors/vat-error.js';
import { gitIsMissing } from './git-run.js';
import { type GitSnapshotFailure, type GitTreeKeyFailure, unreadableSnapshotReason } from './git-snapshot.js';
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

/** A snapshot git refuses with a `fatal:` or `error:` it states: the tree's, git's words quoted. */
export const GIT_SNAPSHOT_REFUSED_CODE = 'GIT_SNAPSHOT_REFUSED';

/**
 * A snapshot git took but cannot key the tree with (`gitTreeKey`): a sparse index holds a directory
 * collapsed while a skip-worktree file in it is on disk, two of its paths are one file on disk, or an
 * LFS pointer's file is absent or no regular file, so the hash holds bytes the disk may not. The tree's.
 */
export const GIT_SNAPSHOT_INDEX_HIDES_CODE = 'GIT_SNAPSHOT_INDEX_HIDES';

/** The remedy for a git binary missing from PATH, as a sentence a refusal can carry. */
export const GIT_NOT_FOUND_REMEDY = 'git was not found on PATH: install it, or put it on PATH.';

/** Every cause's code — see the module header. */
export type GitNoAnswerCode =
  | typeof GIT_NOT_FOUND_CODE
  | typeof GIT_FAILED_CODE
  | typeof GIT_NO_ANSWER_CODE
  | typeof GIT_SNAPSHOT_UNREADABLE_CODE
  | typeof GIT_SNAPSHOT_REFUSED_CODE
  | typeof GIT_SNAPSHOT_INDEX_HIDES_CODE;

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
 * ⚠️ Node answers `ENOENT` both for a binary missing from PATH and for a spawn whose `cwd` does not
 * exist, so an `ENOENT` is `GIT_NOT_FOUND` only when {@link gitIsMissing} agrees; otherwise it is the
 * directory's, `GIT_NO_ANSWER`, and the reason names it.
 *
 * @param command - The git command that ran, as the reason names it (`git diff-tree`)
 * @param cwd - The directory it ran in, as the reason names it
 * @param attempt - What running it did
 * @returns The cause, or undefined when git ran to an exit status
 */
export function gitRunFailureOf(command: string, cwd: string, attempt: GitAttempt): GitNoAnswer | undefined {
  const { error } = attempt;
  if (error === undefined) return undefined;
  const ran = `${command} did not run to completion here (${error.message}).`;
  if (isNoSuchEntryError(error)) {
    if (gitIsMissing()) return { code: GIT_NOT_FOUND_CODE, reason: `${ran} ${GIT_NOT_FOUND_REMEDY}` };
    return {
      code: GIT_NO_ANSWER_CODE,
      reason: `git is on PATH, but ${command} could not run in ${shownName(cwd)}: that directory does not exist.`
        + ' Point VAT at a directory that exists.',
    };
  }
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

/** The config that turns a sparse checkout on. */
export const SPARSE_CHECKOUT_KEY = 'core.sparseCheckout';

/**
 * The cause git's own account of a failed snapshot states: what a real `git add --all` into a
 * throwaway index did ({@link GitSnapshotFailure.attempt}).
 *
 * - Seen not to run or not to finish: git's failure ({@link gitRunFailureOf}).
 * - A `fatal:` or `error:` git states (a nested repository with no commit, an object it cannot
 *   write, a clean filter that fails): deterministic, the tree's, quoted.
 * - Anything else — it succeeded, or failed stating no refusal: the cause is unknown, and the
 *   reason says so rather than guessing.
 *
 * @param root - The root the snapshot was taken of, as the reason names it
 * @param attempt - What the diagnostic `git add --all` did (C locale)
 * @returns The cause
 */
export function snapshotAttemptCause(root: string, attempt: GitAttempt): GitNoAnswer {
  const could = `git could not snapshot the working tree at ${shownName(root)} (${SNAPSHOT})`;
  const ran = gitRunFailureOf(SNAPSHOT_ATTEMPT, root, attempt);
  if (ran !== undefined) return { code: ran.code, reason: `${could}, and a second attempt failed: ${ran.reason}` };
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
 * A key git declined (`gitTreeKey`) is classified here too: its sparse index hides working-tree bytes
 * from the snapshot, two of its paths are one file on disk, or an LFS pointer's file is absent or no
 * regular file (`GIT_SNAPSHOT_INDEX_HIDES` all three); the OS would not let VAT look at an LFS file (`GIT_SNAPSHOT_UNREADABLE`); or git would not
 * answer what says whether.
 *
 * @param failure - What {@link gitTreeSnapshot} or `gitTreeKey` returned instead of a snapshot
 * @returns The cause, its reason one or more whole sentences
 */
export function gitSnapshotFailureOf(failure: GitSnapshotFailure | GitTreeKeyFailure): GitNoAnswer {
  if (failure.kind === 'index-hides') return indexHidesCause(failure);
  if (failure.kind === 'case-collision') return caseCollisionCause(failure);
  if (failure.kind === 'lfs-undecidable') return lfsUndecidableCause(failure);
  if (failure.kind === 'lfs-file-unread') return lfsFileUnreadCause(failure);
  if (failure.kind === 'flags-unlisted' || failure.kind === 'flags-unreadable') return flagsUnlistedCause(failure);
  if (failure.kind === 'lfs-unlisted' || failure.kind === 'lfs-unreadable') return lfsUnlistedCause(failure);
  const ran = gitRunFailureOf(SNAPSHOT_ATTEMPT, failure.cwd, failure.attempt);
  if (ran !== undefined) return snapshotAttemptCause(failure.cwd, failure.attempt);
  if (failure.repositoryRoot === null) return { code: GIT_NO_ANSWER_CODE, reason: `${notARepositoryReason(failure.cwd)}.` };
  const unreadable = unreadableSnapshotReason(failure.repositoryRoot);
  if (unreadable !== undefined) return { code: GIT_SNAPSHOT_UNREADABLE_CODE, reason: unreadable };
  return snapshotAttemptCause(failure.repositoryRoot, failure.attempt);
}

/** What a git command of the key's did, as {@link keyUnlistedCause} reads it. */
type KeyListing =
  | { readonly kind: 'unlisted'; readonly command: string; readonly attempt: GitAttempt }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * The cause of a key declined because a git command it asks gave no usable answer. A git that did
 * not run is git's (`GIT_NOT_FOUND`, a missing directory); every other cause is `GIT_FAILED`, with
 * the key's own remedy, never one written for another lane.
 *
 * @param repositoryRoot - The root the key was asked for
 * @param could - What VAT cannot tell, as the reason's opening clause (ends in a colon)
 * @param listing - What the command did
 * @returns The cause
 */
function keyUnlistedCause(repositoryRoot: string, could: string, listing: KeyListing): GitNoAnswer {
  const remedy = ' Run again; if it keeps failing, check that git runs here.';
  if (listing.kind === 'unreadable') return { code: GIT_FAILED_CODE, reason: `${could} ${listing.reason}${remedy}` };
  const { command, attempt } = listing;
  const ran = gitRunFailureOf(command, repositoryRoot, attempt);
  if (ran !== undefined && ran.code !== GIT_FAILED_CODE) return ran;
  const { error, stderr } = attempt;
  const gitSaid = stderr === '' ? '' : ` git said: ${stderr}`;
  const what = error === undefined
    ? `${command} failed.${gitSaid}`
    : `${command} did not run to completion (${error.message}).`;
  return { code: GIT_FAILED_CODE, reason: `${could} ${what}${remedy}` };
}

/**
 * The cause of a key declined because git gave no usable flag listing ({@link keyUnlistedCause}).
 *
 * @param failure - The declined key
 * @returns The cause
 */
function flagsUnlistedCause(failure: Extract<GitTreeKeyFailure, { kind: 'flags-unlisted' | 'flags-unreadable' }>): GitNoAnswer {
  const could = `VAT cannot tell whether git's index in ${shownName(failure.repositoryRoot)} hides any file from the snapshot:`;
  return keyUnlistedCause(
    failure.repositoryRoot,
    could,
    failure.kind === 'flags-unreadable'
      ? { kind: 'unreadable', reason: failure.reason }
      : { kind: 'unlisted', command: failure.command, attempt: failure.attempt },
  );
}

/**
 * The cause of a key declined because a git command of the LFS pass (`check-attr`, `cat-file`,
 * `config`) gave no usable answer ({@link keyUnlistedCause}).
 *
 * @param failure - The declined key
 * @returns The cause
 */
function lfsUnlistedCause(failure: Extract<GitTreeKeyFailure, { kind: 'lfs-unlisted' | 'lfs-unreadable' }>): GitNoAnswer {
  const could = `VAT cannot tell which files in ${shownName(failure.repositoryRoot)} are Git LFS pointers, or whether each is pulled:`;
  return keyUnlistedCause(
    failure.repositoryRoot,
    could,
    failure.kind === 'lfs-unreadable'
      ? { kind: 'unreadable', reason: failure.reason }
      : { kind: 'unlisted', command: failure.command, attempt: failure.attempt },
  );
}

/**
 * The cause of a key declined because an LFS pointer's file is absent or no regular file: the files
 * named, the cause, and the two commands that settle it.
 *
 * @param failure - The declined key
 * @returns The cause
 */
function lfsUndecidableCause(failure: Extract<GitTreeKeyFailure, { kind: 'lfs-undecidable' }>): GitNoAnswer {
  const more = failure.undecidableCount > failure.undecidable.length
    ? ` and ${failure.undecidableCount - failure.undecidable.length} more`
    : '';
  return {
    code: GIT_SNAPSHOT_INDEX_HIDES_CODE,
    reason: `${failure.undecidableCount} Git LFS file(s) in ${shownName(failure.repositoryRoot)} are absent or no regular`
      + ` file on disk: ${failure.undecidable.join(', ')}${more}. git's snapshot holds each one's pointer, so VAT cannot`
      + ' tell which bytes the disk holds and cannot key this tree. Run git update-index --refresh,'
      + ' or git lfs pull to fetch the content, and run again.',
  };
}

/**
 * The cause of a key declined because the OS would not let VAT `lstat` an LFS pointer's file, or
 * read one small enough to be a pointer: the file and the errno named.
 *
 * @param failure - The declined key
 * @returns The cause
 */
function lfsFileUnreadCause(failure: Extract<GitTreeKeyFailure, { kind: 'lfs-file-unread' }>): GitNoAnswer {
  const more = failure.unreadCount > 1 ? ` (and ${failure.unreadCount - 1} more)` : '';
  const what = failure.operation === 'lstat' ? 'look at' : 'read';
  return {
    code: GIT_SNAPSHOT_UNREADABLE_CODE,
    reason: `The OS would not let VAT ${what} the Git LFS file ${failure.path}${more} in ${shownName(failure.repositoryRoot)}`
      + ` (${failure.errno}), so VAT cannot tell whether it holds its content or its pointer and cannot key this tree.`
      + ' Make the file readable to VAT, and run again.',
  };
}

/**
 * The cause of a key declined because a sparse index hides edits from the snapshot: the first files
 * and the count, and the two ways to undo it.
 *
 * @param failure - The declined key
 * @returns The cause
 */
function indexHidesCause(failure: Extract<GitTreeKeyFailure, { kind: 'index-hides' }>): GitNoAnswer {
  const named = failure.hidden.map(({ shownPath, flag }) => `${shownPath} (${flag})`).join(', ');
  const more = failure.hiddenCount > failure.hidden.length ? ` and ${failure.hiddenCount - failure.hidden.length} more` : '';
  return {
    code: GIT_SNAPSHOT_INDEX_HIDES_CODE,
    reason: `git's index in ${shownName(failure.repositoryRoot)} is a sparse index holding directories collapsed, and`
      + ` ${failure.hiddenCount} file(s) flagged skip-worktree are on disk: ${named}${more}. A snapshot keeps a collapsed`
      + ' directory\'s staged bytes, so an edit to such a file is missing from it and this tree cannot be keyed.'
      + ' Let git clear the flag on files present on disk (git config --unset sparse.expectFilesOutsideOfPatterns)'
      + ' and run again.',
  };
}

/**
 * The cause of a key declined because two of the snapshot's paths are one file on disk.
 *
 * @param failure - The declined key
 * @returns The cause
 */
function caseCollisionCause(failure: Extract<GitTreeKeyFailure, { kind: 'case-collision' }>): GitNoAnswer {
  const [first, second] = failure.paths;
  return {
    code: GIT_SNAPSHOT_INDEX_HIDES_CODE,
    reason: `git's index in ${shownName(failure.repositoryRoot)} holds ${first} and ${second}, two paths this volume`
      + ' stores as one file (they differ only in case or Unicode normalisation). The snapshot holds staged bytes for'
      + ' each, and at most one of them is on disk, so this tree cannot be keyed. Remove one of them from the index'
      + ' (git rm --cached -- <path>) and run again.',
  };
}

/**
 * {@link gitSnapshotFailureOf} as the error to throw: coded by cause, its message the reason
 * followed by what the caller would otherwise have had to do with the failure.
 *
 * @param failure - What {@link gitTreeSnapshot} returned instead of a snapshot
 * @param consequence - One or more sentences: why the caller refuses rather than answers
 * @returns The coded error
 */
export function gitSnapshotError(failure: GitSnapshotFailure | GitTreeKeyFailure, consequence: string): VatError {
  const { code, reason } = gitSnapshotFailureOf(failure);
  return new VatError(code, `${reason} ${consequence}`);
}
