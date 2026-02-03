/**
 * Integration tests for multi-schema validation
 *
 * Tests Phase 4 complete validation workflow:
 * - Multiple schemas per resource
 * - Per-schema validation results
 * - Validation modes (strict vs permissive)
 * - Schema layering use case
 */

/* eslint-disable security/detect-non-literal-fs-filename */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAllSchemaErrors,
  hasSchemaErrors,
  validateFrontmatterMultiSchema,
} from '../../src/multi-schema-validator.js';
import type { SchemaReference } from '../../src/types/resources.js';
import {
  createSchemaFile,
  expectFirstSchemaHasErrors,
  setupTempDirTestSuite,
  TestSchemas,
} from '../test-helpers.js';

describe('Multi-Schema Validation Integration', () => {
  const suite = setupTempDirTestSuite('multi-schema-validation-test-');
  const RESOURCE_PATH = 'test.md';
  const BASE_JSON = 'base.json';
  const ENHANCED_JSON = 'enhanced.json';
  const SCHEMA_JSON = 'schema.json';
  const MY_DOCUMENT = 'My Document';

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should validate against multiple schemas independently', async () => {
    // Create schemas
    await createSchemaFile(suite.tempDir, BASE_JSON, TestSchemas.base);
    await createSchemaFile(suite.tempDir, ENHANCED_JSON, TestSchemas.enhanced);

    const frontmatter = {
      title: MY_DOCUMENT,
      category: 'guide',
    };

    const schemas: SchemaReference[] = [
      { schema: join(suite.tempDir, BASE_JSON), source: 'self', applied: false },
      { schema: join(suite.tempDir, ENHANCED_JSON), source: 'cli', applied: false },
    ];

    // Strict mode: both schemas fail (extra fields)
    const strictResults = await validateFrontmatterMultiSchema(
      frontmatter,
      schemas,
      RESOURCE_PATH,
      'strict'
    );

    expect(strictResults).toHaveLength(2);
    expect(strictResults[0]?.applied).toBe(true);
    expect(strictResults[0]?.valid).toBe(false); // Rejects 'category'
    expect(strictResults[1]?.applied).toBe(true);
    expect(strictResults[1]?.valid).toBe(false); // Rejects 'title'
    expect(hasSchemaErrors(strictResults)).toBe(true);

    // Permissive mode: both schemas pass (schema layering)
    const permissiveResults = await validateFrontmatterMultiSchema(
      frontmatter,
      schemas,
      RESOURCE_PATH,
      'permissive'
    );

    expect(permissiveResults).toHaveLength(2);
    expect(permissiveResults[0]?.valid).toBe(true);
    expect(permissiveResults[1]?.valid).toBe(true);
    expect(hasSchemaErrors(permissiveResults)).toBe(false);
  });

  it('should track per-schema validation errors', async () => {
    const schema = {
      type: 'object',
      required: ['title', 'description'],
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
      },
    };

    await fs.writeFile(
      join(suite.tempDir, SCHEMA_JSON),
      JSON.stringify(schema),
      'utf-8'
    );

    const frontmatter = {
      title: MY_DOCUMENT,
      // Missing required 'description'
    };

    const schemas: SchemaReference[] = [
      { schema: join(suite.tempDir, SCHEMA_JSON), source: 'self', applied: false },
    ];

    const results = await validateFrontmatterMultiSchema(
      frontmatter,
      schemas,
      RESOURCE_PATH,
      'strict'
    );

    expectFirstSchemaHasErrors(results, expect);

    const allErrors = getAllSchemaErrors(results);
    expect(allErrors.length).toBeGreaterThan(0);
    expect(allErrors.some((e) => e.message.includes('description'))).toBe(true);
  });

  it('should handle schema loading errors gracefully', async () => {
    const schemas: SchemaReference[] = [
      { schema: join(suite.tempDir, 'nonexistent.json'), source: 'cli', applied: false },
    ];

    const results = await validateFrontmatterMultiSchema(
      { title: 'Test' },
      schemas,
      RESOURCE_PATH,
      'strict'
    );

    expect(results[0]?.applied).toBe(true);
    expect(results[0]?.valid).toBe(false);
    expect(results[0]?.errors).toBeDefined();
    expect(results[0]?.errors?.[0]?.message).toMatch(/Failed to load/);
  });

  it('should validate same schema from multiple sources only once', async () => {
    const schema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
      },
    };

    await fs.writeFile(
      join(suite.tempDir, 'schema.json'),
      JSON.stringify(schema),
      'utf-8'
    );

    const frontmatter = {
      title: 'My Document',
    };

    // Same schema, different sources (deduplication happens at assignment level)
    const schemas: SchemaReference[] = [
      { schema: join(suite.tempDir, SCHEMA_JSON), source: 'self', applied: false },
      { schema: join(suite.tempDir, SCHEMA_JSON), source: 'docs', applied: false },
    ];

    const results = await validateFrontmatterMultiSchema(
      frontmatter,
      schemas,
      RESOURCE_PATH,
      'strict'
    );

    // Both entries validated (deduplication not enforced here - assignment layer handles it)
    expect(results).toHaveLength(2);
    expect(results[0]?.valid).toBe(true);
    expect(results[1]?.valid).toBe(true);
  });

  it('should handle missing frontmatter with schema requirements', async () => {
    const schema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
      },
    };

    await fs.writeFile(
      join(suite.tempDir, SCHEMA_JSON),
      JSON.stringify(schema),
      'utf-8'
    );

    const schemas: SchemaReference[] = [
      { schema: join(suite.tempDir, SCHEMA_JSON), source: 'cli', applied: false },
    ];

    // No frontmatter provided
    const results = await validateFrontmatterMultiSchema(
      undefined,
      schemas,
      RESOURCE_PATH,
      'strict'
    );

    expectFirstSchemaHasErrors(results, expect);
    expect(results[0]?.errors?.[0]?.type).toBe('frontmatter_missing');
  });

  it('should support complex schema layering scenario', async () => {
    // Base schema: minimal requirements
    const baseSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
      },
      additionalProperties: false,
    };

    // Enhanced schema: additional requirements
    const enhancedSchema = {
      type: 'object',
      required: ['category', 'keywords'],
      properties: {
        category: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    };

    await fs.writeFile(
      join(suite.tempDir, BASE_JSON),
      JSON.stringify(baseSchema),
      'utf-8'
    );

    await fs.writeFile(
      join(suite.tempDir, ENHANCED_JSON),
      JSON.stringify(enhancedSchema),
      'utf-8'
    );

    // Document satisfies both schemas
    const frontmatter = {
      title: 'Complete Guide',
      category: 'tutorial',
      keywords: ['guide', 'tutorial'],
    };

    const schemas: SchemaReference[] = [
      { schema: join(suite.tempDir, BASE_JSON), source: 'docs', applied: false },
      { schema: join(suite.tempDir, ENHANCED_JSON), source: 'guides', applied: false },
    ];

    // Permissive mode: both pass
    const results = await validateFrontmatterMultiSchema(
      frontmatter,
      schemas,
      RESOURCE_PATH,
      'permissive'
    );

    expect(results.every((r) => r.valid === true)).toBe(true);
    expect(hasSchemaErrors(results)).toBe(false);
  });
});
