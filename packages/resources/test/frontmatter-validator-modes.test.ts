/**
 * Tests for frontmatter validation modes (strict vs permissive)
 *
 * Tests Phase 4 validation mode behavior:
 * - Strict mode: Enforces additionalProperties: false
 * - Permissive mode: Allows extra fields (schema layering)
 */

import { describe, expect, it } from 'vitest';

import { validateFrontmatter } from '../src/frontmatter-validator.js';

describe('Frontmatter Validation Modes', () => {
  const RESOURCE_PATH = 'test.md';
  const TITLE_VALUE = 'My Document';
  const DESCRIPTION_VALUE = 'A test document';
  const TYPE_STRING = 'string';

  const strictSchema = {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: TYPE_STRING },
      description: { type: TYPE_STRING },
    },
    additionalProperties: false,
  };

  const frontmatter = {
    title: TITLE_VALUE,
    description: DESCRIPTION_VALUE,
    extra: 'field',
  };

  describe('Strict mode (default)', () => {
    it('should reject extra fields when additionalProperties: false', () => {
      const issues = validateFrontmatter(frontmatter, strictSchema, RESOURCE_PATH);

      expect(issues).toHaveLength(1);
      expect(issues[0]?.severity).toBe('error');
      expect(issues[0]?.message).toMatch(/additional properties/);
    });

    it('should pass when no extra fields', () => {
      const validFrontmatter = {
        title: TITLE_VALUE,
        description: DESCRIPTION_VALUE,
      };

      const issues = validateFrontmatter(validFrontmatter, strictSchema, RESOURCE_PATH);
      expect(issues).toHaveLength(0);
    });

    it('should enforce required fields', () => {
      const missingRequired = {
        description: DESCRIPTION_VALUE,
        extra: 'field',
      };

      const issues = validateFrontmatter(missingRequired, strictSchema, RESOURCE_PATH);

      // Should have errors for both missing required and extra field
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((i) => i.message.includes('required'))).toBe(true);
    });
  });

  describe('Permissive mode', () => {
    it('should allow extra fields even with additionalProperties: false', () => {
      const issues = validateFrontmatter(frontmatter, strictSchema, RESOURCE_PATH, 'permissive');

      expect(issues).toHaveLength(0);
    });

    it('should still enforce required fields', () => {
      const missingRequired = {
        description: DESCRIPTION_VALUE,
        extra: 'field',
      };

      const issues = validateFrontmatter(missingRequired, strictSchema, RESOURCE_PATH, 'permissive');

      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((i) => i.message.includes('required'))).toBe(true);
    });

    it('should still validate field types', () => {
      const wrongType = {
        title: 123, // Should be string
        description: 'Valid',
      };

      const issues = validateFrontmatter(wrongType, strictSchema, RESOURCE_PATH, 'permissive');

      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((i) => i.message.includes('title'))).toBe(true);
    });

    it('should handle nested objects with additionalProperties: false', () => {
      const nestedSchema = {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          metadata: {
            type: 'object',
            properties: {
              author: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      };

      const nestedFrontmatter = {
        title: TITLE_VALUE,
        metadata: {
          author: 'John Doe',
          extraNested: 'field',
        },
        extraTop: 'field',
      };

      const issues = validateFrontmatter(nestedFrontmatter, nestedSchema, RESOURCE_PATH, 'permissive');

      // Should pass - permissive mode allows extras at all levels
      expect(issues).toHaveLength(0);
    });
  });

  describe('Schema layering use case', () => {
    it('should allow file to satisfy multiple non-overlapping schemas', () => {
      const baseSchema = {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
        },
        additionalProperties: false,
      };

      const enhancedSchema = {
        type: 'object',
        required: ['category'],
        properties: {
          category: { type: 'string' },
        },
        additionalProperties: false,
      };

      const fullFrontmatter = {
        title: TITLE_VALUE,
        category: 'guide',
      };

      // In strict mode, each schema fails due to extra field
      const baseIssuesStrict = validateFrontmatter(fullFrontmatter, baseSchema, RESOURCE_PATH, 'strict');
      expect(baseIssuesStrict.length).toBeGreaterThan(0); // Rejects 'category'

      const enhancedIssuesStrict = validateFrontmatter(fullFrontmatter, enhancedSchema, RESOURCE_PATH, 'strict');
      expect(enhancedIssuesStrict.length).toBeGreaterThan(0); // Rejects 'title'

      // In permissive mode, both schemas pass
      const baseIssuesPermissive = validateFrontmatter(fullFrontmatter, baseSchema, RESOURCE_PATH, 'permissive');
      expect(baseIssuesPermissive).toHaveLength(0);

      const enhancedIssuesPermissive = validateFrontmatter(fullFrontmatter, enhancedSchema, RESOURCE_PATH, 'permissive');
      expect(enhancedIssuesPermissive).toHaveLength(0);
    });
  });
});
