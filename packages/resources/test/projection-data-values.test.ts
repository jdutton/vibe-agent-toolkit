import { describe, expect, it } from 'vitest';

import { dataValueRows } from '../src/projection/data-values.js';
import type { DataNodeRow, DataRouteRow } from '../src/schemas/projection-data.js';
import { testContentKey } from '../src/testing/test-content-key.js';

const A = testContentKey('none', 'a');
const B = testContentKey('none', 'b');

/** A node row of `blob` read as `variant`, the rest from `fields`. */
function node(blob: DataNodeRow['blob'], fields: Partial<DataNodeRow> & Pick<DataNodeRow, 'ordinal' | 'pointer'>): DataNodeRow {
  return {
    blob,
    variant: 'json',
    doc: 0,
    parent: null,
    key: null,
    idx: null,
    depth: 1,
    type: 'object',
    value: null,
    lexeme: null,
    childCount: 0,
    tag: null,
    aliasOf: null,
    shadowed: false,
    line: 1,
    column: 1,
    ...fields,
  };
}

/** `{"a": {"x": 1}, "a": {"y": 2}}`: the first `/a` and its `/a/x` shadowed. */
const SHADOWED_NODES: readonly DataNodeRow[] = [
  node(A, { ordinal: 0, pointer: '', childCount: 2 }),
  node(A, { ordinal: 1, parent: 0, pointer: '/a', key: 'a', depth: 2, childCount: 1, shadowed: true }),
  node(A, { ordinal: 2, parent: 1, pointer: '/a/x', key: 'x', depth: 3, type: 'number', value: 1, lexeme: '1', shadowed: true }),
  node(A, { ordinal: 3, parent: 0, pointer: '/a', key: 'a', depth: 2, childCount: 1, line: 1, column: 17 }),
  node(A, { ordinal: 4, parent: 3, pointer: '/a/y', key: 'y', depth: 3, type: 'number', value: 2, lexeme: '2', column: 23 }),
];

const route = (path: string, blob: DataRouteRow['blob'], fields: Partial<DataRouteRow> = {}): DataRouteRow => ({
  root: 'root-1', path, blob, variant: 'json', state: 'facts', code: null, ...fields,
});

describe('dataValueRows', () => {
  it('joins each facts route to its unshadowed nodes: /a and /a/y, never /a/x', () => {
    const rows = dataValueRows([route('package.json', A)], SHADOWED_NODES);
    expect(rows.map((row) => row.pointer)).toStrictEqual(['', '/a', '/a/y']);
    expect(rows[2]).toStrictEqual({
      root: 'root-1', path: 'package.json', variant: 'json', doc: 0, pointer: '/a/y', key: 'y', depth: 3,
      type: 'number', value: 2, lexeme: '2', line: 1,
    });
  });

  it('gives each route its own rows when two paths share one row set', () => {
    const rows = dataValueRows([route('a/package.json', A), route('b/package.json', A)], SHADOWED_NODES);
    expect(rows.map((row) => `${row.path}${row.pointer}`)).toStrictEqual([
      'a/package.json', 'a/package.json/a', 'a/package.json/a/y', 'b/package.json', 'b/package.json/a', 'b/package.json/a/y',
    ]);
  });

  it('matches a route to nodes of its own variant only', () => {
    const jsonc = SHADOWED_NODES.map((row) => ({ ...row, variant: 'jsonc' as const }));
    expect(dataValueRows([route('tsconfig.json', A, { variant: 'jsonc' })], [...SHADOWED_NODES.slice(0, 1), ...jsonc.slice(3)]).map((row) => row.pointer))
      .toStrictEqual(['/a', '/a/y']);
  });

  it('answers no rows for a route that is not facts, or whose nodes it was not given', () => {
    const defective = route('bad.json', B, { state: 'defective', code: 'DATA_PARSE_ERROR' });
    const unread = route('gone.json', null, { state: 'refused', code: 'BLOB_UNREADABLE' });
    expect(dataValueRows([defective, unread, route('other.json', B)], SHADOWED_NODES)).toStrictEqual([]);
  });
});
