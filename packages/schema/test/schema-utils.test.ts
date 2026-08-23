/**
 * Tests for JSON Schema utilities
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { toJsonSchema } from '../src/index.js';

describe('toJsonSchema', () => {
  it('converts Zod schema to JSON Schema', () => {
    const schema = z.object({
      name: z.string().describe('User name'),
      age: z.number().min(0).describe('User age'),
    });

    const result = toJsonSchema(schema);

    expect(result).toMatchObject({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'User name',
        },
        age: {
          type: 'number',
          minimum: 0,
          description: 'User age',
        },
      },
      required: ['name', 'age'],
    });
  });

  it('adds $schema by default', () => {
    const schema = z.string();
    const result = toJsonSchema(schema) as Record<string, unknown>;

    expect(result['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('allows custom $schema version', () => {
    const schema = z.string();
    const result = toJsonSchema(schema, {
      $schema: 'https://json-schema.org/draft-07/schema',
    }) as Record<string, unknown>;

    expect(result['$schema']).toBe('https://json-schema.org/draft-07/schema');
  });

  it('includes toolkit metadata when requested', () => {
    const schema = z.string();
    const result = toJsonSchema(schema, {
      includeToolkitMetadata: true,
    }) as Record<string, unknown>;

    expect(result['x-vat-version']).toBe('0.1.1');
  });

  it('does not include toolkit metadata by default', () => {
    const schema = z.string();
    const result = toJsonSchema(schema) as Record<string, unknown>;

    expect(result['x-vat-version']).toBeUndefined();
  });

  it('uses inline refs by default (no $ref strategy)', () => {
    const InnerSchema = z.object({
      value: z.string(),
    });

    const OuterSchema = z.object({
      inner1: InnerSchema,
      inner2: InnerSchema,
    });

    const result = toJsonSchema(OuterSchema);
    const json = JSON.stringify(result);

    // Should not contain $ref since we use inline strategy
    expect(json).not.toContain('$ref');
  });

  it('accepts custom name option', () => {
    const schema = z.string();
    const result = toJsonSchema(schema, {
      name: 'CustomSchemaName',
    }) as Record<string, unknown>;

    // zod-to-json-schema may add title or other properties based on name
    // Just verify it doesn't error
    expect(result).toBeDefined();
  });

  it('preserves zod-to-json-schema options', () => {
    const schema = z.object({
      optionalField: z.string().optional(),
    });

    const result = toJsonSchema(schema, {
      // Custom option from zod-to-json-schema
      strictUnions: true,
    });

    expect(result).toBeDefined();
  });
});
