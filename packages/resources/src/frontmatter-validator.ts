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

import { createRegistryIssue, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { issueLocation } from '@vibe-agent-toolkit/utils';
import type { ValidateFunction } from 'ajv';

import { createAjvWithUriFormats } from './ajv-factory.js';
import type { ValidationMode } from './schemas/project-config.js';
import { locationRoot } from './utils.js';

/**
 * A JSON Schema prepared once for repeated frontmatter validation.
 *
 * Ajv compilation is the expensive half of frontmatter validation and its
 * result is reusable: the compiled validator is a pure function of
 * (schema, mode). Callers validating many documents against the same schema —
 * every collection in a project — must compile once via
 * {@link compileFrontmatterSchema} and reuse the result, rather than paying
 * compilation per document.
 */
export interface CompiledFrontmatterSchema {
  /** The schema as supplied by the caller, unmodified. */
  readonly schema: object;
  /** The mode the validator was compiled for. */
  readonly mode: ValidationMode;
  /** Ajv validator for the effective (mode-adjusted) schema. */
  readonly validate: ValidateFunction;
}

/**
 * Compile a JSON Schema for frontmatter validation in the given mode.
 *
 * Permissive mode compiles a clone with `additionalProperties: true`, so the
 * mode is part of the compiled artifact's identity — a cache of compiled
 * schemas must key on (schema source, mode), never on the source alone.
 *
 * @param schema - JSON Schema object
 * @param mode - Validation mode: 'strict' (default) or 'permissive'
 * @returns The compiled schema, reusable across any number of documents
 */
export function compileFrontmatterSchema(
  schema: object,
  mode: ValidationMode = 'strict',
): CompiledFrontmatterSchema {
  // In permissive mode, clone schema and set additionalProperties: true
  const effectiveSchema = mode === 'permissive' ? makeSchemaPermissive(schema) : schema;

  // Use the shared Ajv factory so the internal validator and any adopter
  // consuming `createAjvWithUriFormats` see identical format behavior.
  // Permissive options match how VAT validates user-supplied schemas:
  // - strict: false so non-strict schemas compile (older JSON Schema drafts).
  // - allErrors: true so we report all issues, not just the first.
  // - allowUnionTypes: true for draft-2019-09+ union type support.
  // The effective schema (not the original) picks the build — permissive mode
  // clones it, and the clone must be compiled by the same dialect it declares.
  const ajv = createAjvWithUriFormats(effectiveSchema, {
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
  });

  return { schema, mode, validate: ajv.compile(effectiveSchema) };
}

/**
 * Validate frontmatter against an already-compiled schema.
 *
 * Identical in output to {@link validateFrontmatter}; this is the entry point
 * for callers that validate many documents against one schema.
 *
 * @param frontmatter - Parsed frontmatter object (or undefined if no frontmatter)
 * @param compiled - Result of {@link compileFrontmatterSchema}
 * @param resourcePath - File path for error reporting
 * @param schemaPath - Path to schema file (for error context)
 * @param projectRoot - Project root for computing relative issue locations
 * @returns Array of validation issues (empty if valid)
 */
export function validateCompiledFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
  compiled: CompiledFrontmatterSchema,
  resourcePath: string,
  schemaPath?: string,
  projectRoot?: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { schema, mode, validate } = compiled;

  // Case 1: No frontmatter present
  if (!frontmatter) {
    // Check if schema requires any fields
    const schemaRequires = (schema as { required?: string[] }).required;
    if (schemaRequires && schemaRequires.length > 0) {
      // Build context message with schema path and validation mode
      const schemaContext = schemaPath ? ` (schema: ${schemaPath}, mode: ${mode})` : '';
      const requiredFields = schemaRequires.join(', ');

      issues.push(
        createRegistryIssue(
          'FRONTMATTER_MISSING',
          `No frontmatter found in file. Schema requires: ${requiredFields}${schemaContext}`,
          { location: issueLocation(resourcePath, locationRoot(projectRoot)), line: 1 },
        ),
      );
    }
    return issues;
  }

  // Case 2: Frontmatter present, validate against schema
  const valid = validate(frontmatter);

  if (valid || !validate.errors) {
    return issues;
  }

  // Format validation errors with helpful messages
  for (const error of validate.errors) {
    const message = formatValidationError(error, frontmatter, mode, schemaPath);
    issues.push(
      createRegistryIssue('FRONTMATTER_SCHEMA_ERROR', message, {
        location: issueLocation(resourcePath, locationRoot(projectRoot)),
        line: 1,
      }),
    );
  }

  return issues;
}

/**
 * Validate frontmatter against a JSON Schema, compiling the schema on the spot.
 *
 * One-shot convenience over {@link compileFrontmatterSchema} +
 * {@link validateCompiledFrontmatter}. **Do not call this in a loop over
 * documents sharing a schema** — that recompiles the schema per document. Use
 * the two-step form there instead.
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
 * @param schemaPath - Path to schema file (for error context)
 * @param projectRoot - Project root for computing relative issue locations
 * @returns Array of validation issues (empty if valid)
 *
 * @example
 * ```typescript
 * const schema = {
 *   type: 'object',
 *   required: ['title'],
 *   properties: { title: { type: 'string' } }
 * };
 * const issues = validateFrontmatter(
 *   frontmatter,
 *   schema,
 *   '/docs/guide.md',
 *   'strict',
 *   '/schema.json'
 * );
 * ```
 */
export function validateFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
  schema: object,
  resourcePath: string,
  mode: ValidationMode = 'strict',
  schemaPath?: string,
  projectRoot?: string,
): ValidationIssue[] {
  return validateCompiledFrontmatter(
    frontmatter,
    compileFrontmatterSchema(schema, mode),
    resourcePath,
    schemaPath,
    projectRoot,
  );
}

/**
 * Format AJV validation error into helpful message
 *
 * @param error - AJV error object
 * @param frontmatter - Frontmatter data
 * @param mode - Validation mode (strict/permissive)
 * @param schemaPath - Path to schema file (for error context)
 * @returns Formatted error message
 */
function formatValidationError(
  error: { instancePath: string; keyword: string; message?: string; params?: Record<string, unknown> },
  frontmatter: Record<string, unknown>,
  mode: ValidationMode,
  schemaPath?: string
): string {
  const field = error.instancePath.replace(/^\//, '') || 'root';
  const fieldName = field === 'root' ? '(root)' : field;

  // Get the actual invalid value
  const actualValue = field === 'root' ? frontmatter : getNestedValue(frontmatter, field);
  const actualValueStr = actualValue === undefined ? 'undefined' : JSON.stringify(actualValue);

  let message = `Frontmatter validation failed for '${fieldName}' (got: ${actualValueStr})`;

  // Add context based on error type
  if (error.keyword === 'enum' && error.params?.['allowedValues']) {
    const allowed = (error.params['allowedValues'] as unknown[])
      .map((v: unknown) => JSON.stringify(v))
      .join(', ');
    message += `. Expected one of: ${allowed}`;
  } else if (error.keyword === 'pattern' && error.params?.['pattern']) {
    // Convert to string directly in template to avoid SonarQube warning
    message += `. Must match pattern: ${JSON.stringify(error.params['pattern'])}`;
  } else if (error.keyword === 'type' && error.params?.['type']) {
    // Convert to string directly in template to avoid SonarQube warning
    message += `. Expected type: ${JSON.stringify(error.params['type'])}`;
  } else if (error.keyword === 'required' && error.params?.['missingProperty']) {
    // Convert to string directly in template to avoid SonarQube warning
    message += `. Missing required property: ${JSON.stringify(error.params['missingProperty'])}`;
  } else if (error.message) {
    message += `. ${error.message}`;
  }

  // Add schema context to help users understand the requirement
  const schemaContext = schemaPath ? ` (schema: ${schemaPath}, mode: ${mode})` : '';
  message += schemaContext;

  return message;
}

/**
 * Get nested value from object using dot-separated path
 *
 * @param obj - Object to get value from
 * @param path - Dot-separated path (e.g., "user.name")
 * @returns Value at path or undefined
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  // eslint-disable-next-line local/no-hardcoded-path-split -- JSON Schema instancePath uses forward slashes (not file paths)
  const parts = path.split('/').filter(Boolean);
  let current: unknown = obj;

  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
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
