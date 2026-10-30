/**
 * A pass bar between two timed arms.
 *
 * A bar holds only if it holds on the median AND on the min. The median is the
 * typical run and the min is the best the machine managed; when they disagree
 * the comparison says more about the machine than about VAT, so the verdict is
 * INCONCLUSIVE — re-run on a quiet machine — and an inconclusive bar never
 * counts as a pass. Ties pass under `≤` and fail under `<`.
 */

import type { PerfSummary } from './stats.js';

/** The two statistics a bar reads from each arm. */
export type BarSide = Pick<PerfSummary, 'medianMs' | 'minMs'>;

/** How the left arm must compare to the (scaled) right arm. */
export type BarRelation = '<=' | '<';

/** A bar's outcome, and which statistic held. */
export interface BarJudgement {
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
  readonly median: boolean;
  readonly min: boolean;
}

/**
 * Judge `left relation factor × right`, on the median and on the min.
 *
 * @param left - The arm the bar constrains
 * @param relation - `<=` (a tie passes) or `<` (a tie fails)
 * @param right - The arm it is compared with
 * @param factor - The tolerance on the right arm (`1.15` for "at most 15% slower")
 * @returns The verdict, and which statistic held
 * @throws {Error} when `factor` is not a positive finite number
 */
export function judgeBar(left: BarSide, relation: BarRelation, right: BarSide, factor = 1): BarJudgement {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`judgeBar: factor ${String(factor)} is not a positive finite number`);
  }
  const holds = (a: number, b: number): boolean => (relation === '<=' ? a <= b * factor : a < b * factor);
  const median = holds(left.medianMs, right.medianMs);
  const min = holds(left.minMs, right.minMs);
  let verdict: BarJudgement['verdict'] = 'inconclusive';
  if (median && min) verdict = 'pass';
  else if (!median && !min) verdict = 'fail';
  return { verdict, median, min };
}
