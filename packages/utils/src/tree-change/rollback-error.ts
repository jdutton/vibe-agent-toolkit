/**
 * The one shape of a change that failed and could not be fully undone. Pure: it only words
 * what the rollback found.
 */

import { VatError } from '../errors/vat-error.js';

/** A failed change that could not be fully undone: a previous entry not back at its destination, or a new one not off it. */
export const TREE_ROLLBACK_INCOMPLETE_CODE = 'TREE_ROLLBACK_INCOMPLETE';

/** One destination a rollback could not restore: where its previous entry is, if it had one, and why. */
export interface TreeRollbackStranded {
  readonly dest: string;
  readonly parked: string | undefined;
  readonly why: string;
}

function strandedSentence({ dest, parked, why }: TreeRollbackStranded): string {
  return parked === undefined ? `the new content at ${dest} could not be undone (${why})` : `the previous content of ${dest} is at ${parked} (${why})`;
}

/**
 * A change failed, and the rollback could not undo all of it: each previous entry
 * not back at its destination is under its parked name, never deleted; a create's
 * new entry — or a rewritten file's new content — may still be at its destination.
 * `cause` is the failure that started the rollback. The one shape of
 * {@link TREE_ROLLBACK_INCOMPLETE_CODE}: a caller that undoes writes of its own (a
 * registry edit run as `afterSwap`) throws it too, its entries with no `parked`.
 */
export class TreeRollbackIncompleteError extends VatError {
  /** Where each previous entry that is not at its destination now is. */
  readonly parked: readonly string[];
  /** Every destination the rollback could not restore. */
  readonly stranded: readonly TreeRollbackStranded[];

  constructor(original: unknown, stranded: readonly TreeRollbackStranded[]) {
    const where = stranded.map((s) => strandedSentence(s)).join('; ');
    super(TREE_ROLLBACK_INCOMPLETE_CODE, `${original instanceof Error ? original.message : String(original)}; and the change could not be undone: ${where}`, { cause: original });
    this.parked = stranded.flatMap((s) => (s.parked === undefined ? [] : [s.parked]));
    this.stranded = stranded;
  }
}
