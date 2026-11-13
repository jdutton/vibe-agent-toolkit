/**
 * Comparing two `work` reports: exact counter deltas, warranted by each side's
 * `stable` flag.
 *
 * Counters are deterministic, so any non-zero delta in an exactly-compared one
 * is real — that is the facet's whole value, and why a side whose repeats
 * disagreed (or were never enough to disagree) withholds the verdict rather
 * than reporting one. A reported-only counter ({@link comparedExactly}) is
 * listed when it moves and never makes a command `changed`.
 *
 * A counter present on only one side is `added` or `removed`, and that IS a
 * change: the two builds count different things, which is how an older vat
 * missing a counter shows.
 *
 * The gates, the command pairing and the failure and cache-mode refusals are
 * the shared comparator's (`harness/facet-compare.ts`); this file owns only the
 * subtraction.
 */

import type { DecideComparisonOptions } from '../../envelope/coordinate.js';
import type { ReportEnvelope } from '../../envelope/envelope.js';
import { pairByKey, type Pairing } from '../../harness/diff.js';
import {
  bothSides,
  cacheModeCaveat,
  compareCommandRows,
  type CommandsCompared,
  type ComparisonRefusal,
  type CountDelta,
  countDelta,
  failureCaveat,
  type RowMovementKind,
  stabilityCaveat,
} from '../../harness/facet-compare.js';

import {
  comparedExactly,
  WORK_FACET,
  WorkBodySchema,
  type WorkCommandStats,
  type WorkCounterReading,
} from './types.js';

/** This facet's body contract, as the shared comparison gates need it. */
const WORK_CONTRACT = { facet: WORK_FACET, schema: WorkBodySchema } as const;

/** What happened to one counter between two reports. */
export interface WorkCounterMovement {
  readonly name: WorkCounterReading['name'];
  readonly kind: RowMovementKind;
  /** Exact; a missing side contributes zero. */
  readonly count: CountDelta;
  /** False for a reported-only counter: listed, never a finding. */
  readonly exact: boolean;
}

/** Every counter that moved for one command; a counter identical on both sides is absent. */
export interface WorkMovement {
  readonly counters: readonly WorkCounterMovement[];
}

/** What happened to one command between two reports (both sides present). */
export type WorkCommandVerdict =
  | { readonly kind: 'changed'; readonly movement: WorkMovement }
  | { readonly kind: 'unchanged'; readonly movement: WorkMovement }
  /** The counts moved, but a side's own repeats give no warrant for an exact delta. */
  | { readonly kind: 'unwarranted'; readonly reason: string; readonly movement: WorkMovement }
  /** One side has no measurement, or the two ran under different cache modes. */
  | { readonly kind: 'unmeasurable'; readonly reason: string };

/** A completed comparison. */
export type WorkComparisonResult = CommandsCompared<WorkCommandStats, WorkCommandVerdict>;

/** The outcome of comparing two work reports. */
export type WorkComparison = WorkComparisonResult | ComparisonRefusal;

/** Options for {@link compareWork}. */
export type CompareWorkOptions = DecideComparisonOptions;

/**
 * Describe one counter pairing, or `null` when it did not move.
 *
 * @param pair - The counter on each side
 * @param cache - The cache mode both sides ran under
 * @returns The movement, or `null`
 */
function counterMovement(pair: Pairing<WorkCounterReading>, cache: WorkCommandStats['cache']): WorkCounterMovement | null {
  const identity = pair.after ?? pair.before;
  if (identity === null) return null;
  const count = countDelta(pair.before?.count ?? 0, pair.after?.count ?? 0);
  let kind: RowMovementKind = 'changed';
  if (pair.before === null) kind = 'added';
  else if (pair.after === null) kind = 'removed';
  if (kind === 'changed' && count.delta === 0) return null;
  return { name: identity.name, kind, count, exact: comparedExactly(identity.name, cache) };
}

/**
 * Whether a movement is a finding: an exact counter moved, or a counter
 * appeared or vanished.
 *
 * @param movement - One command's movement
 * @returns True when the command changed
 */
function movedAtAll(movement: WorkMovement): boolean {
  return movement.counters.some((counter) => counter.exact || counter.kind !== 'changed');
}

/**
 * Why a row's own repeats give no warrant for an exact delta, or `null` when
 * they do. A load refusal comes first: it is why such a row's `stable` is null.
 *
 * @param row - One side's row
 * @param side - How to name it in the reason
 * @returns A clause for the reason, or `null`
 */
export function workStabilityCaveat(row: WorkCommandStats, side: string): string | null {
  if (row.loadRefusedRepeats > 0) {
    return (
      `the ${side} row refused a parse under machine load in ${String(row.loadRefusedRepeats)} of its ` +
      `${String(row.runs)} repeats, which moves the counters downstream of the parse`
    );
  }
  return stabilityCaveat(row, side);
}

/**
 * The verdict for one command present on both sides.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns The verdict
 */
function verdictFor(before: WorkCommandStats, after: WorkCommandStats): WorkCommandVerdict {
  const unmeasurable = bothSides(before, after, failureCaveat) ?? cacheModeCaveat(before, after);
  if (unmeasurable !== null) return { kind: 'unmeasurable', reason: unmeasurable };

  const movement: WorkMovement = {
    counters: pairByKey(before.counters, after.counters, (reading) => reading.name)
      .map((pair) => counterMovement(pair, before.cache))
      .filter((moved): moved is WorkCounterMovement => moved !== null),
  };
  const unwarranted = bothSides(before, after, workStabilityCaveat);
  if (unwarranted !== null) return { kind: 'unwarranted', reason: unwarranted, movement };
  return movedAtAll(movement) ? { kind: 'changed', movement } : { kind: 'unchanged', movement };
}

/**
 * Compare two `work` reports along one axis.
 *
 * @param before - The baseline report
 * @param after - The report compared against it
 * @param options - Axis options
 * @returns The comparison, or the first refusal
 */
export function compareWork(
  before: ReportEnvelope<unknown>,
  after: ReportEnvelope<unknown>,
  options: CompareWorkOptions = {},
): WorkComparison {
  return compareCommandRows<WorkCommandStats, WorkCommandVerdict>(before, after, WORK_CONTRACT, options, verdictFor);
}
