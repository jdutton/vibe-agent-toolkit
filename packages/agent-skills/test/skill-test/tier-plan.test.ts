/**
 * Unit tests for the pure tier-plan module (issue #145 Phase G): tier grouping,
 * the fail-fast gate policy, and the skipped-tier summary. No I/O — these are the
 * deterministic decision functions the run-harness tier loop composes.
 */

import { describe, expect, it } from 'vitest';

import type { EvalFragment } from '../../src/skill-test/eval-fragment.js';
import type { EvalEntry } from '../../src/skill-test/eval-inputs.js';
import {
  buildSkippedSummary,
  fragmentPassed,
  formatSkippedTiersSummary,
  groupEvalsByTier,
  shouldGateAfterTier,
  type TierGroup,
} from '../../src/skill-test/tier-plan.js';

/** Build a minimal EvalEntry with the given id and optional tier. */
function entry(id: string, tier?: number): EvalEntry {
  return { id, prompt: 'p', expectations: ['e'], ...(tier === undefined ? {} : { tier }) } as EvalEntry;
}

/** Build a WITH-arm fragment whose output/tool pass flags are configurable. */
function fragment(evalId: string, over: { outputPassed?: boolean; toolPassed?: boolean } = {}): EvalFragment {
  const outputPassed = over.outputPassed ?? true;
  return {
    runNonce: 'n',
    evalId,
    expectations: [{ text: 'e', passed: outputPassed }],
    ...(over.toolPassed === undefined
      ? {}
      : { tool: { mustRun: [{ name: 'dxa', ran: over.toolPassed }], passed: over.toolPassed } }),
  };
}

describe('groupEvalsByTier', () => {
  it('defaults an eval without a tier to tier 0', () => {
    const groups = groupEvalsByTier([entry('a'), entry('b')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ tier: 0 });
    expect(groups[0]?.evals.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('groups mixed tiers and returns them in ASCENDING order', () => {
    const groups = groupEvalsByTier([entry('c', 2), entry('a', 0), entry('b', 1), entry('a2', 0)]);
    expect(groups.map((g) => g.tier)).toEqual([0, 1, 2]);
    expect(groups[0]?.evals.map((e) => e.id)).toEqual(['a', 'a2']);
    expect(groups[1]?.evals.map((e) => e.id)).toEqual(['b']);
    expect(groups[2]?.evals.map((e) => e.id)).toEqual(['c']);
  });

  it('mixes defaulted (tier 0) and explicit tiers into the same tier-0 group', () => {
    const groups = groupEvalsByTier([entry('explicit0', 0), entry('defaulted'), entry('high', 3)]);
    expect(groups.map((g) => g.tier)).toEqual([0, 3]);
    expect(groups[0]?.evals.map((e) => e.id)).toEqual(['explicit0', 'defaulted']);
  });
});

describe('fragmentPassed', () => {
  it('is true when all output expectations pass and there is no tool verdict', () => {
    expect(fragmentPassed(fragment('a'))).toBe(true);
  });

  it('is false when an output expectation failed', () => {
    expect(fragmentPassed(fragment('a', { outputPassed: false }))).toBe(false);
  });

  it('is false when the tool verdict failed even though output passed', () => {
    expect(fragmentPassed(fragment('a', { outputPassed: true, toolPassed: false }))).toBe(false);
  });

  it('is true when both output and tool verdict pass', () => {
    expect(fragmentPassed(fragment('a', { outputPassed: true, toolPassed: true }))).toBe(true);
  });
});

describe('shouldGateAfterTier', () => {
  it('does NOT gate an all-pass tier', () => {
    expect(shouldGateAfterTier([fragment('a'), fragment('b')])).toBe(false);
  });

  it('gates when any eval in the tier had a failing output expectation', () => {
    expect(shouldGateAfterTier([fragment('a'), fragment('b', { outputPassed: false })])).toBe(true);
  });

  it('gates when any eval in the tier had a failing tool verdict', () => {
    expect(shouldGateAfterTier([fragment('a', { toolPassed: false })])).toBe(true);
  });

  it('does NOT gate an empty tier (nothing failed)', () => {
    expect(shouldGateAfterTier([])).toBe(false);
  });
});

describe('buildSkippedSummary + formatSkippedTiersSummary', () => {
  const remaining: TierGroup[] = [
    { tier: 1, evals: [entry('mid', 1)] },
    { tier: 2, evals: [entry('hi1', 2), entry('hi2', 2)] },
  ];

  it('summarizes the skipped tiers, their eval ids, and the total count', () => {
    const summary = buildSkippedSummary(0, remaining);
    expect(summary).toEqual({
      gatedByTier: 0,
      firstSkippedTier: 1,
      tiers: [
        { tier: 1, evalIds: ['mid'] },
        { tier: 2, evalIds: ['hi1', 'hi2'] },
      ],
      totalSkipped: 3,
    });
  });

  it('formats a legible one-line summary naming the tiers and the gating tier', () => {
    expect(formatSkippedTiersSummary(buildSkippedSummary(0, remaining))).toBe(
      'SKIPPED (fail-fast): tier 1 and above (3 evals) — gated by tier 0 failure',
    );
  });

  it('uses singular "eval" for a single skipped eval', () => {
    const summary = buildSkippedSummary(0, [{ tier: 1, evals: [entry('only', 1)] }]);
    expect(formatSkippedTiersSummary(summary)).toBe(
      'SKIPPED (fail-fast): tier 1 and above (1 eval) — gated by tier 0 failure',
    );
  });

  it('is defensive on an empty remaining set (zero skips)', () => {
    const summary = buildSkippedSummary(2, []);
    expect(summary).toEqual({ gatedByTier: 2, firstSkippedTier: 2, tiers: [], totalSkipped: 0 });
  });
});
