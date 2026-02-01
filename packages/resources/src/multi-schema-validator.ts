/**
 * Multi-schema validation for resources
 *
 * Validates a resource against multiple schemas from different sources,
 * tracking validation results per schema.
 *
 * Supports validation modes:
 * - strict: Enforce schema exactly (respect additionalProperties: false)
 * - permissive: Allow extra fields (schema layering use case)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { validateFrontmatter } from './frontmatter-validator.js';
import type { ValidationMode } from './schemas/project-config.js';
import type { ValidationIssue } from './schemas/validation-result.js';
import type { SchemaReference } from './types/resources.js';

/**
 * Load a JSON Schema from a file path
 *
 * @param schemaPath - Path to JSON Schema file
 * @param projectRoot - Optional project root for resolving relative paths
 * @returns Parsed JSON Schema object
 */
async function loadSchema(schemaPath: string, projectRoot?: string): Promise<object> {
  let resolvedPath = schemaPath;

  // If path is relative and we have a project root, resolve it
  if (!path.isAbsolute(schemaPath) && projectRoot) {
    resolvedPath = path.join(projectRoot, schemaPath);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const content = await fs.readFile(resolvedPath, 'utf-8');
  return JSON.parse(content) as object;
}

/**
 * Validate frontmatter against multiple schemas
 *
 * Each schema is validated independently and results are tracked separately.
 * The resource-level validation status: fails if ANY schema fails.
 *
 * @param frontmatter - Parsed frontmatter object (or undefined if no frontmatter)
 * @param schemas - Schema references to validate against
 * @param resourcePath - File path for error reporting
 * @param mode - Validation mode (strict or permissive)
 * @param projectRoot - Optional project root for resolving relative schema paths
 * @returns Updated schema references with validation results
 */
export async function validateFrontmatterMultiSchema(
  frontmatter: Record<string, unknown> | undefined,
  schemas: SchemaReference[],
  resourcePath: string,
  mode: ValidationMode,
  projectRoot?: string,
): Promise<SchemaReference[]> {
  const results: SchemaReference[] = [];

  for (const schemaRef of schemas) {
    try {
      // Load schema
      const schema = await loadSchema(schemaRef.schema, projectRoot);

      // Validate frontmatter
      const issues = validateFrontmatter(frontmatter, schema, resourcePath, mode);

      // Update schema reference with results
      const result: SchemaReference = {
        ...schemaRef,
        applied: true,
        valid: issues.length === 0,
      };

      // Only set errors if there are any (exactOptionalPropertyTypes)
      if (issues.length > 0) {
        result.errors = issues;
      }

      results.push(result);
    } catch (error) {
      // Schema loading or validation failed
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        ...schemaRef,
        applied: true,
        valid: false,
        errors: [{
          severity: 'error',
          resourcePath,
          line: 1,
          type: 'frontmatter_schema_error',
          link: '',
          message: `Failed to load or validate schema ${schemaRef.schema}: ${message}`,
        }],
      });
    }
  }

  return results;
}

/**
 * Check if any schema validation failed
 *
 * @param schemas - Schema references with validation results
 * @returns True if any schema failed validation
 */
export function hasSchemaErrors(schemas: SchemaReference[]): boolean {
  return schemas.some((ref) => ref.valid === false);
}

/**
 * Get all validation errors from all schemas
 *
 * @param schemas - Schema references with validation results
 * @returns Flat array of all validation issues
 */
export function getAllSchemaErrors(schemas: SchemaReference[]): ValidationIssue[] {
  const allErrors: ValidationIssue[] = [];
  for (const ref of schemas) {
    if (ref.errors) {
      allErrors.push(...ref.errors);
    }
  }
  return allErrors;
}
