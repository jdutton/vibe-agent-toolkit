import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Canonical schema for the grader agent's `grading.json` output.
 *
 * SOURCE OF TRUTH: skill-creator's `references/schemas.md` (the `grading.json`
 * section). vat consumes that exact shape; this module is the machine-checkable
 * encoding of it (skill-creator ships prose + an example, but no JSON Schema).
 * The published JSON Schema is {@link GradingReportJsonSchema}.
 *
 * SHAPE: a SINGLE flat JSON object with two load-bearing top-level fields —
 *
 *   {
 *     "expectations": [ { "text": string, "passed": boolean, "evidence"?: string }, ... ],
 *     "summary":      { "passed": number, "total": number, "failed"?: number, "pass_rate"?: number }
 *   }
 *
 * `expectations` holds ONE entry per graded expectation across ALL evals — it is
 * NOT grouped per-eval and is NEVER wrapped in an `evals` array. A per-eval
 * nested shape (`{ evals: [ { expectations, summary } ] }`) is a contract
 * violation and is rejected loudly (see grading-adapter.ts); tolerating it would
 * push malformed data downstream and create confusion.
 *
 * LIBERAL ON EXTRAS (Postel): the grader legitimately emits additional documented
 * sections — `execution_metrics`, `timing`, `claims`, `user_notes_summary`,
 * `eval_feedback` — plus viewer URLs and other adornments. We `.passthrough()`
 * those: validate the two fields we depend on, carry the rest untouched. Extra
 * fields are NOT "bad JSON"; a wrong top-level STRUCTURE is.
 */

/** One graded expectation. `evidence` is recommended but not load-bearing for vat. */
export const GradedExpectationSchema = z
  .object({
    text: z.string(),
    passed: z.boolean(),
    evidence: z.string().optional(),
    /**
     * Which eval this expectation was graded under. vat stamps it when it
     * assembles the aggregate from per-eval grader fragments, so that a
     * `--baseline` run's two artifacts can be lined up PER EVAL rather than only
     * in aggregate — without it, a reader can compare two totals but cannot say
     * which eval moved. Optional because a grading.json produced by external
     * tooling (skill-creator's own) carries no per-eval attribution; the schema
     * documents the field vat now emits rather than tightening the contract.
     */
    evalId: z.string().optional(),
  })
  .passthrough();

export type GradedExpectation = z.infer<typeof GradedExpectationSchema>;

/**
 * The cross-field invariant, worded once and carried into BOTH surfaces that can
 * state it: the Zod refine's failure message, and the `description` on `summary`
 * in the published JSON Schema.
 *
 * It has to be carried explicitly because `zodToJsonSchema` DISCARDS `.refine()`.
 * Without this, the published document said `{passed: integer≥0, total: integer≥0}`
 * and nothing else — so external tooling validating against it accepted
 * `{passed: 9, total: 3}`, the exact shape the Zod validator rejects and the exact
 * shape that produced a confident `delta: -8`. The invariant was not enforced OR
 * mentioned, which is worse than unenforced: a consumer reading the schema had no
 * way to learn the check existed.
 *
 * JSON Schema cannot close the gap. No draft can compare one property against
 * another (`maximum` takes a number, not a pointer; `if`/`then` can only test a
 * value, not a relation), and the Ajv `$data` extension that could is not portable
 * — a plain Ajv without `$data: true` FAILS TO COMPILE a schema containing it,
 * which would break every conforming consumer to serve one. So the published
 * schema records the constraint and says plainly that it is on the consumer to
 * check, rather than pretending to enforce it.
 */
const SUMMARY_INVARIANT_MESSAGE = 'summary.passed must not exceed summary.total';

const SUMMARY_SCHEMA_DESCRIPTION =
  'Aggregate pass/fail counts. INVARIANT: ' +
  `${SUMMARY_INVARIANT_MESSAGE}. It is enforced by the Zod schema this document is generated from ` +
  'and by vat when it merges grader fragments, but NOT by this document: JSON Schema cannot express ' +
  'a comparison between two properties in any draft, so a validator running this schema alone will ' +
  'accept {"passed": 9, "total": 3}. Check it yourself before trusting any figure derived from these ' +
  'counts (a baseline delta subtracts them).';

/**
 * Aggregate pass/fail counts. `failed`/`pass_rate` are documented but optional.
 * Counts are non-negative integers (a float or negative count is a grader bug),
 * and `passed` can never exceed `total` — see {@link SUMMARY_SCHEMA_DESCRIPTION}
 * for why that last one has to be stated twice.
 */
export const GradingSummarySchema = z
  .object({
    passed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative().optional(),
    pass_rate: z.number().optional(),
  })
  .passthrough()
  .refine(s => s.passed <= s.total, {
    message: SUMMARY_INVARIANT_MESSAGE,
  })
  // `.describe()` AFTER `.refine()`: zodToJsonSchema reads the description off the
  // outermost node, and this is the only channel through which a Zod refinement's
  // meaning can reach the emitted document at all.
  .describe(SUMMARY_SCHEMA_DESCRIPTION);

export type GradingSummary = z.infer<typeof GradingSummarySchema>;

/**
 * The full grading.json contract. Required: top-level `expectations[]` and
 * `summary`. Everything else passes through untouched (forward-compatible with
 * skill-creator additions).
 */
export const GradingReportSchema = z
  .object({
    expectations: z.array(GradedExpectationSchema),
    summary: GradingSummarySchema,
    /**
     * Per-run integrity nonce each grader is told to copy verbatim from its
     * prompt into its fragment (see grader-prompt.ts). Optional in the schema (a
     * grading.json validated by external tooling need not carry it), but the
     * harness REQUIRES every merged fragment's nonce to match the run's secret
     * nonce before trusting the verdict — this is how a forged fragment written
     * by untrusted skill code is rejected.
     */
    runNonce: z.string().optional(),
    /**
     * Which `--baseline` arm produced this report: `'with'` (the skill declared)
     * or `'without'` (the control arm run with the skill withheld). vat writes
     * the two arms to two files of the SAME shape — `grading.json` and
     * `baseline.json` — so without this field a reader holding one of them
     * cannot tell which arm it is looking at. Optional for the same reason
     * `runNonce` is: an externally produced grading.json has no arm to declare.
     */
    arm: z.enum(['with', 'without']).optional(),
  })
  .passthrough();

export type GradingReport = z.infer<typeof GradingReportSchema>;

/**
 * Published JSON Schema for grading.json — generated from {@link GradingReportSchema},
 * so its SHAPE (fields, types, required-ness, additionalProperties) cannot drift from
 * the Zod schema. Importable by external tooling that wants to validate a grading.json
 * without depending on Zod. Documented in docs/skill-test-grading-schema.md.
 *
 * It is NOT equivalent to the Zod schema, and never can be. `zodToJsonSchema` drops
 * every `.refine()`, and the two refinements in this file are cross-field relations
 * JSON Schema has no way to express — so the generated document is strictly weaker
 * than the validator that generated it. That gap is stated, in the document itself,
 * on the field it applies to (see {@link SUMMARY_SCHEMA_DESCRIPTION}); a consumer
 * that needs the invariant enforced must re-implement it or use the Zod schema.
 */
export const GradingReportJsonSchema = zodToJsonSchema(GradingReportSchema, 'grading-report');
