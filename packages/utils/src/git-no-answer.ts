/**
 * Why git gave no answer for a root — the ONE classifier every site that meets that silence goes
 * through, so none can blame the repository for a git that never ran.
 *
 * A null snapshot, a null listing, an unusable tracker: each is git's silence, and it has two causes
 * with two repairs. A git binary missing from PATH is the environment's (install git); anything
 * else is the tree's (not a repository, or one git could not read). They carry different codes, so
 * a CLI maps them to different refusals without reading the prose.
 *
 * ⛔ The two sentences below are the only place their wording lives: an ESLint
 * `no-restricted-syntax` ban refuses them as literals anywhere else in product source.
 */

import { VatError } from './errors/vat-error.js';
import { gitIsMissing } from './git-run.js';

/** git's silence was a git binary missing from PATH: the environment's, repaired by installing git. */
export const GIT_NOT_FOUND_CODE = 'GIT_NOT_FOUND';

/** git ran and gave no answer for the root: not a git repository, or one git could not read. */
export const GIT_NO_ANSWER_CODE = 'GIT_NO_ANSWER';

/** The remedy for a git binary missing from PATH, as a sentence a refusal can carry. */
export const GIT_NOT_FOUND_REMEDY = 'git was not found on PATH: install it, or put it on PATH.';

/** Which of the two causes git's silence was, and the reason naming the root (no trailing period). */
export interface GitNoAnswer {
  readonly code: typeof GIT_NOT_FOUND_CODE | typeof GIT_NO_ANSWER_CODE;
  readonly reason: string;
}

/**
 * Classify git's silence for `root`. Call it only after git gave no answer: it spawns
 * `git --version` to tell a missing binary from everything else.
 *
 * @param root - The root git was asked about, as the reason should name it
 * @returns The cause's code and a reason naming `root`
 */
export function gitNoAnswerFor(root: string): GitNoAnswer {
  return gitIsMissing()
    ? {
      code: GIT_NOT_FOUND_CODE,
      reason: `git was not found on PATH (install it, or put it on PATH), so "${root}" cannot be read as a git repository`,
    }
    : {
      code: GIT_NO_ANSWER_CODE,
      reason: `git did not answer for "${root}" — it is not a git repository, or git could not read it`,
    };
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
