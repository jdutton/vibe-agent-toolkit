import { z } from 'zod';

/**
 * Severity level for validation issues.
 *
 * - `error`: Critical issue that should block usage (e.g., broken file link)
 * - `warning`: Non-critical issue that should be addressed (e.g., questionable link format)
 * - `info`: Informational message (e.g., external URL not validated)
 */
export const ValidationSeveritySchema = z.enum([
  'error',
  'warning',
  'info',
]).describe('Severity level for validation issues');

export type ValidationSeverity = z.infer<typeof ValidationSeveritySchema>;

/**
 * A single validation issue found during link validation.
 *
 * Includes details about what went wrong, where it occurred, and optionally
 * how to fix it.
 */
export const ValidationIssueSchema = z.object({
  severity: ValidationSeveritySchema.describe('Issue severity level'),
  resourcePath: z.string().describe('Absolute path to the resource containing the issue'),
  line: z.number().int().positive().optional().describe('Line number where the issue occurs'),
  type: z.string().describe('Issue type identifier (e.g., "broken_file", "broken_anchor", "external_url")'),
  link: z.string().describe('The problematic link'),
  message: z.string().describe('Human-readable description of the issue'),
  suggestion: z.string().optional().describe('Optional suggestion for fixing the issue'),
}).describe('A single validation issue found during link validation');

export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/**
 * Complete results from validating a collection of resources.
 *
 * Provides summary statistics, detailed issues, and validation metadata.
 * The `passed` field indicates whether validation succeeded (no errors).
 */
export const ValidationResultSchema = z.object({
  totalResources: z.number().int().nonnegative().describe('Total number of resources validated'),
  totalLinks: z.number().int().nonnegative().describe('Total number of links found across all resources'),
  linksByType: z.record(z.string(), z.number().int().nonnegative()).describe('Count of links by type (e.g., {"local_file": 10, "external": 5})'),
  issues: z.array(ValidationIssueSchema).describe('All validation issues found'),
  errorCount: z.number().int().nonnegative().describe('Number of error-level issues'),
  warningCount: z.number().int().nonnegative().describe('Number of warning-level issues'),
  infoCount: z.number().int().nonnegative().describe('Number of info-level issues'),
  passed: z.boolean().describe('True if validation succeeded (errorCount === 0)'),
  durationMs: z.number().nonnegative().describe('Validation duration in milliseconds'),
  timestamp: z.date().describe('When validation was performed'),
}).describe('Complete results from validating a collection of resources');

export type ValidationResult = z.infer<typeof ValidationResultSchema>;
