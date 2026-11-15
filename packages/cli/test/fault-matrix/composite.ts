/**
 * Which refusal a matrix run is judged by — for provenance and for I8.
 *
 * A verb is judged by its top-level refusal. The one exception is a case that DECLARES itself
 * composite (`VerbCase.composite`): an orchestrator such as `vat build`. Its refusal is one of two
 * things, and the published report says which:
 *
 * - **its own refusal**, raised outside every phase (the config would not load, `--only` was refused):
 *   no phase failed, and the refusal was built from the thrown value like any verb's. Judged at the
 *   top level, with strict provenance.
 * - **the fold** over its phases' reports (`orchestratorReport`: `RUN_INCOMPLETE`, "The run did not
 *   finish: phase … stopped"): built from no thrown value at all. The value the refusal observer saw
 *   is the failed PHASE's, so that phase's refusal is what provenance and I8 judge. The fold must be
 *   exactly `RUN_INCOMPLETE` over exactly one failed phase; anything else is a problem, not a route.
 *
 * Never inferred from the report's shape alone: a verb not declared composite cannot take the phase route.
 *
 * Pure.
 */

import { NO_REPORT, type VerbOutcome } from './invariants.js';

/** The refusal (and its message) a run is judged by, and where it came from. */
export interface RefusalOfRecord {
  readonly refusal: string | undefined;
  readonly message: string | undefined;
  readonly via: string;
}

/** The fold's code: anything else at a composite's top level is not a fold over phases. */
const FOLD_CODE = 'RUN_INCOMPLETE';

/**
 * The refusal of record for `outcome`.
 *
 * @param composite - The case declares that its refusal is a fold over phase reports
 * @returns The record, or a `problem` naming why a composite's refusal is not a single-phase fold
 */
export function refusalOfRecord(outcome: VerbOutcome, composite: boolean): RefusalOfRecord | { problem: string } {
  const topLevel: RefusalOfRecord = { refusal: outcome.refusal, message: outcome.message, via: 'top level' };
  // No refusal, no report, or an escaped throw: nothing a phase decided (I1 reports the last two).
  const folded = composite && outcome.refusal !== undefined && outcome.refusal !== NO_REPORT && outcome.refusal !== 'INTERNAL_ERROR';
  if (!folded) return topLevel;
  const failed = outcome.phaseRefusals ?? [];
  // No phase failed: the orchestrator's own refusal, raised outside every phase.
  if (failed.length === 0) return topLevel;
  if (outcome.refusal !== FOLD_CODE) return { problem: `a composite verb refused ${outcome.refusal ?? ''} with a failed phase, not the fold (${FOLD_CODE})` };
  const [only] = failed;
  if (failed.length !== 1 || only === undefined) {
    const names = ` (${failed.map(({ name }) => name).join(', ')})`;
    return { problem: `a composite fold must name exactly one failed phase; it names ${failed.length} failed phases${names}` };
  }
  return { refusal: only.code, message: only.message, via: `phase '${only.name}'` };
}
