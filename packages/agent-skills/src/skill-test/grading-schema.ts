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
  })
  .passthrough();

export type GradedExpectation = z.infer<typeof GradedExpectationSchema>;

/** Aggregate pass/fail counts. `failed`/`pass_rate` are documented but optional. */
export const GradingSummarySchema = z
  .object({
    passed: z.number(),
    total: z.number(),
    failed: z.number().optional(),
    pass_rate: z.number().optional(),
  })
  .passthrough();

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
  })
  .passthrough();

export type GradingReport = z.infer<typeof GradingReportSchema>;

/**
 * Published JSON Schema for grading.json — generated from {@link GradingReportSchema}
 * so the two never drift. Importable by external tooling that wants to validate a
 * grading.json without depending on Zod. Documented in
 * docs/skill-test-grading-schema.md.
 */
export const GradingReportJsonSchema = zodToJsonSchema(GradingReportSchema, 'grading-report');
