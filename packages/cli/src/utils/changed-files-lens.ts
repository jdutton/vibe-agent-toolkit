/**
 * The changed-files lens: `changed_files`, what differs under the root since the run's `--base`.
 *
 * 🚨 **It refuses rather than answering empty.** With no `--base`, a ref that names no commit, or
 * a root outside a git working tree there is no answer — and an empty `changed_files` would read
 * as "nothing changed", which turns every check over it into a gate that cannot fail. So the lens
 * hands back a refusal, the relation stays ABSENT from the run's database, and a statement naming
 * it is refused with the reason (for `vat resources check`, a `RESOURCE_CHECK_BROKEN` finding on
 * exactly the checks that read it).
 *
 * ⚠️ Nothing caches its rows: they are computed once per run, from git, against the commit the
 * base resolved to. A cache added later must key on that commit (`baseCommit`), never on the ref
 * the operator typed — `main` names a different commit after every fetch.
 */

import type { ChangedFileRow } from '@vibe-agent-toolkit/resources';
import { gitChangedFiles } from '@vibe-agent-toolkit/utils/git';

import type { LensEvaluation, LensRefusal } from './projection-lenses.js';

/** The refusal when no statement-running verb was handed a base. */
export const NO_BASE_REFUSAL = 'changed_files compares this tree with a base commit, and this run was given none.'
  + ' Pass --base <ref> (a branch, tag or commit, e.g. --base origin/main) to vat resources query,'
  + ' vat resources check or vat validate.';

/**
 * Evaluate the lens.
 *
 * @param root - Absolute project root
 * @param base - The ref the run was handed, or undefined when it was handed none
 * @returns The rows, or why there are none
 */
export function evaluateChangedFilesLens(root: string, base: string | undefined): LensEvaluation | LensRefusal {
  if (base === undefined) return { refused: NO_BASE_REFUSAL };
  const result = gitChangedFiles({ root, base });
  if (!result.ok) return { refused: `changed_files cannot be evaluated: ${result.reason}` };
  const changedFiles: ChangedFileRow[] = result.files.map(({ path, status, oldPath, similarity }) => ({
    path, status, oldPath, similarity,
  }));
  return { rows: { changedFiles }, population: null };
}
