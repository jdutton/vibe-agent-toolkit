import { describe, expect, it } from 'vitest';

import {
  BaselineDeltaSchema,
  computeBaselineDelta,
  formatBaselineDeltaLine,
  type DeltaTruncation,
} from '../../src/skill-test/baseline-delta.js';
import {
  armExpectationSkew,
  type ArmEvalGrade,
  type BaselineControlArmFailure,
} from '../../src/skill-test/baseline-integrity.js';

const grade = (evalId: string, passed: number, total: number): ArmEvalGrade => ({
  evalId,
  passed,
  total,
});

/** The two states that are not "a plain, complete, both-arms-ran comparison". */
interface DeltaExtras {
  controlArmFailures?: readonly BaselineControlArmFailure[];
  truncated?: DeltaTruncation | null;
}

/**
 * Compute the delta the way a run does — ONE `ArmEvalGrade[]` per arm, derived
 * once, feeding both the skew check and the delta. Two independent derivations of
 * "what each arm graded" is the drift hazard the widened type exists to remove, so
 * the tests must not model them separately either.
 *
 * `extras` defaults to the healthy, complete run. Note that the PRODUCTION signature
 * has no such defaults — every field is required there precisely so a new call site
 * cannot quietly claim "no control failures, whole suite ran". A test helper is the
 * one place a default is safe, because a test that meant to exercise a failure and
 * silently got the healthy path fails its own assertions.
 */
const deltaOf = (
  withArm: readonly ArmEvalGrade[],
  withoutArm: readonly ArmEvalGrade[],
  extras: DeltaExtras = {},
) =>
  computeBaselineDelta({
    withArm,
    withoutArm,
    skew: armExpectationSkew(withArm, withoutArm),
    controlArmFailures: extras.controlArmFailures ?? [],
    truncated: extras.truncated ?? null,
  });

/** A fail-fast gate that stopped after tier 0, leaving `evalIds` in tier 1 unrun. */
const gatedAfterTier0 = (evalIds: string[]): DeltaTruncation => ({
  gatedByTier: 0,
  firstSkippedTier: 1,
  totalSkipped: evalIds.length,
  evalIds,
});

describe('computeBaselineDelta — comparable arms', () => {
  it('subtracts per eval and across the run', () => {
    const result = deltaOf(
      [grade('e1', 3, 3), grade('e2', 1, 3)],
      [grade('e1', 1, 3), grade('e2', 2, 3)],
    );

    expect(result.with).toEqual({ passed: 4, total: 6 });
    expect(result.without).toEqual({ passed: 3, total: 6 });
    expect(result.delta).toBe(1);
    expect(result.perEval).toEqual([
      { evalId: 'e1', withPassed: 3, withTotal: 3, withoutPassed: 1, withoutTotal: 3, delta: 2 },
      { evalId: 'e2', withPassed: 1, withTotal: 3, withoutPassed: 2, withoutTotal: 3, delta: -1 },
    ]);
  });

  // The control outscoring the treatment is an observed result in this project, not
  // a bug in the arithmetic. Clamping it to 0 would hide the one finding an operator
  // most needs to see: the skill made things worse.
  it('keeps a NEGATIVE lift negative, at both levels', () => {
    const result = deltaOf([grade('e1', 1, 3)], [grade('e1', 3, 3)]);

    expect(result.delta).toBe(-2);
    expect(result.perEval[0]?.delta).toBe(-2);
  });

  // `0` and `null` are completely different findings: "measured, and the skill
  // lifted nothing" versus "no delta exists here". Collapsing the first into the
  // second throws away a valid measurement.
  it('reports a measured zero lift as 0, never null', () => {
    const result = deltaOf([grade('e1', 2, 3)], [grade('e1', 2, 3)]);

    expect(result.delta).toBe(0);
    expect(result.delta).not.toBeNull();
    expect(result.perEval[0]?.delta).toBe(0);
    expect(result.perEval[0]?.delta).not.toBeNull();
  });

  it('reports zeroed totals and a measured 0 for a run with no evals on either arm', () => {
    const result = deltaOf([], []);

    expect(result).toEqual({
      with: { passed: 0, total: 0 },
      without: { passed: 0, total: 0 },
      delta: 0,
      perEval: [],
      controlArmFailures: [],
      truncated: null,
    });
  });
});

describe('computeBaselineDelta — withheld deltas', () => {
  // A short-graded control reads as "100% without the skill", i.e. "the skill did
  // nothing" — the most damaging direction a number can be wrong in. So the delta
  // is withheld rather than fudged, and only for the evals that earned it.
  it('withholds the skewed eval and the run total, leaving the other evals intact', () => {
    const result = deltaOf(
      [grade('e1', 3, 3), grade('e2', 2, 2)],
      [grade('e1', 2, 2), grade('e2', 1, 2)],
    );

    expect(result.perEval).toEqual([
      { evalId: 'e1', withPassed: 3, withTotal: 3, withoutPassed: 2, withoutTotal: 2, delta: null },
      { evalId: 'e2', withPassed: 2, withTotal: 2, withoutPassed: 1, withoutTotal: 2, delta: 1 },
    ]);
    expect(result.delta).toBeNull();
    // The arm summaries still report what each arm actually graded — withholding the
    // SUBTRACTION is not the same as suppressing the two numbers behind it.
    expect(result.with).toEqual({ passed: 5, total: 5 });
    expect(result.without).toEqual({ passed: 3, total: 4 });
  });

  // `skew` is the authority, not the counts. Re-deriving comparability here would
  // let this block and `baselineIntegrity.skew` disagree about the same run.
  it('withholds on the caller-supplied skew even when the counts look comparable', () => {
    const result = computeBaselineDelta({
      withArm: [grade('e1', 3, 3)],
      withoutArm: [grade('e1', 1, 3)],
      skew: [{ evalId: 'e1', withTotal: 3, withoutTotal: 3 }],
      controlArmFailures: [],
      truncated: null,
    });

    expect(result.perEval[0]?.delta).toBeNull();
    expect(result.delta).toBeNull();
  });

  // `controlArmFailures` records WHY, it does not decide WHETHER — `skew` is the
  // single authority. The two cannot disagree in a real run (a dead control arm
  // leaves the eval graded on one arm, which is skew), but if a caller ever fed
  // them inconsistently, the delta must follow skew rather than quietly acquire a
  // second withholding rule that `baselineIntegrity.comparable` does not share.
  it('does NOT withhold on a control-arm failure that produced no skew', () => {
    const result = computeBaselineDelta({
      withArm: [grade('e1', 3, 3)],
      withoutArm: [grade('e1', 1, 3)],
      skew: [],
      controlArmFailures: [{ evalId: 'e9', detail: 'grader timed out' }],
      truncated: null,
    });

    expect(result.delta).toBe(2);
    expect(result.controlArmFailures).toEqual([{ evalId: 'e9', detail: 'grader timed out' }]);
  });

  // Truncation changes the SCOPE of the claim, never its legality: fail-fast stops
  // both arms at the same tier boundary, so what did run subtracts cleanly. Spending
  // `null` here would collapse "cannot be subtracted" into "covers less than you
  // think" — two failures with different remedies.
  it('reports a NUMBER for a truncated run, with the truncation recorded beside it', () => {
    const result = deltaOf([grade('e1', 2, 2)], [grade('e1', 1, 2)], {
      truncated: gatedAfterTier0(['e2', 'e3']),
    });

    expect(result.delta).toBe(1);
    expect(result.truncated).toEqual({
      gatedByTier: 0,
      firstSkippedTier: 1,
      totalSkipped: 2,
      evalIds: ['e2', 'e3'],
    });
  });

  // Matches `armExpectationSkew`: the missing side is reported as 0 rather than
  // dropped, because a silently absent eval skews the run exactly as a short-graded
  // one does.
  it.each([
    [
      'the control arm never graded it',
      [grade('e1', 2, 2)],
      [],
      { withPassed: 2, withTotal: 2, withoutPassed: 0, withoutTotal: 0 },
    ],
    [
      'the treatment arm never graded it',
      [],
      [grade('e1', 2, 2)],
      { withPassed: 0, withTotal: 0, withoutPassed: 2, withoutTotal: 2 },
    ],
  ])('reports an eval only one arm graded — %s', (_label, withArm, withoutArm, sides) => {
    const result = deltaOf(withArm, withoutArm);

    expect(result.perEval).toEqual([{ evalId: 'e1', ...sides, delta: null }]);
    expect(result.delta).toBeNull();
  });

  // Ordering is `armExpectationSkew`'s: the treatment arm in its own order, then the
  // evals only the control arm graded. Two blocks about the same run listing the
  // same evals in different orders is a needless diffing tax on the operator.
  it('orders perEval as armExpectationSkew does — with-arm first, then control-only', () => {
    const result = deltaOf(
      [grade('a', 1, 1), grade('b', 1, 1)],
      [grade('b', 0, 1), grade('c', 1, 1)],
    );

    expect(result.perEval.map((e) => e.evalId)).toEqual(['a', 'b', 'c']);
  });
});

describe('BaselineDeltaSchema', () => {
  it.each([
    ['a measured delta', deltaOf([grade('e1', 3, 3)], [grade('e1', 1, 3)])],
    ['a withheld delta', deltaOf([grade('e1', 3, 3)], [grade('e1', 2, 2)])],
  ])('round-trips %s', (_label, result) => {
    expect(BaselineDeltaSchema.safeParse(result).success).toBe(true);
  });

  // Strict at EVERY level, not just the top: the block is written into a file other
  // tools read, and a field that drifted in unvalidated at the per-eval or arm-totals
  // level is exactly as unnoticed as one that drifted in at the root.
  it.each([
    ['at the top level', { ...deltaOf([], []), lift: 1 }],
    [
      'on an arm total',
      { ...deltaOf([], []), with: { passed: 0, total: 0, rate: 1 } },
    ],
    [
      'on a per-eval entry',
      {
        ...deltaOf([grade('e1', 1, 1)], [grade('e1', 0, 1)]),
        perEval: [
          {
            evalId: 'e1',
            withPassed: 1,
            withTotal: 1,
            withoutPassed: 0,
            withoutTotal: 1,
            delta: 1,
            lift: 1,
          },
        ],
      },
    ],
  ])('rejects an unknown key %s, so the block cannot drift from its contract', (_label, result) => {
    expect(BaselineDeltaSchema.safeParse(result).success).toBe(false);
  });

  /**
   * The two invariants the block asserts about ITSELF, both of which it used to
   * accept violations of in silence.
   *
   * `GradingSummarySchema` next door has carried `passed <= total` since it was
   * written; `ArmTotalsSchema` never did, so `{passed: 9, total: 3}` on the control
   * arm parsed clean, rendered as `without skill: 9/3`, and produced a confident
   * `delta: -8`. And nothing anywhere asserted that `delta` is the subtraction its
   * own name claims — an arithmetic bug in `evalDelta` or `computeBaselineDelta`
   * was invisible to the schema AND to the strongest test that reads the artifact.
   *
   * Built by MUTATING a valid block rather than by hand, so every row differs from
   * a passing case in exactly the field it is about.
   */
  it.each([
    [
      // The arithmetic is kept CONSISTENT (9 − 1 = 8) so this row can only be
      // rejected by the `passed <= total` rule. Written the obvious way — mutating
      // `without` and leaving `delta` alone — the arithmetic refine rejected it
      // first and the rule under test was never reached; disabling it left the
      // whole suite green.
      'an arm total whose passed exceeds its total',
      {
        ...deltaOf([grade('e1', 3, 3)], [grade('e1', 1, 3)]),
        with: { passed: 9, total: 3 },
        delta: 8,
      },
    ],
    [
      'a per-eval entry whose passed exceeds its total',
      {
        ...deltaOf([grade('e1', 3, 3)], [grade('e1', 1, 3)]),
        perEval: [{ evalId: 'e1', withPassed: 9, withTotal: 3, withoutPassed: 1, withoutTotal: 3, delta: 8 }],
      },
    ],
    [
      'a run delta that is not the difference between the arms',
      { ...deltaOf([grade('e1', 3, 3)], [grade('e1', 1, 3)]), delta: 7 },
    ],
    [
      'a per-eval delta that is not the difference between the arms',
      {
        ...deltaOf([grade('e1', 3, 3)], [grade('e1', 1, 3)]),
        perEval: [{ evalId: 'e1', withPassed: 3, withTotal: 3, withoutPassed: 1, withoutTotal: 3, delta: 7 }],
      },
    ],
  ])('rejects %s', (_label, result) => {
    expect(BaselineDeltaSchema.safeParse(result).success).toBe(false);
  });

  // The arithmetic check must not fire on the state it does not describe: `null`
  // means "these arms cannot be subtracted", not "subtracted wrong".
  it('exempts a withheld delta from the arithmetic check', () => {
    const withheld = deltaOf([grade('e1', 3, 3)], [grade('e1', 2, 2)]);

    expect(withheld.delta).toBeNull();
    expect(withheld.with.passed - withheld.without.passed, 'the arms would not have agreed anyway').not.toBe(0);
    expect(BaselineDeltaSchema.safeParse(withheld).success).toBe(true);
  });

  // A NEGATIVE delta is a real observed outcome (the control outscored the
  // treatment) and the arithmetic check must admit it — clamping it would be the
  // very fudge `null` exists to avoid.
  it('admits a negative delta that is genuinely the difference', () => {
    const result = deltaOf([grade('e1', 1, 3)], [grade('e1', 3, 3)]);

    expect(result.delta).toBe(-2);
    expect(BaselineDeltaSchema.safeParse(result).success).toBe(true);
  });

  // `null` has to survive the contract too — a schema that only admits a number
  // would make the withheld state unwritable and force a fabricated one.
  it('admits a null delta at both levels', () => {
    const result = deltaOf([grade('e1', 3, 3)], [grade('e1', 2, 2)]);

    expect(result.delta).toBeNull();
    expect(result.perEval[0]?.delta).toBeNull();
    expect(BaselineDeltaSchema.safeParse(result).success).toBe(true);
  });
});

describe('formatBaselineDeltaLine', () => {
  // A bare `3` does not read as lift; `+3` does. The sign is the whole difference
  // between a number and a direction.
  it.each([
    ['a positive lift', [grade('e1', 3, 3)], [grade('e1', 1, 3)], '+2'],
    ['a negative lift', [grade('e1', 1, 3)], [grade('e1', 3, 3)], '-2'],
    ['a measured zero', [grade('e1', 2, 3)], [grade('e1', 2, 3)], '+0'],
  ])('renders %s with its sign, naming both arms', (_label, withArm, withoutArm, signed) => {
    const line = formatBaselineDeltaLine(deltaOf(withArm, withoutArm));

    expect(line).toContain(signed);
    expect(line).toContain('with skill');
    expect(line).toContain('without skill');
    expect(line).not.toContain('unavailable');
  });

  it('names both arms passed/total in a measured line', () => {
    const line = formatBaselineDeltaLine(deltaOf([grade('e1', 3, 4)], [grade('e1', 1, 4)]));

    expect(line).toContain('3/4');
    expect(line).toContain('1/4');
  });

  // Nobody opens baseline.json unprompted, so the withheld line has to carry the
  // reason itself and then say where the per-eval detail lives.
  it('says the delta is unavailable, why, and where the detail is', () => {
    const line = formatBaselineDeltaLine(deltaOf([grade('e1', 3, 3)], [grade('e1', 2, 2)]));

    expect(line).toContain('unavailable');
    // The mismatched denominators are the EVIDENCE for the claim the line makes, so
    // the line has to show them rather than assert incomparability in the abstract.
    expect(line).toContain('3/3');
    expect(line).toContain('2/2');
    expect(line).toContain('different number of expectations');
    expect(line).toContain('baselineIntegrity.skew');
    expect(line).toContain('baseline.json');
    // A signed lift in a withheld line is exactly the lie the null exists to prevent.
    expect(line).not.toMatch(/[+-]\d/);
  });

  it('counts the incomparable evals in the withheld line', () => {
    const line = formatBaselineDeltaLine(
      deltaOf([grade('e1', 3, 3), grade('e2', 2, 2)], [grade('e1', 2, 2), grade('e2', 1, 1)]),
    );

    expect(line).toContain('2 eval');
  });

  /**
   * A dead control arm and two arms that disagree are DIFFERENT failures with
   * different remedies, and they arrive at the same `delta: null`. Reporting the
   * skew wording for a control arm that never spoke sends the operator to audit a
   * grader prompt when the actual fault was a timeout — and, worse, hides that the
   * treatment half of the run is intact and already paid for.
   */
  describe('a control arm that never graded', () => {
    const line = () =>
      formatBaselineDeltaLine(
        deltaOf([grade('e1', 2, 2), grade('e2', 2, 2)], [grade('e2', 1, 2)], {
          controlArmFailures: [
            { evalId: 'e1', detail: '[control arm (skill withheld)] Executor timed out for eval "e1" (limit 300000ms).' },
          ],
        }),
      );

    it.each([
      ['says the delta is unavailable', 'unavailable'],
      ['NAMES the arm that broke', 'CONTROL arm'],
      ['names the eval it broke on', 'e1'],
      ['says the treatment arm is still trustworthy', 'grading.json'],
      ['points at the block holding the failure detail', 'baselineIntegrity.controlArmFailures'],
    ])('%s', (_label, needle) => {
      expect(line()).toContain(needle);
    });

    // The skew wording is the WRONG diagnosis here even though skew is what
    // withheld the number — this is the whole reason the two clauses are separate.
    it('does not blame the graders for disagreeing about expectation counts', () => {
      expect(line()).not.toContain('different number of expectations');
    });
  });

  /**
   * The defect in one sentence: a tier-0 failure in an 8-eval suite printed
   * `Baseline delta: +1 (with skill: 2/2, without skill: 1/2)` — a complete,
   * quotable claim about a quarter of the suite, byte-identical to what a genuinely
   * complete 2-eval suite prints.
   */
  describe('a fail-fast-truncated run', () => {
    const truncatedLine = formatBaselineDeltaLine(
      deltaOf([grade('e1', 2, 2)], [grade('e1', 1, 2)], { truncated: gatedAfterTier0(['e2', 'e3']) }),
    );

    it.each([
      ['still reports the measured lift', '+1'],
      ['says the suite was partial', 'PARTIAL SUITE'],
      ['names how many evals are missing from the totals', '2 eval'],
      ['names them', 'e2, e3'],
      ['names the tier the gate fired on', 'tier 0'],
      ['says the totals exclude them', 'absent from both totals'],
    ])('%s', (_label, needle) => {
      expect(truncatedLine).toContain(needle);
    });

    // The distinguishability test, stated as such: the same arm totals from a
    // COMPLETE run must not produce the same line.
    it('is not the same line a complete run of the same size produces', () => {
      expect(truncatedLine).not.toBe(formatBaselineDeltaLine(deltaOf([grade('e1', 2, 2)], [grade('e1', 1, 2)])));
    });

    // Both caveats at once — a truncated run whose control arm also died must not
    // drop either half.
    it('carries the scope caveat into a WITHHELD line too', () => {
      const line = formatBaselineDeltaLine(
        deltaOf([grade('e1', 2, 2)], [], {
          controlArmFailures: [{ evalId: 'e1', detail: 'control grader wrote no fragment' }],
          truncated: gatedAfterTier0(['e2']),
        }),
      );

      expect(line).toContain('unavailable');
      expect(line).toContain('CONTROL arm');
      expect(line).toContain('PARTIAL SUITE');
    });
  });
});
