import { ValidationIssueSchema } from '@vibe-agent-toolkit/agent-schema';
import { z } from 'zod';

export { type ValidationIssue, ValidationIssueSchema } from '@vibe-agent-toolkit/agent-schema';

/**
 * Complete results from validating a collection of resources.
 *
 * Provides summary statistics, detailed issues, and validation metadata.
 * The `passed` field indicates whether validation succeeded (no issues found).
 */
export const ValidationResultSchema = z.object({
  totalResources: z.number().int().nonnegative().describe('Total number of resources validated'),
  totalLinks: z.number().int().nonnegative().describe('Total number of links found across all resources'),
  linksByType: z.record(z.string(), z.number().int().nonnegative()).describe('Count of links by type (e.g., {"local_file": 10, "external": 5})'),
  issues: z.array(ValidationIssueSchema).describe('Emitted validation issues (allow-filtered + severity-resolved; ignored issues dropped)'),
  errorCount: z.number().int().nonnegative().describe('Number of emitted issues'),
  passed: z.boolean().describe('True if validation succeeded (errorCount === 0)'),
  hasErrors: z.boolean().describe('True when any emitted issue has resolved severity "error"'),
  durationMs: z.number().nonnegative().describe('Validation duration in milliseconds'),
  timestamp: z.date().describe('When validation was performed'),
}).describe('Complete results from validating a collection of resources');

export type ValidationResult = z.infer<typeof ValidationResultSchema>;
