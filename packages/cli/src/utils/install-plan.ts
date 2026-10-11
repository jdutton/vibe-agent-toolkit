/**
 * What the flat-skill install verbs — `vat claude plugin install` (its skill lanes), `vat agent install` and
 * `vat skills install` — share about planning an install onto the tree-change primitive: the
 * one change a skill copy is, the one refusal an occupied destination is, and the one way an
 * archive's `$TMPDIR` staging is disposed of.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { type FsSide, isVatError, type Ownership, TREE_DEST_OCCUPIED_CODE, type TreeChange, withTempDir } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError, errorMessageOf } from './command-refusal.js';
import { leftoverIssue } from './document-writer.js';

/** The ownership of a skill destination: `--force` takes whatever is there; otherwise it must be free. */
export function skillOwnership(force: boolean): Ownership {
  return force ? { kind: 'force' } : { kind: 'must-be-free' };
}

/**
 * One skill copied whole into place: its links kept as links (an installed skill is the bundle
 * as built), every read of `source` classified on `side` — the operator's tree (`source`) or
 * VAT's own staging an archive was extracted into (`environment`).
 */
export function skillCopyChange(skill: { readonly name: string; readonly source: string; readonly dest: string }, side: FsSide, force: boolean): TreeChange {
  return {
    op: 'replace',
    dest: skill.dest,
    ownership: skillOwnership(force),
    fill: { from: 'copy', source: skill.source, side, links: 'preserve' },
    label: `skill ${skill.name}`,
  };
}

/** A destination taken without `--force`, as the invocation's refusal saying how to proceed; anything else as itself. */
export function occupiedRefusal(error: unknown): unknown {
  if (!isVatError(error, TREE_DEST_OCCUPIED_CODE)) return error;
  return new CommandRefusalError('USAGE_INVALID', `Something already exists where the install goes: ${error.message}. Use --force to overwrite.`, { cause: error });
}

/**
 * Run `work` in a fresh staging directory under `$TMPDIR` (`withTempDir`), disposed of after. A
 * directory that will not go once `work` finished is not a refusal of the install it outlived:
 * it is handed to `onLeftover` as the warning naming it. A failure of `work` is rethrown, the
 * staging's own leftover recorded beside it (`suppressedFaultsOf`).
 *
 * @param prefix - The `mkdtemp` prefix, so a leaked directory names its owner
 * @param work - Given the staging directory
 * @param onLeftover - Given the warning for a staging directory that outlived a finished `work`
 */
export async function inStaging(prefix: string, work: (dir: string) => Promise<void>, onLeftover: (issue: ValidationIssue) => void): Promise<void> {
  const { value: stagedIn, leftover } = await withTempDir(prefix, async (dir) => {
    await work(dir);
    return dir;
  });
  if (leftover === undefined) return;
  onLeftover(leftoverIssue(`The install is complete, but its staging directory ${stagedIn} could not be removed: ${errorMessageOf(leftover)}`, stagedIn));
}
