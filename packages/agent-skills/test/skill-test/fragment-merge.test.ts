import { describe, expect, it } from 'vitest';

import type { EvalFragment } from '../../src/skill-test/eval-fragment.js';
import {
  mergeFragmentsToFriction,
  mergeFragmentsToGrading,
  mergeFragmentsToToolEval,
} from '../../src/skill-test/fragment-merge.js';
import { GradingNonceError, reconcileGrading } from '../../src/skill-test/grading-adapter.js';

const nonce = 'run-nonce-1';
const TMP_ASSUMPTION_MESSAGE = 'assumed /tmp exists';
const PATH_ASSUMPTION_CATEGORY = 'path-assumption';

function makeFragment(overrides: Partial<EvalFragment> = {}): EvalFragment {
  return {
    runNonce: nonce,
    evalId: 'eval-1',
    expectations: [{ text: 'does the thing', passed: true }],
    ...overrides,
  };
}

describe('mergeFragmentsToGrading', () => {
  it('flattens expectations from multiple fragments into one summary that reconciles', () => {
    const fragments: EvalFragment[] = [
      makeFragment({
        evalId: 'eval-1',
        expectations: [
          { text: 'a', passed: true },
          { text: 'b', passed: false },
        ],
      }),
      makeFragment({ evalId: 'eval-2', expectations: [{ text: 'c', passed: true }] }),
    ];

    const grading = mergeFragmentsToGrading(fragments, nonce);

    expect(grading.expectations).toEqual([
      { text: 'a', passed: true },
      { text: 'b', passed: false },
      { text: 'c', passed: true },
    ]);
    expect(grading.summary).toEqual({ passed: 2, total: 3 });

    const verdict = reconcileGrading(grading);
    expect(verdict).toEqual({ passed: 2, total: 3, allPassed: false });
  });

  it('preserves evidence when present on a merged expectation', () => {
    const fragments: EvalFragment[] = [
      makeFragment({ expectations: [{ text: 'a', passed: true, evidence: 'saw it happen' }] }),
    ];
    const grading = mergeFragmentsToGrading(fragments, nonce);
    expect(grading.expectations).toEqual([{ text: 'a', passed: true, evidence: 'saw it happen' }]);
  });

  it('throws GradingNonceError when a fragment nonce does not match the run nonce', () => {
    const fragments: EvalFragment[] = [makeFragment({ runNonce: 'wrong-nonce' })];
    expect(() => mergeFragmentsToGrading(fragments, nonce)).toThrow(GradingNonceError);
  });

  it('throws GradingNonceError naming the offending eval even when an earlier fragment matches', () => {
    const fragments: EvalFragment[] = [
      makeFragment({ evalId: 'eval-1' }),
      makeFragment({ evalId: 'eval-2', runNonce: 'wrong-nonce' }),
    ];
    expect(() => mergeFragmentsToGrading(fragments, nonce)).toThrow(/eval-2/);
  });

  it('returns empty expectations for zero fragments (reconcileGrading guard fires downstream)', () => {
    const grading = mergeFragmentsToGrading([], nonce);
    expect(grading.expectations).toEqual([]);
    expect(grading.summary).toEqual({ passed: 0, total: 0 });
    expect(() => reconcileGrading(grading)).toThrow(/zero expectations/);
  });
});

describe('mergeFragmentsToFriction', () => {
  it('concatenates friction items across fragments and de-dups byte-identical ones', () => {
    const item = { severity: 'high', category: PATH_ASSUMPTION_CATEGORY, message: TMP_ASSUMPTION_MESSAGE } as const;
    const otherItem = { severity: 'low', category: 'doc-engine-drift', message: 'other' } as const;
    const fragments: EvalFragment[] = [
      makeFragment({ friction: [item] }),
      makeFragment({ evalId: 'eval-2', friction: [item, otherItem] }),
    ];

    const report = mergeFragmentsToFriction(fragments);

    expect(report.items).toHaveLength(2);
    expect(report.items).toEqual(expect.arrayContaining([item, otherItem]));
  });

  it('returns an empty items array when no fragment has friction', () => {
    const report = mergeFragmentsToFriction([makeFragment()]);
    expect(report.items).toEqual([]);
  });

  it('keeps items that differ in any field (not byte-identical)', () => {
    const fragments: EvalFragment[] = [
      makeFragment({
        friction: [{ severity: 'high', category: PATH_ASSUMPTION_CATEGORY, message: TMP_ASSUMPTION_MESSAGE }],
      }),
      makeFragment({
        evalId: 'eval-2',
        friction: [{ severity: 'low', category: PATH_ASSUMPTION_CATEGORY, message: TMP_ASSUMPTION_MESSAGE }],
      }),
    ];

    const report = mergeFragmentsToFriction(fragments);

    expect(report.items).toHaveLength(2);
  });
});

describe('mergeFragmentsToToolEval', () => {
  it('collects per-eval tool verdicts, injecting evalId from the fragment', () => {
    const fragments: EvalFragment[] = [
      makeFragment({
        evalId: 'eval-1',
        tool: { mustRun: [{ name: 'bash', ran: true }], passed: true },
      }),
      makeFragment({
        evalId: 'eval-2',
        tool: { mustNotRun: [{ name: 'rm', ran: false }], passed: true },
      }),
    ];

    const report = mergeFragmentsToToolEval(fragments);

    expect(report.evals).toEqual([
      { evalId: 'eval-1', mustRun: [{ name: 'bash', ran: true }], passed: true },
      { evalId: 'eval-2', mustNotRun: [{ name: 'rm', ran: false }], passed: true },
    ]);
  });

  it('omits fragments with no tool body', () => {
    const fragments: EvalFragment[] = [
      makeFragment({ evalId: 'eval-1', tool: { passed: true } }),
      makeFragment({ evalId: 'eval-2' }),
    ];

    const report = mergeFragmentsToToolEval(fragments);

    expect(report.evals).toEqual([{ evalId: 'eval-1', passed: true }]);
  });

  it('returns an empty evals array when no fragment has a tool body', () => {
    const report = mergeFragmentsToToolEval([makeFragment()]);
    expect(report.evals).toEqual([]);
  });

  it('validates the assembled report (throws on a fragment carrying an invalid tool body)', () => {
    const invalidFragment = {
      ...makeFragment({ evalId: 'eval-1' }),
      tool: { passed: true, mustRun: [{ name: '', ran: true }] },
    } as unknown as EvalFragment;

    expect(() => mergeFragmentsToToolEval([invalidFragment])).toThrow();
  });
});
