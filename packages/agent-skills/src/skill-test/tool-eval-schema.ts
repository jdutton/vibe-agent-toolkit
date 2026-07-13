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
  sequence: z.array(ToolSequenceCheckSchema).optional(),
  /** Overall: mustRun all ran AND mustNotRun none ran AND sequence all satisfied. */
  passed: z.boolean(),
}).strict();

export type ToolVerdictBody = z.infer<typeof ToolVerdictBodySchema>;

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
