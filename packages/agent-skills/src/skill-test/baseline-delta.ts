import { z } from 'zod';

import type { ArmEvalGrade, BaselineArmSkew } from './baseline-integrity.js';

/**
 * The A/B DELTA of a `--baseline` run — the thing the command actually sells.
 *
 * WHY THIS EXISTS. `--baseline` runs every eval twice, writes the treatment arm to
 * `results/grading.json` and the control arm to `results/baseline.json`, and — until
 * this module — computed no delta anywhere. The shipped docs said `--baseline`
 * "reports the delta"; what it reported was two files and an invitation to subtract
 * by hand. A product whose entire output is a comparison must do the comparison, or
 * the number that gets quoted is whichever one the operator worked out in their head
 * and wrote down without the caveats.
 *
 * WHY `null` IS THE POINT. Subtracting is only legal when both arms were graded
 * against the same expectations, and {@link armExpectationSkew} is what decides that
 * (see its docblock for how a grader emitting fewer entries on one arm produces two
 * internally-consistent summaries with different denominators). When it is NOT legal,
 * a number here would lie, and it lies in the most damaging direction: a
 * short-graded control reads as "100% without the skill", i.e. "the skill did
 * nothing". So the delta is WITHHELD rather than fudged, clamped, or normalised into
 * a rate. `null` means "no delta exists here"; `0` means "measured, and the skill
 * lifted nothing" — a completely different and perfectly valid finding, and the two
 * must never collapse into one another.
 *
 * The withholding is per-eval as well as run-level: one incomparable eval poisons
 * the run TOTAL (the summaries it feeds have mismatched denominators), but the
 * evals either side of it were measured fine and keep their numbers.
 */

/** One arm's graded totals — `passed` of `total` expectations. */
const ArmTotalsSchema = z.object({
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict();

export const EvalDeltaSchema = z.object({
  evalId: z.string().min(1),
  withPassed: z.number().int().nonnegative(),
  withTotal: z.number().int().nonnegative(),
  withoutPassed: z.number().int().nonnegative(),
  withoutTotal: z.number().int().nonnegative(),
  /**
   * `withPassed − withoutPassed`, or `null` when THIS eval's two arms were graded to
   * different depths. Signed: a negative delta means the control outscored the
   * treatment, which is a real observed outcome and is never clamped to zero.
   */
  delta: z.number().int().nullable(),
}).strict();

export type EvalDelta = z.infer<typeof EvalDeltaSchema>;

/**
 * The run-level `baselineDelta` block, a SIBLING of `baselineIntegrity` in
 * `baseline.json`. The two are separate on purpose: integrity says whether the
 * comparison is trustworthy, this says what the comparison IS, and a reader who
 * wants only the number should not have to reconstruct it from two summaries.
 */
export const BaselineDeltaSchema = z.object({
  with: ArmTotalsSchema,
  without: ArmTotalsSchema,
  /**
   * Run-level lift, or `null` when ANY eval was incomparable.
   *
   * Withheld for the whole run rather than computed over the comparable subset: the
   * arm totals above include every eval, so a partial-subset delta would not be the
   * difference between the two numbers printed beside it — which is precisely the
   * kind of "close enough" number that gets quoted without its caveat.
   */
  delta: z.number().int().nullable(),
  perEval: z.array(EvalDeltaSchema),
}).strict();

export type BaselineDelta = z.infer<typeof BaselineDeltaSchema>;

/** Sum one arm's per-eval grades into the totals that arm's summary reports. */
function armTotals(arm: readonly ArmEvalGrade[]): { passed: number; total: number } {
  return arm.reduce(
    (acc, grade) => ({ passed: acc.passed + grade.passed, total: acc.total + grade.total }),
    { passed: 0, total: 0 },
  );
}

/** The zeroed side of an eval only one arm graded. */
const MISSING_ARM: Omit<ArmEvalGrade, 'evalId'> = { passed: 0, total: 0 };

/**
 * Compute the A/B delta from the two arms' per-eval grades.
 *
 * `skew` is the AUTHORITY on which evals are incomparable — it is not re-derived
 * from the counts here. Two derivations of the same judgement is how the delta block
 * and `baselineIntegrity.skew` would end up disagreeing about one run, and a reader
 * has no way to tell which of two contradicting blocks to believe. Callers pass the
 * output of {@link armExpectationSkew} over the SAME `ArmEvalGrade[]` values they
 * pass here.
 *
 * `perEval` ordering matches {@link armExpectationSkew}: the treatment arm in its own
 * order, then the evals only the control arm graded. An eval present on one arm only
 * appears with the missing side reported as 0 and `delta: null`, exactly as the skew
 * check reports it — a silently absent eval skews the run total the same way a
 * short-graded one does, so it is surfaced rather than dropped.
 *
 * Pure.
 */
export function computeBaselineDelta(
  withArm: readonly ArmEvalGrade[],
  withoutArm: readonly ArmEvalGrade[],
  skew: readonly BaselineArmSkew[],
): BaselineDelta {
  const incomparable = new Set(skew.map((s) => s.evalId));
  const withoutById = new Map(withoutArm.map((g) => [g.evalId, g]));
  const withIds = new Set(withArm.map((g) => g.evalId));

  const perEval: EvalDelta[] = withArm.map((graded) =>
    evalDelta(graded, withoutById.get(graded.evalId) ?? MISSING_ARM, incomparable.has(graded.evalId)),
  );
  for (const graded of withoutArm) {
    if (withIds.has(graded.evalId)) continue;
    perEval.push(
      evalDelta({ evalId: graded.evalId, ...MISSING_ARM }, graded, incomparable.has(graded.evalId)),
    );
  }

  const withTotals = armTotals(withArm);
  const withoutTotals = armTotals(withoutArm);
  return {
    with: withTotals,
    without: withoutTotals,
    delta: skew.length > 0 ? null : withTotals.passed - withoutTotals.passed,
    perEval,
  };
}

function evalDelta(
  graded: ArmEvalGrade,
  without: Omit<ArmEvalGrade, 'evalId'>,
  isIncomparable: boolean,
): EvalDelta {
  return {
    evalId: graded.evalId,
    withPassed: graded.passed,
    withTotal: graded.total,
    withoutPassed: without.passed,
    withoutTotal: without.total,
    delta: isIncomparable ? null : graded.passed - without.passed,
  };
}

/** `+3` / `-2` / `+0` — a bare `3` is a count, a signed `+3` is a direction. */
function signed(delta: number): string {
  return delta < 0 ? String(delta) : `+${delta}`;
}

/**
 * The one line an operator actually reads about the delta.
 *
 * `baseline.json` holds the per-eval detail, and nobody opens it unprompted — the
 * two rounds of integrity work before this one both ended up shipping findings that
 * existed only inside an artifact. So this line has to be self-sufficient in BOTH
 * states: it names each arm's passed/total (so the lift can be sanity-checked
 * against the numbers it came from), and when the delta is withheld it says so, says
 * WHY in one clause, and points at the block holding the evidence.
 *
 * Pure, and deliberately not wired here — the caller decides where it goes.
 */
export function formatBaselineDeltaLine(delta: BaselineDelta): string {
  const arms = `with skill: ${delta.with.passed}/${delta.with.total}, without skill: ${delta.without.passed}/${delta.without.total}`;
  if (delta.delta !== null) return `Baseline delta: ${signed(delta.delta)} (${arms}).`;
  const withheld = delta.perEval.filter((e) => e.delta === null).length;
  return (
    `Baseline delta: unavailable (${arms}) — ${withheld} eval(s) were graded against a different ` +
    'number of expectations on each arm, so the two totals have different denominators and ' +
    'subtracting them would not be a delta. See baselineIntegrity.skew in baseline.json.'
  );
}
