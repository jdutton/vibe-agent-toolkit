/**
 * `compareRows`: the one canonical row order the export, the run database's hydration and a lens
 * write all insert in. Total — no two distinct rows tie — and typed per column kind.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { compareRows, DERIVED_TABLES, PROJECTION_TABLES } from '../src/index.js';
import { scalarColumn } from '../src/projection/column-kinds.js';

/** The rows sorted by the relation's comparator, from both input orders, which must agree. */
function sortedBothWays(compare: ReturnType<typeof compareRows>, rows: readonly Record<string, unknown>[]): unknown[] {
  const forward = [...rows].sort(compare);
  const backward = [...rows].reverse().sort(compare);
  expect(backward).toStrictEqual(forward);
  return forward;
}

describe('compareRows', () => {
  it('puts null before the empty string in a nullable key column, so the two never tie', () => {
    const compare = compareRows(PROJECTION_TABLES.resourceTags);
    const base = { resourceId: 'r', tag: 't', source: 'frontmatter' };
    const empty = { ...base, value: '' };
    const absent = { ...base, value: null };
    expect(sortedBothWays(compare, [empty, absent])).toStrictEqual([absent, empty]);
  });

  it('breaks a primary-key tie by the remaining columns in registry order', () => {
    // `edges` keys on (src, refOrdinal, contextId); `refOrdinal` is nullable, so two
    // implicit edges from one source in one context tie on the key.
    const compare = compareRows(DERIVED_TABLES.edges);
    const key = { src: 's', refOrdinal: null, contextId: 'c' };
    const first = { ...key, kind: 'a' };
    const second = { ...key, kind: 'b' };
    expect(compare(first, second)).toBeLessThan(0);
    expect(sortedBothWays(compare, [second, first])).toStrictEqual([first, second]);
  });

  it('orders integers by value, not as text', () => {
    const compare = compareRows(PROJECTION_TABLES.blobReferences);
    const at = (ordinal: number): Record<string, unknown> => ({ blob: 'b', ordinal });
    expect(sortedBothWays(compare, [at(10), at(2)])).toStrictEqual([at(2), at(10)]);
  });

  it('orders a timestamp by instant, a boolean false first, and json by its canonical text', () => {
    const compare = compareRows(PROJECTION_TABLES.resourceRealizations);
    const key = { extentId: 'e', path: 'a.md' };
    expect(compare({ ...key, mtime: new Date(2) }, { ...key, mtime: new Date(10) })).toBeLessThan(0);
    expect(compare({ ...key, isSymlink: false }, { ...key, isSymlink: true })).toBeLessThan(0);

    const json = compareRows(PROJECTION_TABLES.blobs);
    const blob = { contentKey: 'k' };
    // Two objects that `String()` would both render as `[object Object]`.
    const left = { ...blob, frontmatter: { a: 1 } };
    const right = { ...blob, frontmatter: { b: 0 } };
    expect(json(left, right)).toBeLessThan(0);
    expect(json(right, left)).toBeGreaterThan(0);
    // Key order inside the value is not data.
    expect(json({ ...blob, frontmatter: { a: 1, b: 2 } }, { ...blob, frontmatter: { b: 2, a: 1 } })).toBe(0);
  });

  it('compares text by code units, never by locale', () => {
    const compare = compareRows(PROJECTION_TABLES.blobs);
    expect(compare({ contentKey: 'Z' }, { contentKey: 'a' })).toBeLessThan(0);
  });
});

/** A relation with one column of each kind compared by value, keyed by `id`, for the totality edges. */
const EDGES = {
  columns: ['id', 'count', 'ratio', 'at', 'flag'],
  primaryKey: ['id'],
  schema: z.object({
    id: z.string(),
    count: z.number().int(),
    ratio: z.number(),
    at: z.date(),
    flag: z.boolean(),
  }),
};

describe('compareRows is total over values a column kind does not expect', () => {
  const compare = compareRows(EDGES);
  const row = (fields: Record<string, unknown>): Record<string, unknown> => ({ id: 'k', ...fields });

  it('never ties a NaN real with a different raw value, and puts every number before it', () => {
    expect(compare(row({ ratio: 'not-a-number' }), row({ ratio: 'also-not' }))).not.toBe(0);
    expect(compare(row({ ratio: Number.NaN }), row({ ratio: 'x' }))).not.toBe(0);
    expect(compare(row({ ratio: 2.5 }), row({ ratio: 'x' }))).toBeLessThan(0);
    expect(compare(row({ ratio: 'x' }), row({ ratio: 2.5 }))).toBeGreaterThan(0);
  });

  it('never ties two unparseable timestamps with different text, and puts every instant before them', () => {
    expect(compare(row({ at: 'not a date' }), row({ at: 'also not' }))).not.toBe(0);
    expect(compare(row({ at: new Date(5) }), row({ at: 'not a date' }))).toBeLessThan(0);
    expect(compare(row({ at: 'not a date' }), row({ at: new Date(5) }))).toBeGreaterThan(0);
  });

  it('compares a timestamp by the instant it names, whether a Date or ISO text at any offset', () => {
    // A projection holds a Date; a store holds its ISO text. One instant is one value.
    expect(compare(row({ at: new Date('2024-01-01T06:00:00Z') }), row({ at: '2024-01-01T06:00:00.000Z' }))).toBe(0);
    // 10:00 at +05:00 is 05:00Z, an hour before 06:00Z, though its text sorts after.
    expect(compare(row({ at: '2024-01-01T10:00:00+05:00' }), row({ at: '2024-01-01T06:00:00Z' }))).toBeLessThan(0);
  });

  it('compares integers above 2^53 exactly when they arrive as integer strings', () => {
    // 2^53 + 1 and 2^53 are one double; as text they are two values.
    expect(compare(row({ count: '9007199254740993' }), row({ count: '9007199254740992' }))).toBeGreaterThan(0);
    expect(compare(row({ count: '9007199254740992' }), row({ count: '9007199254740993' }))).toBeLessThan(0);
    expect(compare(row({ count: 10n ** 20n }), row({ count: '100000000000000000001' }))).toBeLessThan(0);
    // An integer string and the number it spells are one value.
    expect(compare(row({ count: '12' }), row({ count: 12 }))).toBe(0);
  });

  it('stays transitive across bigint, unsafe-number and integer-text forms of nearby integers', () => {
    // 2^60 as a number is exact; as a double it cannot tell 2^60 + 1 from 2^60.
    const values: readonly unknown[] = [2n ** 60n + 1n, 2 ** 60, 2n ** 60n, '1152921504606846977', '1152921504606846975', 2 ** 60 - 256];
    const sign = (left: unknown, right: unknown): number => Math.sign(compare(row({ count: left }), row({ count: right })));
    const broken: string[] = [];
    for (const a of values) {
      for (const b of values) {
        for (const c of values) {
          if (sign(a, b) <= 0 && sign(b, c) <= 0 && sign(a, c) > 0) broken.push(`${String(a)} <= ${String(b)} <= ${String(c)} but ${String(a)} > ${String(c)}`);
        }
        if (sign(a, b) !== -sign(b, a)) broken.push(`${String(a)} and ${String(b)} disagree by direction`);
      }
    }
    expect(broken).toStrictEqual([]);
    expect(sign(2 ** 60, 2n ** 60n)).toBe(0);
    // A value that is no integer at all sorts after every integer, by its text.
    expect(sign(5, 'not-an-integer')).toBe(-1);
    expect(sign(2.5, 3n)).toBe(-1);
    expect(sign(2n ** 60n + 1n, 2 ** 60)).toBe(1);
  });

  it('reads the text false as false, never as a non-empty string', () => {
    expect(compare(row({ flag: 'false' }), row({ flag: false }))).toBe(0);
    expect(compare(row({ flag: 'false' }), row({ flag: true }))).toBeLessThan(0);
    expect(compare(row({ flag: 0 }), row({ flag: 'true' }))).toBeLessThan(0);
  });

  it('stays one order whichever end a mixed column is sorted from', () => {
    const rows = [row({ ratio: 'b' }), row({ ratio: 3 }), row({ ratio: 'a' }), row({ ratio: -1 })];
    expect(sortedBothWays(compare, rows).map((sorted) => (sorted as Record<string, unknown>)['ratio'])).toStrictEqual([-1, 3, 'a', 'b']);
  });
});

describe('compareRows over a scalar column', () => {
  const schema = z.object({
    id: z.string(),
    value: scalarColumn({ type: 'type', lexeme: 'lexeme' }),
    type: z.string(),
    lexeme: z.string().nullable(),
  });
  const compare = compareRows({ columns: ['id', 'value', 'type', 'lexeme'], schema, primaryKey: ['id'] });
  const at = (value: unknown): Record<string, unknown> => ({ id: 'k', value, type: 't', lexeme: null });

  it('orders null, then booleans, then numbers, then strings, each by its own order', () => {
    const rows = [at('b'), at(2), at(true), at(null), at('a'), at(-1), at(false), at(10)];
    expect(sortedBothWays(compare, rows).map((sorted) => (sorted as Record<string, unknown>)['value']))
      .toStrictEqual([null, false, true, -1, 2, 10, 'a', 'b']);
  });

  it('never ties a number and the string spelling it, nor a boolean and its number', () => {
    expect(compare(at(1), at('1'))).toBeLessThan(0);
    expect(compare(at(true), at(1))).toBeLessThan(0);
  });
});
