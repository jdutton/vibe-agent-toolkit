/**
 * The stated bounds a SQL answer over the derived relations is published with.
 *
 * ## Why the SQL route states bounds at all
 *
 * `vat claude context` attaches `CLAUDE_CONTEXT_LIMITS` to every answer it
 * gives, on the rule spelled in that module: *a limit a reader has to go and
 * find is a limit that does not reach the person acting on the number.* The
 * same measurement is reachable as `claude_context_chains` /
 * `claude_context_loads` rows, and this route published none of them — so the
 * lane an adopter can make GATE their build was the lane with no caveats
 * attached, which is the wrong way round. VAT ships no context budget of its
 * own; the adopter's `resources.checks` statement is the budget, and this is
 * the list it is owed beside the number it thresholds.
 *
 * ## Keyed on the LENS, never on the statement's text
 *
 * The limits bound what the relations MEAN, so they ride exactly when a row
 * from them could be in the answer: the run evaluated the claude-context lens.
 * Reading the statement for a table name would be a second implementation of
 * lens selection, and the two would disagree the first time one of them missed
 * a spelling — the defect class this release already fixed once, by deleting
 * the refusal that re-scanned the SQL and letting SQLite answer instead.
 *
 * ⛔ They belong to the REPORT, once, never to a row or a finding. A per-row
 * copy is invisible to any assertion that checks presence rather than counting
 * occurrences, and it is the defect the context lane shipped once already.
 */

import {
  CLAUDE_CONTEXT_BOUNDS_STATEMENT,
  CLAUDE_CONTEXT_RELATION_LIMITS,
  type StatedLimit,
} from '@vibe-agent-toolkit/resources';

import { CLAUDE_CONTEXT_LENS } from './projection-lenses.js';

/** What a report carries when a lens with stated bounds was evaluated. */
interface RelationBounds {
  /** The prose frame the limits are read under, stated once. */
  readonly boundsStatement?: string;
  /** The signed, directional list — what the rows do NOT settle. */
  readonly limits?: readonly StatedLimit[];
}

/**
 * The bounds to publish beside an answer, given the lenses the run evaluated.
 *
 * Spread into the payload: a run that evaluated no bounded lens contributes no
 * keys at all, rather than an empty list a reader has to interpret. An empty
 * `limits: []` would read as "nothing bounds this answer", which is a stronger
 * claim than "this answer contains no row anything bounds".
 *
 * @param lensesEvaluated - The run's `lensesEvaluated`, as the provenance names them
 * @returns The bounds keys, or an empty object
 */
export function relationBoundsFor(lensesEvaluated: readonly string[]): RelationBounds {
  if (!lensesEvaluated.includes(CLAUDE_CONTEXT_LENS.name)) return {};
  return {
    boundsStatement: CLAUDE_CONTEXT_BOUNDS_STATEMENT,
    limits: CLAUDE_CONTEXT_RELATION_LIMITS,
  };
}
