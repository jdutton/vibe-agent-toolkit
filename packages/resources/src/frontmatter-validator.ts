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

import type { ValidationMode } from './schemas/project-config.js';
import type { ValidationIssue } from './schemas/validation-result.js';

/**
 * Validate frontmatter against a JSON Schema.
 *
 * Behavior:
 * - Missing frontmatter: Error only if schema has required fields
 * - Extra fields: Allowed by default (unless schema sets additionalProperties: false)
 * - Type mismatches: Always reported as errors
 * - Permissive mode: Ignores additionalProperties: false (allows schema layering)
 *
 * @param frontmatter - Parsed frontmatter object (or undefined if no frontmatter)
 * @param schema - JSON Schema object
 * @param resourcePath - File path for error reporting
 * @param mode - Validation mode: 'strict' (default) or 'permissive'
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
  resourcePath: string,
  mode: ValidationMode = 'strict'
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // In permissive mode, clone schema and set additionalProperties: true
  let effectiveSchema = schema;
  if (mode === 'permissive') {
    effectiveSchema = makeSchemaPermissive(schema);
  }

  // Configure AJV with permissive settings
  const ajv = new Ajv({
    strict: false,           // Allow non-strict schemas
    allErrors: true,         // Report all errors, not just first
    allowUnionTypes: true,   // Support JSON Schema draft features
  });

  const validate = ajv.compile(effectiveSchema);

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

/**
 * Clone schema and recursively set additionalProperties: true
 *
 * Used in permissive mode to allow extra fields for schema layering.
 * Handles nested objects and properties recursively.
 *
 * @param schema - Original JSON Schema
 * @returns Cloned schema with additionalProperties: true
 */
function makeSchemaPermissive(schema: object): object {
  // Deep clone to avoid mutating original
  const cloned = structuredClone(schema) as Record<string, unknown>;

  // Recursively process schema to set additionalProperties: true
  processSchemaRecursively(cloned);

  return cloned;
}

/**
 * Recursively process schema object to set additionalProperties: true
 *
 * @param obj - Schema object or nested schema fragment
 */
function processSchemaRecursively(obj: Record<string, unknown>): void {
  // eslint-disable-next-line sonarjs/different-types-comparison
  if (typeof obj !== 'object' || obj === null) {
    return;
  }

  // Set additionalProperties: true if this is an object schema
  const typeValue = obj['type'];
  const isObjectType = typeValue === 'object';
  const hasProperties = 'properties' in obj;

  if (isObjectType || hasProperties) {
    obj['additionalProperties'] = true;
  }

  // Recurse into properties
  processSchemaProperties(obj);

  // Recurse into nested schemas (allOf, anyOf, oneOf, items)
  processNestedSchemas(obj);
}

/**
 * Process properties field of a schema
 *
 * @param obj - Schema object
 */
function processSchemaProperties(obj: Record<string, unknown>): void {
  if (obj['properties'] === undefined || typeof obj['properties'] !== 'object') {
    return;
  }

  const properties = obj['properties'] as Record<string, unknown>;
  for (const value of Object.values(properties)) {
    if (typeof value === 'object' && value !== null) {
      processSchemaRecursively(value as Record<string, unknown>);
    }
  }
}

/**
 * Process nested schema keywords (allOf, anyOf, oneOf, items)
 *
 * @param obj - Schema object
 */
function processNestedSchemas(obj: Record<string, unknown>): void {
  const nestedKeys = ['allOf', 'anyOf', 'oneOf', 'items'];

  for (const key of nestedKeys) {
    const value = obj[key];
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          processSchemaRecursively(item as Record<string, unknown>);
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      processSchemaRecursively(value as Record<string, unknown>);
    }
  }
}
