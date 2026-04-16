import { z } from 'zod';

export const SeverityLevelSchema = z.enum(['error', 'warning', 'ignore']);
export type SeverityLevel = z.infer<typeof SeverityLevelSchema>;

export const AcceptEntrySchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  expires: z.string().optional(),
}).strict();
export type AcceptEntry = z.infer<typeof AcceptEntrySchema>;

export const ValidationConfigSchema = z.object({
  severity: z.record(z.string(), SeverityLevelSchema).optional(),
  accept: z.record(z.string(), z.array(AcceptEntrySchema)).optional(),
}).strict();
export type ValidationConfig = z.infer<typeof ValidationConfigSchema>;
