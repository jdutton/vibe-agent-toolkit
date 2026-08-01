import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateFrontmatter } from '../src/frontmatter-validator.js';

/** Shared so the format token and the fixture path each appear once. */
const URI_REFERENCE = 'uri-reference';
const SPEC_PATH = '/docs/specs/design.md';

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
          ref: { type: 'string', format: URI_REFERENCE },
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
          ref: { type: 'string', format: URI_REFERENCE },
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

  describe('JSON Schema dialects', () => {
    // A collection's frontmatterSchema is arbitrary EXTERNAL input, and Ajv ships
    // one class per dialect family — the default export carries only draft-07 and
    // older meta-schemas. A schema declaring the current standard failed to compile
    // at all, surfacing as FRONTMATTER_SCHEMA_ERROR at error severity for EVERY
    // file in the collection ("no schema with key or ref .../draft/2020-12/schema"),
    // whose implied remediation — fix your schema — was wrong: the schema was valid
    // and VAT could not read it.
    const citationSchema = (dialect?: string): Record<string, unknown> => ({
      ...(dialect === undefined ? {} : { $schema: dialect }),
      type: 'object',
      properties: {
        adrs_cited: {
          type: 'array',
          items: { type: 'string', format: URI_REFERENCE },
        },
      },
    });

    const validCitations = { adrs_cited: ['/docs/adrs/boundary.md'] };

    it.each([
      ['draft 2020-12', 'https://json-schema.org/draft/2020-12/schema'],
      ['draft 2020-12 over http', 'http://json-schema.org/draft/2020-12/schema'],
      ['draft 2019-09', 'https://json-schema.org/draft/2019-09/schema'],
      ['draft-07', 'http://json-schema.org/draft-07/schema#'],
    ])('compiles a schema declaring %s', (_label, dialect) => {
      const issues = validateFrontmatter(
        validCitations,
        citationSchema(dialect),
        SPEC_PATH,
        'permissive',
        '/schemas/spec-links.schema.json'
      );

      expect(issues).toEqual([]);
    });

    it('compiles a schema declaring no $schema at all', () => {
      const issues = validateFrontmatter(
        validCitations,
        citationSchema(),
        SPEC_PATH,
        'permissive'
      );

      expect(issues).toEqual([]);
    });

    it('still reports real violations under a 2020-12 schema', () => {
      // Guards the fix from passing by disabling validation: selecting a different
      // Ajv build must not stop the schema's own rules from being enforced.
      const issues = validateFrontmatter(
        { adrs_cited: 'not-an-array' },
        citationSchema('https://json-schema.org/draft/2020-12/schema'),
        SPEC_PATH,
        'permissive'
      );

      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe('FRONTMATTER_SCHEMA_ERROR');
      expect(issues[0]?.message).toContain('adrs_cited');
    });
  });
});
