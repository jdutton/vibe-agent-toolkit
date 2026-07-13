import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * vat-owned tool-expectation channel (issue #145 Phase T, C2). This is
 * DELIBERATELY separate from `grading.json`'s `expectations[]` and from
 * friction's closed category enum (friction-schema.ts): tool verdicts judge
 * declared `toolExpectations` (mustRun/mustNotRun/sequence) against the
 * transcript, which is a distinct concern from prose-expectation grading and
 * from packaging-fidelity friction. Mixing them would make one channel's
 * consumer (e.g. the grading reconciler) have to filter out data it doesn't
 * own.
 */
const ToolRunCheckSchema = z.object({
  name: z.string().min(1),
  ran: z.boolean(),
  evidence: z.string().optional(),
}).strict();

const ToolSequenceCheckSchema = z.object({
  steps: z.array(z.string().min(1)),
  satisfied: z.boolean(),
  evidence: z.string().optional(),
}).strict();

/**
 * A single `mustSucceed` check (feature #148): the named executable must have
 * RUN and its invoking tool_result must NOT be an error. `succeeded` is judged
 * FROM THE TRANSCRIPT (preferring the tool_result `is_error` flag), so a skill
 * that swallows a non-zero exit (e.g. `cmd || true`) can legitimately read as
 * succeeded — this channel judges what the transcript shows, not the real exit.
 */
const ToolSucceedCheckSchema = z.object({
  name: z.string().min(1),
  succeeded: z.boolean(),
  evidence: z.string().optional(),
}).strict();

/**
 * The body of a tool verdict, WITHOUT `evalId`. This is what a per-eval
 * grader fragment carries (`EvalFragment.tool` in eval-fragment.ts) — the
 * fragment already carries `evalId` at its top level, so repeating it inside
 * the `tool` body would be redundant data that could drift from the
 * fragment's own `evalId`. {@link ToolVerdictSchema} re-adds `evalId` for the
 * merged, per-eval-keyed `tool-eval.json` report where there is no
 * surrounding fragment to source it from.
 */
export const ToolVerdictBodySchema = z.object({
  mustRun: z.array(ToolRunCheckSchema).optional(),
  mustNotRun: z.array(ToolRunCheckSchema).optional(),
  mustSucceed: z.array(ToolSucceedCheckSchema).optional(),
  sequence: z.array(ToolSequenceCheckSchema).optional(),
  /**
   * The grader's self-reported overall verdict (mustRun all ran AND mustNotRun
   * none ran AND mustSucceed all succeeded AND sequence all satisfied). vat NEVER
   * trusts this field alone — it is RECOMPUTED from the sub-checks by
   * {@link computeToolPassed} and a grader whose `passed` disagrees with its own
   * sub-checks is rejected as a malfunction (see eval-grader.ts), mirroring
   * `reconcileGrading`'s summary/expectations reconciliation.
   */
  passed: z.boolean(),
}).strict();

export type ToolVerdictBody = z.infer<typeof ToolVerdictBodySchema>;

/**
 * Recompute a tool verdict's overall pass from its sub-checks — the
 * authoritative value vat uses instead of the grader's self-reported `passed`
 * (fail-open fix #3). Pure: every declared `mustRun` ran, every `mustNotRun`
 * did NOT run, every `mustSucceed` succeeded, and every `sequence` was
 * satisfied. An absent or empty sub-array is vacuously true (nothing declared
 * in that channel cannot make the verdict fail).
 */
export function computeToolPassed(body: ToolVerdictBody): boolean {
  const mustRunOk = (body.mustRun ?? []).every((check) => check.ran);
  const mustNotRunOk = (body.mustNotRun ?? []).every((check) => check.ran === false);
  const mustSucceedOk = (body.mustSucceed ?? []).every((check) => check.succeeded);
  const sequenceOk = (body.sequence ?? []).every((check) => check.satisfied);
  return mustRunOk && mustNotRunOk && mustSucceedOk && sequenceOk;
}

/** A single eval's tool verdict, keyed by `evalId` — one entry in {@link ToolEvalReportSchema}. */
export const ToolVerdictSchema = ToolVerdictBodySchema.extend({
  evalId: z.string().min(1),
}).strict();

export type ToolVerdict = z.infer<typeof ToolVerdictSchema>;

/** vat-owned strict tool-eval report — vat's `tool-eval.json` output artifact. */
export const ToolEvalReportSchema = z.object({
  evals: z.array(ToolVerdictSchema),
}).strict();

export type ToolEvalReport = z.infer<typeof ToolEvalReportSchema>;

export const ToolEvalReportJsonSchema = zodToJsonSchema(ToolEvalReportSchema, 'tool-eval-report');
