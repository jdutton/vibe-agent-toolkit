import { z } from 'zod';

/**
 * A single validation issue found during link validation.
 *
 * Issue types:
 * - broken_file: Local file link points to non-existent file
 * - broken_anchor: Anchor link points to non-existent heading
 * - frontmatter_missing: Schema requires frontmatter, file has none
 * - frontmatter_invalid_yaml: YAML syntax error in frontmatter
 * - frontmatter_schema_error: Frontmatter fails JSON Schema validation
 * - external_url_dead: External URL returned error status (4xx, 5xx)
 * - external_url_timeout: External URL request timed out
 * - external_url_error: External URL validation failed (DNS, network, etc.)
 * - unknown_link: Unknown link type
 *
 * Includes details about what went wrong, where it occurred, and optionally
 * how to fix it.
 */
export const ValidationIssueSchema = z.object({
  resourcePath: z.string().describe('Absolute path to the resource containing the issue'),
  line: z.number().int().positive().optional().describe('Line number where the issue occurs'),
  type: z.string().describe('Issue type identifier (e.g., "broken_file", "broken_anchor", "frontmatter_schema_error", "unknown_link")'),
  link: z.string().describe('The problematic link'),
  message: z.string().describe('Human-readable description of the issue'),
  suggestion: z.string().optional().describe('Optional suggestion for fixing the issue'),
}).describe('A single validation issue found during link validation');

export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

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
  issues: z.array(ValidationIssueSchema).describe('All validation issues found'),
  errorCount: z.number().int().nonnegative().describe('Number of issues found'),
  passed: z.boolean().describe('True if validation succeeded (errorCount === 0)'),
  durationMs: z.number().nonnegative().describe('Validation duration in milliseconds'),
  timestamp: z.date().describe('When validation was performed'),
}).describe('Complete results from validating a collection of resources');

export type ValidationResult = z.infer<typeof ValidationResultSchema>;
