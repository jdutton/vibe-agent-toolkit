import { describe, expect, it } from 'vitest';

import { validateFrontmatter } from '../src/frontmatter-validator.js';

describe('validateFrontmatter', () => {
  const simpleSchema = {
    type: 'object',
    required: ['title', 'description'],
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
  };

  it('should return no issues for valid frontmatter', () => {
    const frontmatter = {
      title: 'Test Doc',
      description: 'A test document',
      tags: ['test'],
    };

    const issues = validateFrontmatter(frontmatter, simpleSchema, '/test.md');

    expect(issues).toHaveLength(0);
  });

  it('should return error for missing required field', () => {
    const frontmatter = {
      title: 'Test Doc',
      // missing description
    };

    const issues = validateFrontmatter(frontmatter, simpleSchema, '/test.md');

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('frontmatter_schema_error');
    expect(issues[0]?.message).toContain('description');
  });

  it('should return error for missing frontmatter when schema requires fields', () => {
    const issues = validateFrontmatter(undefined, simpleSchema, '/test.md');

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('frontmatter_missing');
    expect(issues[0]?.message).toContain('title');
    expect(issues[0]?.message).toContain('description');
  });

  it('should allow extra fields by default', () => {
    const frontmatter = {
      title: 'Test Doc',
      description: 'A test document',
      customField: 'custom value',
      anotherField: 123,
    };

    const issues = validateFrontmatter(frontmatter, simpleSchema, '/test.md');

    expect(issues).toHaveLength(0);
  });

  it('should return no error for missing frontmatter when no required fields', () => {
    const schemaNoRequired = {
      type: 'object',
      properties: {
        title: { type: 'string' },
      },
    };

    const issues = validateFrontmatter(undefined, schemaNoRequired, '/test.md');

    expect(issues).toHaveLength(0);
  });

  it('should validate type constraints', () => {
    const frontmatter = {
      title: 'Test Doc',
      description: 123, // wrong type
    };

    const issues = validateFrontmatter(frontmatter, simpleSchema, '/test.md');

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('description');
    expect(issues[0]?.message).toContain('string');
  });
});
