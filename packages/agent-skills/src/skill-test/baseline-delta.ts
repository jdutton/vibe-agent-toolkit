import { z } from 'zod';

import {
  BaselineControlArmFailureSchema,
  BaselineIntegritySchema,
  type ArmEvalGrade,
  type BaselineArmSkew,
  type BaselineControlArmFailure,
} from './baseline-integrity.js';

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

/**
 * One arm's graded totals — `passed` of `total` expectations.
 *
 * The refine is the same one `GradingSummarySchema` carries next door, and it was
 * missing here for exactly as long as this block has existed. `{passed: 9, total: 3}`
 * for the control arm parsed clean, rendered as `without skill: 9/3`, and produced
 * `delta: -8` — a confident negative lift out of a count that cannot happen. Both
 * halves of `baseline.json` now reject it, so no reader has to decide which of two
 * blocks to believe.
 */
const ArmTotalsSchema = z.object({
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict().refine((s) => s.passed <= s.total, {
  message: 'passed cannot exceed total — a count above its own denominator is a grader or merge bug',
});

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
}).strict()
  .refine((e) => e.withPassed <= e.withTotal && e.withoutPassed <= e.withoutTotal, {
    message: 'passed cannot exceed total on either arm',
  })
  // The ARITHMETIC, checked rather than assumed. Nothing else in the codebase
  // asserts that the number in this field is the subtraction the field's own name
  // claims: the schema accepted any integer, and the strongest end-to-end test that
  // reads the artifact only ever asserted the arms. A future refactor of
  // `evalDelta` that returned the wrong difference would have been invisible to
  // both. `null` is exempt — it means "not subtractable", not "subtracted wrong".
  .refine((e) => e.delta === null || e.delta === e.withPassed - e.withoutPassed, {
    message: 'delta must equal withPassed − withoutPassed (or be null when the arms are not comparable)',
  });

export type EvalDelta = z.infer<typeof EvalDeltaSchema>;

/**
 * The suite the delta does NOT cover, when cost-tiered fail-fast truncated the run.
 *
 * `shouldGateAfterTier` stops the run the moment any WITH-arm eval in a tier does not
 * fully pass, and it stops BOTH arms, so the arithmetic over the tiers that ran stays
 * sound. What is not sound is reading the result as the suite's delta: a tier-0
 * failure in an 8-eval suite printed `Baseline delta: +1 (with skill: 2/2, without
 * skill: 1/2)`, byte-identical to a complete 2-eval suite that measured everything it
 * declared.
 *
 * That is not an exotic path. `--baseline` exists to measure a skill that may not be
 * helping, so a WITH-arm failure is the EXPECTED state of an interesting baseline run
 * — the truncated shape is the common one, not the corner case.
 */
export const DeltaTruncationSchema = z.object({
  /** The (lower) tier whose gating failure stopped the run. */
  gatedByTier: z.number().int(),
  /** The lowest tier that never ran. */
  firstSkippedTier: z.number().int(),
  /** How many evals were never run on EITHER arm. */
  totalSkipped: z.number().int().positive(),
  /** Their ids, flattened across the skipped tiers in ascending tier order. */
  evalIds: z.array(z.string().min(1)),
}).strict();

export type DeltaTruncation = z.infer<typeof DeltaTruncationSchema>;

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
  /**
   * Control-arm evals that produced no grade at all, so there was nothing to
   * subtract for them. Carried HERE as well as on `baselineIntegrity` — it is one
   * derivation handed to two consumers (the same arrangement as `ArmEvalGrade`
   * feeding both the parity check and this block), never two derivations — because
   * a reader who opens `baselineDelta` and finds `delta: null` must be able to learn
   * WHY from the block that withheld it, without first having to know the
   * contamination vocabulary next door.
   */
  controlArmFailures: z.array(BaselineControlArmFailureSchema),
  /**
   * What the fail-fast gate cut off, or `null` when the whole declared suite ran.
   *
   * `null` rather than an absent key: "this delta covers everything" is a CLAIM, and
   * the field has to be able to make it. An optional field would make a complete run
   * and a run written before this existed indistinguishable — the same argument that
   * makes `baselineIntegrity` unconditional.
   */
  truncated: DeltaTruncationSchema.nullable(),
}).strict()
  // Same arithmetic check as {@link EvalDeltaSchema}, at the level the operator
  // actually quotes. `formatBaselineDeltaLine` prints the lift and the two arms
  // side by side, so a `delta` that is not their difference is a self-contradicting
  // sentence on stderr — and the schema was the only place that could have said so.
  .refine((d) => d.delta === null || d.delta === d.with.passed - d.without.passed, {
    message: 'delta must equal with.passed − without.passed (or be null when the arms are not comparable)',
  });

export type BaselineDelta = z.infer<typeof BaselineDeltaSchema>;

/**
 * `baseline.json` as a whole: a grading report (validated separately by the
 * caller, which owns that schema) carrying vat's two extra blocks.
 *
 * Exists so the post-merge fail-closed gate can validate the file it just wrote.
 * `.passthrough()` because the grading fields ride alongside and are checked by
 * `GradingReportSchema`; the two blocks below are what THIS schema is for, and
 * both are REQUIRED — an absent `baselineIntegrity` is precisely the "written
 * before the check existed" state the block was made unconditional to rule out.
 */
export const BaselineArtifactSchema = z.object({
  baselineIntegrity: BaselineIntegritySchema,
  baselineDelta: BaselineDeltaSchema,
}).passthrough();

/** Sum one arm's per-eval grades into the totals that arm's summary reports. */
function armTotals(arm: readonly ArmEvalGrade[]): { passed: number; total: number } {
  return arm.reduce(
    (acc, grade) => ({ passed: acc.passed + grade.passed, total: acc.total + grade.total }),
    { passed: 0, total: 0 },
  );
}

/** The zeroed side of an eval only one arm graded. */
const MISSING_ARM: Omit<ArmEvalGrade, 'evalId'> = { passed: 0, total: 0 };

/** Everything the run-level delta block is computed from. */
export interface ComputeBaselineDeltaInput {
  /** The treatment arm's per-eval grades. */
  withArm: readonly ArmEvalGrade[];
  /** The control arm's per-eval grades — evals whose control arm died are simply absent. */
  withoutArm: readonly ArmEvalGrade[];
  /** The SINGLE authority on which evals are incomparable. See below. */
  skew: readonly BaselineArmSkew[];
  /** Control-arm evals that never graded, for the block and the printed reason. */
  controlArmFailures: readonly BaselineControlArmFailure[];
  /** What fail-fast cut off, or `null` when the whole suite ran. */
  truncated: DeltaTruncation | null;
}

/**
 * Compute the A/B delta from the two arms' per-eval grades.
 *
 * `skew` is the AUTHORITY on which evals are incomparable — it is not re-derived
 * from the counts here, and `controlArmFailures` does NOT get a second vote. Two
 * derivations of the same judgement is how the delta block and
 * `baselineIntegrity.skew` would end up disagreeing about one run, and a reader has
 * no way to tell which of two contradicting blocks to believe. A dead control arm
 * needs no second vote in any case: it leaves that eval graded on one arm only,
 * which {@link armExpectationSkew} already reports as skew. Callers pass the output
 * of {@link armExpectationSkew} over the SAME `ArmEvalGrade[]` values they pass here.
 *
 * `perEval` ordering matches {@link armExpectationSkew}: the treatment arm in its own
 * order, then the evals only the control arm graded. An eval present on one arm only
 * appears with the missing side reported as 0 and `delta: null`, exactly as the skew
 * check reports it — a silently absent eval skews the run total the same way a
 * short-graded one does, so it is surfaced rather than dropped.
 *
 * `truncated` does NOT withhold the delta. The tiers that ran, ran on both arms, so
 * their subtraction is legal; what truncation changes is the SCOPE of the claim, and
 * a scope caveat is reported (here and in the printed line), not a `null`. Spending
 * `null` — which means "these arms cannot be subtracted" — on a run where they can be
 * would collapse two failures with different remedies into one value.
 *
 * Pure.
 */
export function computeBaselineDelta(input: ComputeBaselineDeltaInput): BaselineDelta {
  const { withArm, withoutArm, skew } = input;
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
    controlArmFailures: [...input.controlArmFailures],
    truncated: input.truncated,
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
 * The SCOPE clause: what this delta does not cover.
 *
 * Appended in BOTH states — a truncated run that still produced a number is the
 * dangerous one, because `+1 (with skill: 2/2, without skill: 1/2)` is a complete,
 * confident, quotable sentence about two of the eight evals the suite declares.
 */
function truncationClause(truncated: DeltaTruncation | null): string {
  if (truncated === null) return '';
  const ids = truncated.evalIds.length === 0 ? '' : ` [${truncated.evalIds.join(', ')}]`;
  return (
    ` PARTIAL SUITE: fail-fast gated on tier ${truncated.gatedByTier}, so tier ` +
    `${truncated.firstSkippedTier} and above never ran on EITHER arm — ${truncated.totalSkipped} ` +
    `eval(s)${ids} are absent from both totals above. This is the delta over the tiers that ran, ` +
    'not over the suite.'
  );
}

/** Why the delta was withheld — the control arm dying is a different failure from the arms disagreeing. */
function withheldClause(delta: BaselineDelta): string {
  if (delta.controlArmFailures.length > 0) {
    const ids = delta.controlArmFailures.map((f) => f.evalId).join(', ');
    return (
      `the CONTROL arm (skill withheld) produced no grade for ${delta.controlArmFailures.length} ` +
      `eval(s) [${ids}], so there is nothing to subtract from the treatment arm. The treatment ` +
      'arm ran and its grading.json/tool-eval.json are complete and trustworthy — only the ' +
      'comparison is missing. See baselineIntegrity.controlArmFailures in baseline.json.'
    );
  }
  const withheld = delta.perEval.filter((e) => e.delta === null).length;
  return (
    `${withheld} eval(s) were graded against a different number of expectations on each arm, ` +
    'so the two totals have different denominators and subtracting them would not be a delta. ' +
    'See baselineIntegrity.skew in baseline.json.'
  );
}

/**
 * The one line an operator actually reads about the delta.
 *
 * `baseline.json` holds the per-eval detail, and nobody opens it unprompted — the
 * two rounds of integrity work before this one both ended up shipping findings that
 * existed only inside an artifact. So this line has to be self-sufficient in BOTH
 * states: it names each arm's passed/total (so the lift can be sanity-checked
 * against the numbers it came from), it says what the numbers do NOT cover when the
 * run was truncated, and when the delta is withheld it says so, says WHICH ARM broke
 * and how, and points at the block holding the evidence.
 *
 * Pure, and deliberately not wired here — the caller decides where it goes.
 */
export function formatBaselineDeltaLine(delta: BaselineDelta): string {
  const arms = `with skill: ${delta.with.passed}/${delta.with.total}, without skill: ${delta.without.passed}/${delta.without.total}`;
  const scope = truncationClause(delta.truncated);
  if (delta.delta !== null) return `Baseline delta: ${signed(delta.delta)} (${arms}).${scope}`;
  return `Baseline delta: unavailable (${arms}) — ${withheldClause(delta)}${scope}`;
}
