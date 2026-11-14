/**
 * `compareRows`: the one canonical row order the export, the run database's hydration and a lens
 * write all insert in. Total — no two distinct rows tie — and typed per column kind.
 */

import { describe, expect, it } from 'vitest';

import { compareRows, DERIVED_TABLES, PROJECTION_TABLES } from '../src/index.js';

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
