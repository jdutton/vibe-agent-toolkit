import { z } from 'zod';

export const SeverityLevelSchema = z.enum(['error', 'warning', 'ignore']);
export type SeverityLevel = z.infer<typeof SeverityLevelSchema>;

export const AllowEntrySchema = z.object({
  paths: z.array(z.string().min(1)).min(1).default(['**/*']),
  reason: z.string().min(1),
  expires: z.string().optional(),
}).strict();
export type AllowEntry = z.infer<typeof AllowEntrySchema>;

export const ValidationConfigSchema = z.object({
  severity: z.record(z.string(), SeverityLevelSchema).optional(),
  allow: z.record(z.string(), z.array(AllowEntrySchema)).optional(),
}).strict();
export type ValidationConfig = z.infer<typeof ValidationConfigSchema>;
