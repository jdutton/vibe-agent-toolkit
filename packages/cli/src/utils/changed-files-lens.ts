/**
 * The changed-files lens: `changed_files`, what differs under the root since the run's `--base`.
 *
 * 🚨 **It refuses rather than answering empty** (no `--base`, a bad ref, no working tree): an
 * empty relation would read as "nothing changed" and make every check over it unable to fail.
 *
 * ⚠️ Uncached. A cache added later must key on the resolved commit (`baseCommit`), never the typed ref.
 */

import type { ChangedFileRow, LensRefusalCode } from '@vibe-agent-toolkit/resources';
import { gitChangedFiles, type GitChangedFilesRefusalKind } from '@vibe-agent-toolkit/utils/git';

import type { LensEvaluation, LensRefusal } from './projection-lenses.js';

/** The refusal when no statement-running verb was handed a base. */
export const NO_BASE_REFUSAL = 'changed_files compares this tree with a base commit, and this run was given none.'
  + ' Pass --base <ref> (a branch, tag or commit, e.g. --base origin/main) to vat resources query,'
  + ' vat resources check or vat validate.';

/** Only the `--base` passed is the invocation's fault; git and the repository are the environment's. */
export const REFUSAL_BY_KIND: Readonly<Record<GitChangedFilesRefusalKind, LensRefusalCode>> = {
  base: 'USAGE_INVALID',
  'git-failed': 'BACKEND_UNAVAILABLE',
  repository: 'INPUT_UNREADABLE',
};

/** Evaluate the lens: its rows, or why there are none. */
export function evaluateChangedFilesLens(root: string, base: string | undefined): LensEvaluation | LensRefusal {
  if (base === undefined) return { refused: NO_BASE_REFUSAL, refusal: 'USAGE_INVALID' };
  const result = gitChangedFiles({ root, base });
  if (!result.ok) {
    return { refused: `changed_files cannot be evaluated: ${result.reason}`, refusal: REFUSAL_BY_KIND[result.kind] };
  }
  const changedFiles: ChangedFileRow[] = result.files.map(({ path, status, oldPath, similarity }) => ({
    path, status, oldPath, similarity,
  }));
  return { rows: { changedFiles }, population: null };
}
