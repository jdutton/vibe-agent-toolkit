/**
 * A row-set table is hydrated by copying the store's rows inside SQLite, filtered by each row set's
 * `(content key, variant)` as a PAIR and checked against `row_set_keys` by the whole triple, and the
 * copy answers exactly as the rows lane does: the same rows, in the same scan order, `rowid`
 * included, for exactly the run's row sets.
 *
 * The store holds three row sets: `(A, json)`, `(A, jsonc)` and `(B, jsonc)`. A run routing
 * `(A, json)` and `(B, jsonc)` names both content keys and both variants, so a copy filtering
 * `blob IN (...) AND variant IN (...)` admits the foreign `(A, jsonc)`; only a pair match does not.
 *
 * Scalar classes (spec 3.3's absolute table) are asserted through both hydration lanes: the rows
 * lane binds each row through `encodeRow`, and the copy lane keeps the class the store's writer
 * bound, since a `scalar` column has no declared type.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  type ContentKey,
  type DataConditionRow,
  type DataDocumentRow,
  type DataFileRow,
  type DataNodeRow,
  isStoredRowsEvicted,
  type FactStore,
  type RowSetId,
  type RowSetRows,
  type StoredRowsEvictedError,
} from '@vibe-agent-toolkit/resources';
import { readWorkCounters, safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { __resetWorkCountersForTest } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hydrateRunDatabase, type RelationSource } from '../../src/run-database.js';
import { contentKey } from '../fixtures.js';

const A = contentKey('a');
const B = contentKey('b');
const SCALARS_BLOB = contentKey('5');

/** The four row-set tables, by SQL name, in the order a run would hydrate them. */
const ROW_SET_RELATIONS = ['data__files', 'data__documents', 'data__nodes', 'data__conditions'] as const;

type Variant = RowSetId['variant'];

/** One scalar node's value, as the extractor hands it over. */
interface ScalarSeed {
  readonly type: 'string' | 'number' | 'boolean';
  readonly value: string | number | boolean;
  readonly lexeme: string | null;
}

/** Spec 3.3's absolute table, one node per row, in order. */
const ABSOLUTE_TABLE: readonly ScalarSeed[] = [
  { type: 'string', value: '1', lexeme: null },
  { type: 'number', value: 1, lexeme: '1' },
  { type: 'number', value: 1, lexeme: '1.0' },
  { type: 'boolean', value: true, lexeme: null },
  // 2^53+1: the double is 2^53, so the lexeme's value is lost; REAL, never INTEGER.
  { type: 'number', value: Number('9007199254740993'), lexeme: '9007199254740993' },
  { type: 'number', value: -0, lexeme: '-0' },
];

/** What `SELECT typeof(value), value` answers for {@link ABSOLUTE_TABLE}, row by row. */
const ABSOLUTE_CLASSES = [
  { class: 'text', value: '1' },
  { class: 'integer', value: 1 },
  { class: 'real', value: 1 },
  { class: 'integer', value: 1 },
  { class: 'real', value: 9_007_199_254_740_992 },
  { class: 'integer', value: 0 },
];

/** The id of one `data` row set. */
function idOf(key: ContentKey, variant: Variant): RowSetId {
  return { contentKey: key, instance: 'data', variant };
}

/**
 * One row set: an array root holding one scalar node per seed, and one condition. Each variant's
 * seeds differ, so a row of the wrong variant is visible in the copied rows.
 *
 * @param key - The content key
 * @param variant - The variant
 * @param seeds - The scalar elements
 * @returns Every table's rows of it
 */
function rowSetOf(key: ContentKey, variant: Variant, seeds: readonly ScalarSeed[]): RowSetRows {
  const nodeCount = seeds.length + 1;
  const file: DataFileRow = { blob: key, variant, documents: 1, bom: false, nodeCount, maxDepth: 1 };
  const document: DataDocumentRow = { blob: key, variant, doc: 0, rootType: 'array', nodeCount, maxDepth: 1 };
  const root: DataNodeRow = {
    blob: key, variant, doc: 0, ordinal: 0, parent: null, pointer: '', key: null, idx: null, depth: 1,
    type: 'array', value: null, lexeme: null, childCount: seeds.length, tag: null, aliasOf: null, shadowed: false, line: 1, column: 1,
  };
  const elements = seeds.map((seed, index): DataNodeRow => ({
    blob: key, variant, doc: 0, ordinal: index + 1, parent: 0, pointer: `/${String(index)}`, key: null, idx: index,
    depth: 2, type: seed.type, value: seed.value, lexeme: seed.lexeme, childCount: 0, tag: null, aliasOf: null, shadowed: false, line: index + 2, column: 3,
  }));
  const condition: DataConditionRow = {
    blob: key, variant, doc: 0, seq: 0, node: null, code: 'DATA_LOSSY_NUMBER', severity: 'warning',
    message: `${variant} condition`, line: 1, column: 1,
  };
  return { dataFiles: [file], dataDocuments: [document], dataNodes: [root, ...elements], dataConditions: [condition] };
}

/** A distinct value per variant, so a foreign variant's row differs from the routed one's. */
function seedsFor(variant: Variant): readonly ScalarSeed[] {
  return [{ type: 'string', value: `${variant}-value`, lexeme: null }, { type: 'number', value: variant === 'json' ? 1 : 2, lexeme: variant === 'json' ? '1' : '2' }];
}

/** Several row sets' rows, each table concatenated. */
function rowsOf(sets: readonly RowSetRows[]): RowSetRows {
  return {
    dataFiles: sets.flatMap((set) => set.dataFiles),
    dataDocuments: sets.flatMap((set) => set.dataDocuments),
    dataNodes: sets.flatMap((set) => set.dataNodes),
    dataConditions: sets.flatMap((set) => set.dataConditions),
  };
}

/** The table's rows carried under its SQL name. */
function tableRows(rows: RowSetRows, relation: (typeof ROW_SET_RELATIONS)[number]): readonly Readonly<Record<string, unknown>>[] {
  switch (relation) {
    case 'data__files': return rows.dataFiles;
    case 'data__documents': return rows.dataDocuments;
    case 'data__nodes': return rows.dataNodes;
    case 'data__conditions': return rows.dataConditions;
  }
}

const A_JSON = rowSetOf(A, 'json', seedsFor('json'));
const A_JSONC = rowSetOf(A, 'jsonc', seedsFor('jsonc'));
const B_JSONC = rowSetOf(B, 'jsonc', seedsFor('jsonc'));
/** The routed row sets, listed out of order, so the copy's order is its own. */
const ROUTED = [idOf(B, 'jsonc'), idOf(A, 'json')];

let directory: string;
let store: FactStore;

beforeEach(async () => {
  __resetWorkCountersForTest();
  directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-row-set-copy-'));
  const { DEFAULT_BLOB_TIER_BUDGET_BYTES, DEFAULT_ROW_SET_TIER_BUDGET_BYTES, openSqliteFactStore } = await import('../../src/store.js');
  store = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
  await store.writeRowSets({ rows: rowsOf([B_JSONC, A_JSONC, A_JSON]), coveredAtRead: [] });
});

afterEach(async () => {
  await store.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * What a statement without `ORDER BY` answers over each named relation, `rowid` included.
 *
 * @param sources - Each relation's source
 * @returns Each relation's rows, by name
 */
async function answersOf(sources: ReadonlyMap<string, RelationSource>): Promise<ReadonlyMap<string, readonly Record<string, unknown>[]>> {
  const database = hydrateRunDatabase({ rootId: 'root-1', relations: sources });
  try {
    return new Map([...sources.keys()].map((name) => [name, database.query(`SELECT rowid AS physical, * FROM "${name}"`)]));
  } finally {
    await database.close();
  }
}

/** Every row-set table from one source. */
function everyTable(source: (relation: (typeof ROW_SET_RELATIONS)[number]) => RelationSource): ReadonlyMap<string, RelationSource> {
  return new Map(ROW_SET_RELATIONS.map((relation) => [relation, source(relation)]));
}

/** The stored source for `ids`. */
function storedSource(ids: readonly RowSetId[]): RelationSource {
  return { stored: { tier: 'rowSet', store, ids } };
}

/** Remove one row set as the store's eviction does, from a second connection: its rows and its ledger row. */
function evictFromAnotherConnection(id: RowSetId, options: { readonly keepRows: boolean }): void {
  const evictor = new DatabaseSync(safePath.join(directory, 'projection.db'));
  try {
    evictor.prepare('DELETE FROM "row_set_keys" WHERE "contentKey" = ? AND "instance" = ? AND "variant" = ?').run(id.contentKey, id.instance, id.variant);
    if (!options.keepRows) {
      for (const relation of ROW_SET_RELATIONS) evictor.prepare(`DELETE FROM "${relation}" WHERE "blob" = ? AND "variant" = ?`).run(id.contentKey, id.variant);
    }
  } finally {
    evictor.close();
  }
}

/** Hydrate, and return what it threw. */
function thrownBy(sources: ReadonlyMap<string, RelationSource>): unknown {
  try {
    hydrateRunDatabase({ rootId: 'root-1', relations: sources });
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('copying a row-set table from the store', () => {
  it('answers exactly as the rows lane: the routed pairs only, never the foreign variant of the same bytes', async () => {
    const routedRows = rowsOf([A_JSON, B_JSONC]);
    const fromRows = await answersOf(everyTable((relation) => ({ rows: tableRows(routedRows, relation) })));
    const copied = await answersOf(everyTable(() => storedSource(ROUTED)));
    expect(copied).toStrictEqual(fromRows);
    for (const relation of ROW_SET_RELATIONS) {
      const pairs = new Set((copied.get(relation) ?? []).map((row) => `${String(row['blob'])}/${String(row['variant'])}`));
      expect(pairs, `${relation}: no row of (A, jsonc)`).toStrictEqual(new Set([`${String(A)}/json`, `${String(B)}/jsonc`]));
    }
    expect(copied.get('data__nodes'), 'the control is not vacuous').toHaveLength(routedRows.dataNodes.length);
  });

  it('copies an id named twice once, and counts every copied row', async () => {
    __resetWorkCountersForTest();
    const copied = await answersOf(new Map([['data__nodes', storedSource([idOf(A, 'json'), idOf(A, 'json')])]]));
    expect(copied.get('data__nodes')).toHaveLength(A_JSON.dataNodes.length);
    expect(readWorkCounters()['hydration.rows.copied']).toBe(A_JSON.dataNodes.length);
  });

  it('refuses, naming exactly the evicted id, when a routed row set left the ledger before the copy', () => {
    evictFromAnotherConnection(idOf(B, 'jsonc'), { keepRows: false });
    const thrown = thrownBy(everyTable(() => storedSource(ROUTED)));
    expect(isStoredRowsEvicted(thrown), String(thrown)).toBe(true);
    expect((thrown as StoredRowsEvictedError).eviction).toStrictEqual({ tier: 'rowSet', relation: 'data__files', ids: [idOf(B, 'jsonc')] });
  });

  it('checks the ledger by the whole triple: another variant of the same bytes held does not hold the routed one', () => {
    // (A, jsonc) stays in the ledger; (A, json) leaves it, its rows left behind as a torn write would.
    evictFromAnotherConnection(idOf(A, 'json'), { keepRows: true });
    const thrown = thrownBy(new Map([['data__nodes', storedSource(ROUTED)]]));
    expect(isStoredRowsEvicted(thrown), String(thrown)).toBe(true);
    expect((thrown as StoredRowsEvictedError).eviction).toStrictEqual({ tier: 'rowSet', relation: 'data__nodes', ids: [idOf(A, 'json')] });
  });

  it('refuses a source of the wrong tier for the relation', () => {
    expect(thrownBy(new Map([['data__nodes', { stored: { tier: 'blob', store, contentKeys: [A] } }]]))).toBeInstanceOf(TypeError);
    expect(thrownBy(new Map([['blob_references', storedSource(ROUTED)]]))).toBeInstanceOf(TypeError);
  });

  it('refuses a stored source for a partitioned table, which is not copy-eligible', () => {
    expect(String(thrownBy(new Map([['harness_blob_facts', { stored: { tier: 'blob', store, contentKeys: [A] } }]])))).toMatch(/cannot be copied/u);
  });
});

/** `typeof(value)` and `value` of every scalar node, in node order. */
async function classesOf(source: RelationSource): Promise<readonly Record<string, unknown>[]> {
  const database = hydrateRunDatabase({ rootId: 'root-1', relations: new Map([['data__nodes', source]]) });
  try {
    // Spread into plain objects: SQLite's rows carry no prototype, and the strict compare reads it.
    return database.query('SELECT typeof("value") AS class, "value" AS value FROM "data__nodes" WHERE "parent" IS NOT NULL ORDER BY "ordinal"')
      .map((row) => ({ ...row }));
  } finally {
    await database.close();
  }
}

describe('scalar classes through both hydration lanes', () => {
  const scalars = rowSetOf(SCALARS_BLOB, 'json', ABSOLUTE_TABLE);

  it('binds each class from the row on the rows lane (encodeRow)', async () => {
    expect(await classesOf({ rows: scalars.dataNodes })).toStrictEqual(ABSOLUTE_CLASSES);
  });

  it('keeps the class the store bound on the copy lane', async () => {
    await store.writeRowSets({ rows: scalars, coveredAtRead: [] });
    expect(await classesOf(storedSource([idOf(SCALARS_BLOB, 'json')]))).toStrictEqual(ABSOLUTE_CLASSES);
  });
});
