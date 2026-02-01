/**
 * Frontmatter validation using JSON Schema.
 *
 * IMPORTANT: This module uses AJV specifically for validating arbitrary
 * user-provided JSON Schemas against frontmatter data. For all TypeScript
 * validation and internal schemas, use Zod instead.
 *
 * Why AJV here?
 * - Users provide standard JSON Schema files for frontmatter validation
 * - AJV is the industry standard JSON Schema validator
 * - Zod is for TypeScript type safety + runtime validation
 *
 * This is the ONLY place in the codebase that should use AJV.
 */

import { Ajv } from 'ajv';

import type { ValidationIssue } from './schemas/validation-result.js';

/**
 * Validate frontmatter against a JSON Schema.
 *
 * Behavior:
 * - Missing frontmatter: Error only if schema has required fields
 * - Extra fields: Allowed by default (unless schema sets additionalProperties: false)
 * - Type mismatches: Always reported as errors
 *
 * @param frontmatter - Parsed frontmatter object (or undefined if no frontmatter)
 * @param schema - JSON Schema object
 * @param resourcePath - File path for error reporting
 * @returns Array of validation issues (empty if valid)
 *
 * @example
 * ```typescript
 * const schema = {
 *   type: 'object',
 *   required: ['title'],
 *   properties: { title: { type: 'string' } }
 * };
 * const issues = validateFrontmatter(frontmatter, schema, '/docs/guide.md');
 * ```
 */
export function validateFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
  schema: object,
  resourcePath: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Configure AJV with permissive settings
  const ajv = new Ajv({
    strict: false,           // Allow non-strict schemas
    allErrors: true,         // Report all errors, not just first
    allowUnionTypes: true,   // Support JSON Schema draft features
  });

  const validate = ajv.compile(schema);

  // Case 1: No frontmatter present
  if (!frontmatter) {
    // Check if schema requires any fields
    const schemaRequires = (schema as { required?: string[] }).required;
    if (schemaRequires && schemaRequires.length > 0) {
      issues.push({
        severity: 'error',
        resourcePath,
        line: 1,
        type: 'frontmatter_missing',
        link: '',
        message: `Missing required frontmatter (schema requires: ${schemaRequires.join(', ')})`,
      });
    }
    return issues;
  }

  // Case 2: Frontmatter present, validate against schema
  const valid = validate(frontmatter);

  if (!valid && validate.errors) {
    for (const error of validate.errors) {
      const field = error.instancePath.replace(/^\//, '') ?? 'root';
      const message = error.message ?? 'validation failed';
      issues.push({
        severity: 'error',
        resourcePath,
        line: 1,
        type: 'frontmatter_schema_error',
        link: '',
        message: `Frontmatter validation: ${field} ${message}`,
      });
    }
  }

  return issues;
}
