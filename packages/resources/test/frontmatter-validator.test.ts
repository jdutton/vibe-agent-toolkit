import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateFrontmatter } from '../src/frontmatter-validator.js';

function expectNoUnknownFormatWarnings(
  warnSpy: ReturnType<typeof vi.spyOn>,
  data: Record<string, unknown>,
  schema: Record<string, unknown>
): void {
  const issues = validateFrontmatter(
    data,
    schema,
    '/test.md',
    'permissive',
    '/s.json'
  );
  expect(issues).toHaveLength(0);

  const unknownFormatCalls = warnSpy.mock.calls.filter((args) =>
    args.some((a) => typeof a === 'string' && a.includes('unknown format'))
  );
  expect(unknownFormatCalls).toEqual([]);
}

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
    expect(issues[0]?.code).toBe('FRONTMATTER_SCHEMA_ERROR');
    expect(issues[0]?.message).toContain('description');
  });

  it('should return error for missing frontmatter when schema requires fields', () => {
    const issues = validateFrontmatter(undefined, simpleSchema, '/test.md');

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('FRONTMATTER_MISSING');
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

  describe('format registration (ajv-formats)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Ajv 8 routes unknown-format messages through self.logger.warn(),
      // which defaults to console. Capturing console.warn is the right
      // observation point.
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
        // intentionally swallow during the test
      });
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('should not log "unknown format" for uri-reference', () => {
      const schema = {
        type: 'object',
        properties: {
          ref: { type: 'string', format: 'uri-reference' },
        },
      };

      expectNoUnknownFormatWarnings(warnSpy, { ref: '/x.md' }, schema);
    });

    it('should not log "unknown format" for common standard formats', () => {
      // Covers the formats VAT's own schemas use. Note: ajv-formats does NOT
      // ship `iri` or `iri-reference` — schemas using those would still warn.
      const schema = {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri' },
          ref: { type: 'string', format: 'uri-reference' },
          when: { type: 'string', format: 'date-time' },
          day: { type: 'string', format: 'date' },
          email: { type: 'string', format: 'email' },
          id: { type: 'string', format: 'uuid' },
        },
      };

      expectNoUnknownFormatWarnings(
        warnSpy,
        {
          url: 'https://example.com',
          ref: '/x.md',
          when: '2026-05-17T00:00:00Z',
          day: '2026-05-17',
          email: 'a@b.com',
          id: '123e4567-e89b-12d3-a456-426614174000',
        },
        schema
      );
    });
  });
});
