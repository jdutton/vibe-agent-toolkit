import { describe, expect, it } from 'vitest';

import {
  BaselineDeltaSchema,
  computeBaselineDelta,
  formatBaselineDeltaLine,
} from '../../src/skill-test/baseline-delta.js';
import { armExpectationSkew, type ArmEvalGrade } from '../../src/skill-test/baseline-integrity.js';

const grade = (evalId: string, passed: number, total: number): ArmEvalGrade => ({
  evalId,
  passed,
  total,
});

/**
 * Compute the delta the way a run does — ONE `ArmEvalGrade[]` per arm, derived
 * once, feeding both the skew check and the delta. Two independent derivations of
 * "what each arm graded" is the drift hazard the widened type exists to remove, so
 * the tests must not model them separately either.
 */
const deltaOf = (withArm: readonly ArmEvalGrade[], withoutArm: readonly ArmEvalGrade[]) =>
  computeBaselineDelta(withArm, withoutArm, armExpectationSkew(withArm, withoutArm));

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
    const result = computeBaselineDelta(
      [grade('e1', 3, 3)],
      [grade('e1', 1, 3)],
      [{ evalId: 'e1', withTotal: 3, withoutTotal: 3 }],
    );

    expect(result.perEval[0]?.delta).toBeNull();
    expect(result.delta).toBeNull();
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
});
