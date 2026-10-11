import { SeveritySchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Friction severities are the shared report vocabulary (`error|warning|info`) —
 * the one every VAT report speaks, so `friction.json` reads like any other
 * artifact. The GRADER does not: its prompt asks for `high|medium|low` (a
 * model-facing vocabulary that stays private to `grader-prompt.ts`), and
 * `graderSeverityToShared` maps it ONCE, when `eval-fragment.ts` parses the
 * fragment. Nothing downstream of ingestion ever sees `high|medium|low`.
 */
export const FrictionSeveritySchema = SeveritySchema;

/** The severities the grader is asked to answer with (see `grader-prompt.ts`). */
const GraderFrictionSeveritySchema = z.enum(['high', 'medium', 'low']);

type GraderFrictionSeverity = z.infer<typeof GraderFrictionSeveritySchema>;

const GRADER_TO_SHARED: Readonly<Record<GraderFrictionSeverity, z.infer<typeof SeveritySchema>>> = {
  high: 'error',
  medium: 'warning',
  low: 'info',
};

/** The one mapping from the grader's vocabulary to the shared severities. */
function graderSeverityToShared(severity: GraderFrictionSeverity): z.infer<typeof SeveritySchema> {
  return GRADER_TO_SHARED[severity];
}

/**
 * Closed set of packaging-fidelity friction categories (spec §18). vat owns
 * this enum; the grader must emit one of these.
 */
export const FrictionCategorySchema = z.enum([
  'path-assumption',
  'undeclared-dependency',
  'ambient-propping',
  'doc-engine-drift',
  'missing-bundled-file',
  // A declared tool-expectation was not met (e.g. a `mustRun` executable never
  // ran, or a `mustNotRun` one did). The pass/fail verdict lives in
  // tool-eval.json (a separate channel — C2); this category lets the grader
  // ALSO surface the shortfall as human-facing packaging friction when useful.
  'tool-expectation',
]);

export const FrictionItemSchema = z.object({
  severity: FrictionSeveritySchema,
  category: FrictionCategorySchema,
  message: z.string().min(1),
  subjectFile: z.string().min(1).optional(),
  evidence: z.string().min(1).optional(),
}).strict();

export type FrictionItem = z.infer<typeof FrictionItemSchema>;

/**
 * A friction item as the GRADER writes it: same shape, `high|medium|low`
 * severity. Parsing it yields a {@link FrictionItem} with the severity mapped.
 */
export const GraderFrictionItemSchema = FrictionItemSchema.extend({
  severity: GraderFrictionSeveritySchema,
}).transform((item): FrictionItem => ({ ...item, severity: graderSeverityToShared(item.severity) }));

/** vat-owned strict friction report — the machine-usable primary output. */
export const FrictionReportSchema = z.object({
  items: z.array(FrictionItemSchema),
}).strict();

export type FrictionReport = z.infer<typeof FrictionReportSchema>;

export const FrictionReportJsonSchema = zodToJsonSchema(FrictionReportSchema, 'friction-report');
