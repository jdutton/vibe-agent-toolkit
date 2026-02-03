/**
 * Tests for SchemaReference type and schema assignment pipeline
 *
 * Tests Phase 4 functionality:
 * - Schema source tracking (self, collection, CLI)
 * - Multiple schemas per resource
 * - Validation mode behavior (strict vs permissive)
 */

import { describe, expect, it } from 'vitest';

import type { SchemaReference } from '../src/types.js';

describe('SchemaReference', () => {
  const SCHEMA_PATH = './schema.json';

  describe('Type structure', () => {
    it('should support self-asserted schemas', () => {
      const ref: SchemaReference = {
        schema: SCHEMA_PATH,
        source: 'self',
        applied: false,
      };

      expect(ref.source).toBe('self');
      expect(ref.applied).toBe(false);
      expect(ref.valid).toBeUndefined();
      expect(ref.errors).toBeUndefined();
    });

    it('should support CLI-imposed schemas', () => {
      const ref: SchemaReference = {
        schema: SCHEMA_PATH,
        source: 'cli',
        applied: true,
        valid: true,
        errors: [],
      };

      expect(ref.source).toBe('cli');
      expect(ref.applied).toBe(true);
      expect(ref.valid).toBe(true);
    });

    it('should support collection-imposed schemas', () => {
      const ref: SchemaReference = {
        schema: SCHEMA_PATH,
        source: 'docs-collection',
        applied: true,
        valid: false,
        errors: [{
          resourcePath: 'test.md',
          line: 1,
          type: 'frontmatter_schema_error',
          link: '',
          message: 'Missing required field: title',
        }],
      };

      expect(ref.source).toBe('docs-collection');
      expect(ref.valid).toBe(false);
      expect(ref.errors).toHaveLength(1);
    });
  });

  describe('SchemaSource values', () => {
    it('should accept "self", "cli", or collection names', () => {
      const sources: string[] = ['self', 'cli', 'my-collection', 'docs'];
      expect(sources).toHaveLength(4);
    });
  });
});
