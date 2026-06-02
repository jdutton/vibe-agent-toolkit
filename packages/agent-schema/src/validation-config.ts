import { z } from 'zod';

import { IssueCodeSchema } from './validation-codes.js';

export const SeverityLevelSchema = z.enum(['error', 'warning', 'info', 'ignore']);
export type SeverityLevel = z.infer<typeof SeverityLevelSchema>;

export const AllowEntrySchema = z.object({
  paths: z.array(z.string().min(1)).min(1).default(['**/*']),
  reason: z.string().min(1),
  expires: z.string().optional(),
}).strict();
export type AllowEntry = z.infer<typeof AllowEntrySchema>;

export const ValidationConfigSchema = z.object({
  severity: z.record(IssueCodeSchema, SeverityLevelSchema).optional(),
  allow: z.record(IssueCodeSchema, z.array(AllowEntrySchema)).optional(),
}).strict();
export type ValidationConfig = z.infer<typeof ValidationConfigSchema>;
