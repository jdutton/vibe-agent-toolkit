/**
 * Randomized DIFFERENTIAL test of `claude-context-rules.ts` against a
 * brute-force `node-ignore` reference — the WIDE sweep, seeds 46–545.
 *
 * Pure CPU, no I/O: it is in this tier only because its case count does not
 * fit the unit per-file budget, and the count is the point. Two seeded
 * mutations of the module under test (a root ∀ that ignores a later negation,
 * a negation judged against the OR of bases) were each caught by 5–7 seeds per
 * 1,000, and the first of them by none of the unit tier's 150. The 1,000 seeds
 * (46–1,045, continuing the unit tier's 1–45) are split across `-a` and `-b`
 * only so each file fits the tier's per-file budget. The engine and its
 * reference are in `../helpers/rules-differential.ts`. Re-run one failing seed
 * with `RULES_DIFFERENTIAL_SEED=<n>`.
 */

import { describe, expect, it } from 'vitest';

import { differentialFailures, sweepSeeds } from '../helpers/rules-differential.js';

describe('claude-context-rules agrees with a brute-force node-ignore reference (wide sweep)', () => {
  it('on every derived answer, across 500 seeded random trees and rules (seeds 46–545)', () => {
    const failures = differentialFailures(sweepSeeds(46, 500));
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
