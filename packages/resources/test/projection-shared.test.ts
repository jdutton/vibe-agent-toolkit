import { describe, expect, it } from 'vitest';

import * as projectionShared from '../src/schemas/projection-shared.js';
import {
  ContentKeySchema,
  JsonValueSchema,
  ProjectionConditionSeveritySchema,
} from '../src/schemas/projection-shared.js';

describe('the removed contract version', () => {
  it('exports no hand-bumped version constant', () => {
    // An absence pin, not decoration. `PROJECTION_SCHEMA_VERSION` reached 4 by
    // hand and nothing ever branched on it, so every bump was cost without a
    // beneficiary. The pressure to reinstate one arrives with the first STORED
    // projection, and the answer then is a derived digest of the row schemas'
    // shape (as `parseFactsShapeSource()` is for the parse cache) — not this
    // constant back. That is why the guard names the shape rather than the
    // symbol: `PROJECTION_SCHEMA_VERSION_2` would pass a symbol-only check.
    const versionish = Object.keys(projectionShared).filter((name) => /VERSION|REVISION/u.test(name));

    expect(versionish).toStrictEqual([]);
  });
});

describe('ProjectionConditionSeveritySchema', () => {
  it('accepts the three parse/population-time severities', () => {
    for (const severity of ['error', 'warning', 'info']) {
      expect(ProjectionConditionSeveritySchema.safeParse(severity).success).toBe(true);
    }
  });

  it('rejects "ignore" — a config-resolution state, not a condition severity', () => {
    expect(ProjectionConditionSeveritySchema.safeParse('ignore').success).toBe(false);
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
