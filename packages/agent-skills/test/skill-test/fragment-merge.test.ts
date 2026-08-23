import { describe, expect, it } from 'vitest';

import type { EvalFragment } from '../../src/skill-test/eval-fragment.js';
import {
  mergeFragmentsToFriction,
  mergeFragmentsToGrading,
  mergeFragmentsToToolEval,
} from '../../src/skill-test/fragment-merge.js';
import { GradingArmError, GradingNonceError, reconcileGrading } from '../../src/skill-test/grading-adapter.js';
import { partitionFragmentsByArm } from '../../src/skill-test/run-harness.js';

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

    const grading = mergeFragmentsToGrading(fragments, nonce, 'with');

    expect(grading.expectations).toEqual([
      { text: 'a', passed: true, evalId: 'eval-1' },
      { text: 'b', passed: false, evalId: 'eval-1' },
      { text: 'c', passed: true, evalId: 'eval-2' },
    ]);
    expect(grading.summary).toEqual({ passed: 2, total: 3 });

    const verdict = reconcileGrading(grading);
    expect(verdict).toEqual({ passed: 2, total: 3, allPassed: false });
  });

  it('preserves evidence when present on a merged expectation', () => {
    const fragments: EvalFragment[] = [
      makeFragment({ expectations: [{ text: 'a', passed: true, evidence: 'saw it happen' }] }),
    ];
    const grading = mergeFragmentsToGrading(fragments, nonce, 'with');
    expect(grading.expectations).toEqual([{ text: 'a', passed: true, evidence: 'saw it happen', evalId: 'eval-1' }]);
  });

  it('throws GradingNonceError when a fragment nonce does not match the run nonce', () => {
    const fragments: EvalFragment[] = [makeFragment({ runNonce: 'wrong-nonce' })];
    expect(() => mergeFragmentsToGrading(fragments, nonce, 'with')).toThrow(GradingNonceError);
  });

  it('throws GradingNonceError naming the offending eval even when an earlier fragment matches', () => {
    const fragments: EvalFragment[] = [
      makeFragment({ evalId: 'eval-1' }),
      makeFragment({ evalId: 'eval-2', runNonce: 'wrong-nonce' }),
    ];
    expect(() => mergeFragmentsToGrading(fragments, nonce, 'with')).toThrow(/eval-2/);
  });

  /**
   * `runNonce` is the ONE field `sanitizeGraderTextDeep` is told to SKIP, because it
   * must survive byte-exact to be compared — which makes it the one grader-supplied
   * string in the fragment with no neutralization on it. The CLI prints an error's
   * `message` raw, so quoting the value here printed attacker bytes by construction.
   *
   * This throw is currently unreachable (`runGraderForEval` rejects a mismatch one
   * call earlier, quoting nothing), so it is defense in depth — and defense in depth
   * that repaints the terminal is not defense.
   */
  it('reports a mismatched nonce by digest, never by value', () => {
    const ESC = String.fromCharCode(0x1b);
    const CR = String.fromCharCode(0x0d);
    const forged = `${ESC}[2K${CR}${ESC}[32m vat: grading verified`;
    let message = '';
    try {
      mergeFragmentsToGrading([makeFragment({ runNonce: forged })], nonce, 'with');
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message, 'the merge accepted a forged nonce').not.toBe('');
    expect(message, 'the fragment\'s own bytes reached the operator').not.toContain(ESC);
    expect(message).not.toContain(CR);
    expect(message).not.toContain(forged);
    // ...and the EXPECTED nonce is not printed either: it is this run's live
    // integrity secret, and a fragment that provoked the error would be handed it.
    expect(message, 'the run\'s own nonce was disclosed in the error').not.toContain(nonce);
    // The diagnostics that made the raw value useful survive: two runs are still
    // distinguishable, and a truncated/padded nonce is still visible as a length.
    expect(message).toContain('sha256:');
    expect(message).toContain(`(${forged.length} chars)`);
  });

  it('returns empty expectations for zero fragments (reconcileGrading guard fires downstream)', () => {
    const grading = mergeFragmentsToGrading([], nonce, 'with');
    expect(grading.expectations).toEqual([]);
    expect(grading.summary).toEqual({ passed: 0, total: 0 });
    expect(() => reconcileGrading(grading)).toThrow(/zero expectations/);
  });

  // The `arm` label is what lets a reader holding ONE artifact say which
  // `--baseline` arm produced it (grading.json = WITH, baseline.json = WITHOUT);
  // both values are exercised because a merge that hardcodes 'with' passes a
  // single-value test.
  it.each([
    { merged: 'with' as const, fragmentArm: 'with' as const, note: "an explicitly-'with' fragment" },
    { merged: 'without' as const, fragmentArm: 'without' as const, note: "a 'without' fragment" },
    { merged: 'with' as const, fragmentArm: undefined, note: 'an arm-less fragment (absent means the default arm)' },
  ])('stamps arm "$merged" on the merged report from $note', ({ merged, fragmentArm }) => {
    const fragments: EvalFragment[] = [
      makeFragment(fragmentArm === undefined ? {} : { arm: fragmentArm }),
    ];

    const grading = mergeFragmentsToGrading(fragments, nonce, merged);

    expect(grading.arm).toBe(merged);
  });

  // A fragment from the other arm invalidates whatever number is merged from it,
  // so the merge refuses rather than mislabelling an artifact that then reads as
  // authoritative — the same posture as the runNonce check.
  it.each([
    { merged: 'with' as const, fragmentArm: 'without' as const, note: "a 'without' fragment merged as WITH" },
    { merged: 'without' as const, fragmentArm: 'with' as const, note: "a 'with' fragment merged as WITHOUT" },
    { merged: 'without' as const, fragmentArm: undefined, note: 'an arm-less fragment merged as WITHOUT' },
  ])('throws GradingArmError naming the eval for $note', ({ merged, fragmentArm }) => {
    const fragments: EvalFragment[] = [
      makeFragment({ evalId: 'eval-1' }),
      makeFragment({ evalId: 'eval-2', ...(fragmentArm === undefined ? {} : { arm: fragmentArm }) }),
    ];
    // The first fragment is on the merged arm when merging WITH; when merging
    // WITHOUT it is the arm-less default, so give it the merged arm explicitly.
    if (merged === 'without') fragments[0] = makeFragment({ evalId: 'eval-1', arm: 'without' });

    expect(() => mergeFragmentsToGrading(fragments, nonce, merged)).toThrow(GradingArmError);
    expect(() => mergeFragmentsToGrading(fragments, nonce, merged)).toThrow(/eval-2/);
  });

  // The pairing invariant the run-harness call sites must satisfy:
  // `partitionFragmentsByArm().withArm` is merged as 'with' and `.withoutArm` as
  // 'without'. `writeRunArtifactsAndReconcile` is module-private I/O, so a unit
  // test cannot observe those two literals directly — this pins the contract
  // between the two exported halves it composes, which is what a swap violates.
  it('pairs each partitioned arm with its own label, and refuses the swapped pairing', () => {
    const mixed: EvalFragment[] = [
      makeFragment({ evalId: 'eval-1', arm: 'with' }),
      makeFragment({ evalId: 'eval-2', arm: 'without' }),
    ];
    const { withArm, withoutArm } = partitionFragmentsByArm(mixed);

    expect(mergeFragmentsToGrading(withArm, nonce, 'with').arm).toBe('with');
    expect(mergeFragmentsToGrading(withoutArm, nonce, 'without').arm).toBe('without');

    expect(() => mergeFragmentsToGrading(withArm, nonce, 'without')).toThrow(GradingArmError);
    expect(() => mergeFragmentsToGrading(withoutArm, nonce, 'with')).toThrow(GradingArmError);
  });

  it('stamps each merged expectation with its OWN fragment evalId, not a constant', () => {
    const fragments: EvalFragment[] = [
      makeFragment({ evalId: 'eval-alpha', expectations: [{ text: 'a', passed: true }] }),
      makeFragment({ evalId: 'eval-beta', expectations: [{ text: 'b', passed: true }] }),
    ];

    const grading = mergeFragmentsToGrading(fragments, nonce, 'with');

    expect(grading.expectations.map(e => e.evalId)).toEqual(['eval-alpha', 'eval-beta']);
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
