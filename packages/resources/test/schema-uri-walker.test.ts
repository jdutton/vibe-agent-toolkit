/* eslint-disable sonarjs/no-duplicate-string */
import { describe, expect, it } from 'vitest';

import {
  walkFrontmatterUriReferences,
  type FrontmatterUriCapture,
} from '../src/schema-uri-walker.js';

function shape(c: FrontmatterUriCapture[]): Array<[string, string, string]> {
  return c.map((x) => [x.dottedPath, x.value, x.format]);
}

// Shared expected output for tests that capture `a` and `b` top-level uri-reference
// values — used by both the composite-keyword and `$ref` tests to assert the same
// outcome from different schema shapes.
const A_B_URI_REF_CAPTURES: Array<[string, string, string]> = [
  ['a', 'docs/a.md', 'uri-reference'],
  ['b', 'docs/b.md', 'uri-reference'],
];
const A_B_DATA = { a: 'docs/a.md', b: 'docs/b.md' };

describe('walkFrontmatterUriReferences', () => {
  it('captures a single top-level uri-reference property', () => {
    const schema = {
      type: 'object',
      properties: { parent: { type: 'string', format: 'uri-reference' } },
    };
    expect(shape(walkFrontmatterUriReferences({ parent: 'docs/parent.md' }, schema))).toEqual([
      ['parent', 'docs/parent.md', 'uri-reference'],
    ]);
  });

  it('returns nothing when value is not a string', () => {
    const schema = {
      type: 'object',
      properties: { parent: { type: 'string', format: 'uri-reference' } },
    };
    // Non-string values are AJV's responsibility; walker stays out of the way.
    expect(walkFrontmatterUriReferences({ parent: 42 }, schema)).toEqual([]);
    expect(walkFrontmatterUriReferences({ parent: true }, schema)).toEqual([]);
    expect(walkFrontmatterUriReferences({ parent: null }, schema)).toEqual([]);
    expect(walkFrontmatterUriReferences({ parent: ['x'] }, schema)).toEqual([]);
    expect(walkFrontmatterUriReferences({ parent: { x: 1 } }, schema)).toEqual([]);
    expect(walkFrontmatterUriReferences({}, schema)).toEqual([]);
  });

  it('walks union type ([string, null]) and skips null values', () => {
    const schema = {
      type: 'object',
      properties: { x: { type: ['string', 'null'], format: 'uri-reference' } },
    };
    expect(walkFrontmatterUriReferences({ x: null }, schema)).toEqual([]);
    expect(shape(walkFrontmatterUriReferences({ x: 'docs/a.md' }, schema))).toEqual([
      ['x', 'docs/a.md', 'uri-reference'],
    ]);
  });

  it('captures all four URI-family formats', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'string', format: 'uri-reference' },
        b: { type: 'string', format: 'uri' },
        c: { type: 'string', format: 'iri-reference' },
        d: { type: 'string', format: 'iri' },
      },
    };
    expect(shape(walkFrontmatterUriReferences(
      { a: 'x', b: 'https://x', c: 'y', d: 'https://y' },
      schema,
    ))).toEqual([
      ['a', 'x', 'uri-reference'],
      ['b', 'https://x', 'uri'],
      ['c', 'y', 'iri-reference'],
      ['d', 'https://y', 'iri'],
    ]);
  });

  it('does NOT capture uri-template or unrelated formats', () => {
    const schema = {
      type: 'object',
      properties: {
        t: { type: 'string', format: 'uri-template' },
        e: { type: 'string', format: 'email' },
        d: { type: 'string', format: 'date' },
        n: { type: 'string' },
      },
    };
    expect(walkFrontmatterUriReferences(
      { t: '/users/{id}', e: 'a@b.c', d: '2026-01-01', n: 'hi' },
      schema,
    )).toEqual([]);
  });

  it('recurses into nested properties', () => {
    const schema = {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: { source: { type: 'string', format: 'uri-reference' } },
        },
      },
    };
    expect(shape(walkFrontmatterUriReferences(
      { meta: { source: 'docs/x.md' } },
      schema,
    ))).toEqual([['meta.source', 'docs/x.md', 'uri-reference']]);
  });

  it('walks homogeneous arrays', () => {
    const schema = {
      type: 'object',
      properties: {
        artifacts: { type: 'array', items: { type: 'string', format: 'uri-reference' } },
      },
    };
    expect(shape(walkFrontmatterUriReferences(
      { artifacts: ['docs/a.md', 'docs/b.md'] },
      schema,
    ))).toEqual([
      ['artifacts[0]', 'docs/a.md', 'uri-reference'],
      ['artifacts[1]', 'docs/b.md', 'uri-reference'],
    ]);
  });

  it('walks array of objects with uri-reference inside', () => {
    const schema = {
      type: 'object',
      properties: {
        citations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              adr: { type: 'string', format: 'uri-reference' },
              note: { type: 'string' },
            },
          },
        },
      },
    };
    expect(shape(walkFrontmatterUriReferences({
      citations: [
        { adr: 'docs/adr/0001.md', note: 'init' },
        { adr: 'docs/adr/0007.md#decision' },
      ],
    }, schema))).toEqual([
      ['citations[0].adr', 'docs/adr/0001.md', 'uri-reference'],
      ['citations[1].adr', 'docs/adr/0007.md#decision', 'uri-reference'],
    ]);
  });

  it('walks tuple-form items', () => {
    const schema = {
      type: 'object',
      properties: {
        pair: {
          type: 'array',
          items: [
            { type: 'string', format: 'uri-reference' },
            { type: 'string' },
          ],
        },
      },
    };
    expect(shape(walkFrontmatterUriReferences(
      { pair: ['docs/a.md', 'literal'] },
      schema,
    ))).toEqual([['pair[0]', 'docs/a.md', 'uri-reference']]);
  });

  it('walks oneOf branches AND sibling properties (AND semantics)', () => {
    // C1: composite keywords must not short-circuit sibling keywords.
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'string', format: 'uri-reference' },
        b: {
          oneOf: [{ type: 'string', format: 'uri-reference' }],
        },
      },
    };
    expect(shape(walkFrontmatterUriReferences(A_B_DATA, schema))).toEqual(A_B_URI_REF_CAPTURES);
  });

  it('walks all branches of oneOf / anyOf / allOf', () => {
    const schema = {
      type: 'object',
      properties: {
        ref: {
          oneOf: [
            { type: 'string', format: 'uri-reference' },
            { type: 'object', properties: { href: { type: 'string', format: 'uri-reference' } } },
          ],
        },
      },
    };
    // Branch 1
    expect(shape(walkFrontmatterUriReferences({ ref: 'docs/x.md' }, schema))).toEqual([
      ['ref', 'docs/x.md', 'uri-reference'],
    ]);
    // Branch 2
    expect(shape(walkFrontmatterUriReferences({ ref: { href: 'docs/y.md' } }, schema))).toEqual([
      ['ref.href', 'docs/y.md', 'uri-reference'],
    ]);
  });

  it('deduplicates captures when multiple branches match the same (pointer, value)', () => {
    // C2: two branches both classify the same string as uri-reference.
    const schema = {
      type: 'object',
      properties: {
        ref: {
          anyOf: [
            { type: 'string', format: 'uri-reference' },
            { type: 'string', format: 'uri-reference', minLength: 1 },
          ],
        },
      },
    };
    expect(shape(walkFrontmatterUriReferences({ ref: 'docs/x.md' }, schema))).toEqual([
      ['ref', 'docs/x.md', 'uri-reference'],
    ]);
  });

  it('resolves $ref against schema root ($defs)', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/MdRef' },
        b: { $ref: '#/$defs/MdRef' },
      },
      $defs: { MdRef: { type: 'string', format: 'uri-reference' } },
    };
    expect(shape(walkFrontmatterUriReferences(A_B_DATA, schema))).toEqual(A_B_URI_REF_CAPTURES);
  });

  it('resolves $ref against schema root (definitions, draft-04/06)', () => {
    // H6: legacy definitions key, common in draft-04/06 schemas.
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/definitions/MdRef' } },
      definitions: { MdRef: { type: 'string', format: 'uri-reference' } },
    };
    expect(shape(walkFrontmatterUriReferences({ a: 'docs/a.md' }, schema))).toEqual([
      ['a', 'docs/a.md', 'uri-reference'],
    ]);
  });

  it('resolves chained $ref ($ref -> $ref)', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/Alias' } },
      $defs: {
        Alias: { $ref: '#/$defs/MdRef' },
        MdRef: { type: 'string', format: 'uri-reference' },
      },
    };
    expect(shape(walkFrontmatterUriReferences({ a: 'docs/a.md' }, schema))).toEqual([
      ['a', 'docs/a.md', 'uri-reference'],
    ]);
  });

  it('does not crash on cyclic $ref', () => {
    // H3: cycle protection via visited-set on recursion stack.
    const schema = {
      type: 'object',
      properties: { x: { $ref: '#/$defs/Node' } },
      $defs: {
        Node: {
          oneOf: [
            { $ref: '#/$defs/Node' },
            { type: 'string', format: 'uri-reference' },
          ],
        },
      },
    };
    expect(shape(walkFrontmatterUriReferences({ x: 'docs/a.md' }, schema))).toEqual([
      ['x', 'docs/a.md', 'uri-reference'],
    ]);
  });

  it('escapes special characters in property names per RFC 6901', () => {
    const schema = {
      type: 'object',
      properties: { 'a/b': { type: 'string', format: 'uri-reference' } },
    };
    const result = walkFrontmatterUriReferences({ 'a/b': 'docs/x.md' }, schema);
    expect(result).toHaveLength(1);
    expect(result[0]?.pointer).toBe('/a~1b');
    expect(result[0]?.dottedPath).toBe('a/b');
  });

  it('handles unresolvable $ref gracefully (no capture, no throw)', () => {
    const schema = {
      type: 'object',
      properties: { x: { $ref: '#/$defs/Missing' } },
    };
    expect(walkFrontmatterUriReferences({ x: 'docs/a.md' }, schema)).toEqual([]);
  });

  it('skips when frontmatter is undefined', () => {
    const schema = {
      type: 'object',
      properties: { x: { type: 'string', format: 'uri-reference' } },
    };
    expect(walkFrontmatterUriReferences(undefined, schema)).toEqual([]);
  });
});
