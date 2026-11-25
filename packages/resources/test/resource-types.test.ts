/**
 * Unit tests for resource type system
 * Tests resource type detection, path normalization, and JSON Schema heuristics
 */

import { describe, expect, it } from 'vitest';

import {
  isJsonSchema,
  ResourceType,
} from '../src/types/resources.js';

describe('ResourceType enum', () => {
  it('should have correct enum values', () => {
    expect(ResourceType.MARKDOWN).toBe('markdown');
    expect(ResourceType.JSON_SCHEMA).toBe('json-schema');
    expect(ResourceType.JSON).toBe('json');
    expect(ResourceType.YAML).toBe('yaml');
  });
});

describe('isJsonSchema', () => {
  describe('when data has 2+ schema keywords', () => {
    it('should detect object with $schema and type', () => {
      const data = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
      };
      expect(isJsonSchema(data)).toBe(true);
    });

    it('should detect object with type and properties', () => {
      const data = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };
      expect(isJsonSchema(data)).toBe(true);
    });

    it('should detect object with title and required', () => {
      const data = {
        title: 'My Schema',
        required: ['name'],
      };
      expect(isJsonSchema(data)).toBe(true);
    });

    it('should detect object with $id and definitions', () => {
      const data = {
        $id: 'https://example.com/schema',
        definitions: {
          user: { type: 'object' },
        },
      };
      expect(isJsonSchema(data)).toBe(true);
    });

    it('should detect object with allOf and description', () => {
      const data = {
        description: 'A composite schema',
        allOf: [{ type: 'string' }],
      };
      expect(isJsonSchema(data)).toBe(true);
    });

    it('should detect object with anyOf and oneOf', () => {
      const data = {
        anyOf: [{ type: 'string' }],
        oneOf: [{ type: 'number' }],
      };
      expect(isJsonSchema(data)).toBe(true);
    });

    it('should detect object with items and enum', () => {
      const data = {
        items: { type: 'string' },
        enum: ['a', 'b', 'c'],
      };
      expect(isJsonSchema(data)).toBe(true);
    });

    it('should detect object with $defs and not', () => {
      const data = {
        $defs: {
          user: { type: 'object' },
        },
        not: { type: 'null' },
      };
      expect(isJsonSchema(data)).toBe(true);
    });
  });

  describe('when data has fewer than 2 schema keywords', () => {
    it('should reject empty object', () => {
      expect(isJsonSchema({})).toBe(false);
    });

    it('should reject object with only one keyword', () => {
      const data = { type: 'object' };
      expect(isJsonSchema(data)).toBe(false);
    });

    it('should reject object with non-schema properties', () => {
      const data = {
        name: 'John',
        age: 30,
        email: 'john@example.com',
      };
      expect(isJsonSchema(data)).toBe(false);
    });

    it('should reject null', () => {
      expect(isJsonSchema(null)).toBe(false);
    });

    it('should reject undefined', () => {
      expect(isJsonSchema(undefined)).toBe(false);
    });

    it('should reject primitive values', () => {
      expect(isJsonSchema('string')).toBe(false);
      expect(isJsonSchema(123)).toBe(false);
      expect(isJsonSchema(true)).toBe(false);
    });

    it('should reject arrays', () => {
      expect(isJsonSchema([])).toBe(false);
      expect(isJsonSchema([{ type: 'object' }])).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should detect schema with exactly 2 keywords', () => {
      const data = { type: 'string', description: 'A string' };
      expect(isJsonSchema(data)).toBe(true);
    });

    it('should detect schema with 3+ keywords', () => {
      const data = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        description: 'User schema',
      };
      expect(isJsonSchema(data)).toBe(true);
    });

    it('should ignore non-keyword properties', () => {
      const data = {
        type: 'object',
        properties: { name: { type: 'string' } },
        customField: 'ignored',
        anotherField: 123,
      };
      expect(isJsonSchema(data)).toBe(true);
    });
  });
});
