import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Friction severities, most→least actionable. */
export const FrictionSeveritySchema = z.enum(['high', 'medium', 'low']);

/**
 * Closed set of packaging-fidelity friction categories (spec §18). vat owns
 * this enum; the experimenter must emit one of these.
 */
export const FrictionCategorySchema = z.enum([
  'path-assumption',
  'undeclared-dependency',
  'ambient-propping',
  'doc-engine-drift',
  'missing-bundled-file',
]);

export const FrictionItemSchema = z.object({
  severity: FrictionSeveritySchema,
  category: FrictionCategorySchema,
  message: z.string().min(1),
  subjectFile: z.string().min(1).optional(),
  evidence: z.string().min(1).optional(),
}).strict();

export type FrictionItem = z.infer<typeof FrictionItemSchema>;

/** vat-owned strict friction report — the machine-usable primary output. */
export const FrictionReportSchema = z.object({
  items: z.array(FrictionItemSchema),
}).strict();

export type FrictionReport = z.infer<typeof FrictionReportSchema>;

export const FrictionReportJsonSchema = zodToJsonSchema(FrictionReportSchema, 'friction-report');
