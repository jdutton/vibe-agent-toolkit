import { describe, expect, it } from 'vitest';

import { ContentKeySchema, JsonValueSchema, PROJECTION_SCHEMA_VERSION } from '../src/schemas/projection-shared.js';

describe('PROJECTION_SCHEMA_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(PROJECTION_SCHEMA_VERSION)).toBe(true);
    expect(PROJECTION_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});

describe('ContentKeySchema', () => {
  it('accepts a well-formed key', () => {
    expect(ContentKeySchema.safeParse('markdown.' + '0'.repeat(64)).success).toBe(true);
  });

  it('rejects a malformed key', () => {
    expect(ContentKeySchema.safeParse('not-a-key').success).toBe(false);
  });
});

describe('JsonValueSchema', () => {
  it.each([
    ['a string', 'accepted'],
    ['a number', 42],
    ['a boolean', true],
    ['null', null],
    // The exact shape that broke the kb-graph prototype's flat-string frontmatter
    // cache (docs/architecture/resource-projection.md §2): a block-style YAML list.
    ['a flat array', ['a.md', 'b.md']],
    // The exact shape whose nested key clobbered a top-level key of the same
    // name in that prototype: `model: { status: modeled }` next to a top-level
    // `status`.
    ['a nested object', { status: 'modeled' }],
    ['a mixed nested structure', { sources: ['a.md', 'b.md'], model: { status: 'modeled' } }],
  ])('accepts %s', (_label, value) => {
    expect(JsonValueSchema.safeParse(value).success).toBe(true);
  });

  it('rejects a function', () => {
    expect(JsonValueSchema.safeParse(() => 'nope').success).toBe(false);
  });

  it('rejects undefined', () => {
    expect(JsonValueSchema.safeParse(undefined).success).toBe(false);
  });
});
