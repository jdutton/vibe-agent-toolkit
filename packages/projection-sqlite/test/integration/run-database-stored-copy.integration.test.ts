/**
 * A stored relation is hydrated by copying the store's rows inside SQLite, and the copy answers
 * exactly as the rows lane does: the same rows, in the same scan order, for exactly the content
 * keys the hit admitted, never a key it did not, and never a key the store no longer holds.
 *
 * Each proof hydrates `blob_references` twice — once from the decoded rows (`{ rows }`, the lane
 * a store-off or derived run takes) and once from the store (`{ stored }`) — and compares what a
 * statement without `ORDER BY` answers, `rowid` included, so a copy that dropped a form or
 * reversed the order reds here.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  type ContentKey,
  ALL_BLOB_REQUEST,
  allDerivedSpecs,
  contentKeyParts,
  isStoredRowsEvicted,
  PROJECTION_TABLES,
  storedRelationSpecs,
  type BlobScopedRows,
  type FactStore,
  type StoredRowsEvictedError,
} from '@vibe-agent-toolkit/resources';
import { uncoveredBlobWrite } from '@vibe-agent-toolkit/resources/testing';
import { readWorkCounters, safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { __resetWorkCountersForTest } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hydrateRunDatabase,
  isCopyEligible,
  type RelationSource,
  type RunDatabase,
} from '../../src/run-database.js';
import { blobKeyColumn } from '../../src/schema-sql.js';
import { SqliteFactStore } from '../../src/store.js';
import { FIRST_BLOB, SECOND_BLOB, contentKey, sampleBlobRows } from '../fixtures.js';

const THIRD_BLOB = contentKey('c');

/** Every reference form, AST and lexical interleaved, so a copy dropping either kind moves a row. */
const FORMS = ['markdown-link', 'bare-token', 'at-prefixed', 'html-link', 'env-anchored', 'markdown-definition'] as const;

/**
 * One blob's rows with a reference of every form, its references listed in REVERSE ordinal order,
 * so a copy that ordered them any way but the key's (a reversed `ORDER BY`) disagrees with the rows
 * lane. Not a proof that the `ORDER BY` is needed: the copy's `WHERE` reads the store through its
 * primary key index, which already yields key order, so a copy without it answers the same here. It
 * stays because the order is the contract and a plan is SQLite's to change.
 *
 * @param key - The content key
 * @returns The blob-scoped rows
 */
function blobWithEveryForm(key: ContentKey): BlobScopedRows {
  const base = sampleBlobRows(key);
  const [template] = base.blobReferences;
  if (template === undefined) throw new Error('the fixture carries no reference row');
  const references = FORMS.map((syntacticForm, ordinal) => ({ ...template, ordinal, syntacticForm, rawRef: `${syntacticForm}-${contentKeyParts(key).hex.slice(-4)}-${String(ordinal)}` }));
  return { ...base, blobReferences: references.toReversed() };
}

/** The blob tables' rows of several blobs, concatenated. */
function bundleOf(keys: readonly ContentKey[]): BlobScopedRows {
  const bundles = keys.map((key) => blobWithEveryForm(key));
  const tables = Object.keys(bundles[0] ?? {}) as (keyof BlobScopedRows)[];
  return Object.fromEntries(tables.map((table) => [table, bundles.flatMap((bundle) => bundle[table] as readonly unknown[])])) as unknown as BlobScopedRows;
}

let directory: string;
let store: FactStore;

beforeEach(async () => {
  __resetWorkCountersForTest();
  directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-stored-copy-'));
  const { DEFAULT_BLOB_TIER_BUDGET_BYTES, DEFAULT_ROW_SET_TIER_BUDGET_BYTES, openSqliteFactStore } = await import('../../src/store.js');
  store = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
  await store.writeBlobFacts(uncoveredBlobWrite(bundleOf([SECOND_BLOB, FIRST_BLOB, THIRD_BLOB])));
});

afterEach(async () => {
  await store.close();
  rmSync(directory, { recursive: true, force: true });
});

/** What a statement without `ORDER BY` answers over `blob_references`, `rowid` included. */
async function answersOf(source: RelationSource): Promise<readonly Record<string, unknown>[]> {
  const database = hydrateRunDatabase({ rootId: 'root-1', relations: new Map([['blob_references', source]]) });
  try {
    return database.query('SELECT rowid AS physical, * FROM "blob_references"');
  } finally {
    await database.close();
  }
}

/** The rows lane's source for `keys`: every form, decoded from the store. */
async function decodedSource(keys: readonly ContentKey[]): Promise<RelationSource> {
  const rows = (await store.readBlobFacts(keys, ALL_BLOB_REQUEST)).rows;
  return { rows: rows.blobReferences };
}

describe('hydrating a stored relation by copying it inside SQLite', () => {
  it('answers exactly as the decoded rows do: every form, the same scan order, rowid included', async () => {
    const keys = [FIRST_BLOB, SECOND_BLOB];
    const fromRows = await answersOf(await decodedSource(keys));
    const copied = await answersOf({ stored: { tier: 'blob', store, contentKeys: keys } });
    expect(copied).toStrictEqual(fromRows);
    expect(new Set(copied.map((row) => row['syntacticForm'])), 'every form, AST and lexical').toStrictEqual(new Set(FORMS));
    expect(copied, 'the control is not vacuous').toHaveLength(FORMS.length * keys.length);
  });

  it('copies a key named twice once, its held count matching the keys it names', async () => {
    __resetWorkCountersForTest();
    const copied = await answersOf({ stored: { tier: 'blob', store, contentKeys: [FIRST_BLOB, FIRST_BLOB] } });
    expect(copied).toHaveLength(FORMS.length);
    expect(readWorkCounters()['hydration.rows.copied']).toBe(FORMS.length);
  });

  it('copies through a wrapper of the port, which forwards the attach, and refuses a closed store', async () => {
    const wrapped: FactStore = {
      readBlobFacts: (keys, request) => store.readBlobFacts(keys, request),
      readRowSets: (ids, request) => store.readRowSets(ids, request),
      writeRowSets: (write) => store.writeRowSets(write),
      readExtent: (key, request) => store.readExtent(key, request),
      writeBlobFacts: (write) => store.writeBlobFacts(write),
      writeExtent: (key, rows) => store.writeExtent(key, rows),
      close: () => store.close(),
      attachedTo: (target, schema, work) => store.attachedTo(target, schema, work),
    };
    expect(await answersOf({ stored: { tier: 'blob', store: wrapped, contentKeys: [FIRST_BLOB] } })).toHaveLength(FORMS.length);

    await store.close();
    expect(() => hydrateRunDatabase({ rootId: 'root-1', relations: new Map([['blob_references', { stored: { tier: 'blob', store, contentKeys: [FIRST_BLOB] } }]]) }))
      .toThrow(/closed/u);
  });

  it('holds only the admitted keys, never another key the shared store holds', async () => {
    const copied = await answersOf({ stored: { tier: 'blob', store, contentKeys: [SECOND_BLOB] } });
    expect(new Set(copied.map((row) => row['blob']))).toStrictEqual(new Set([SECOND_BLOB]));
  });

  it('counts the copied rows as hydration.rows.copied and the decoded rows as hydration.rows.written', async () => {
    const references = await decodedSource([FIRST_BLOB]);
    __resetWorkCountersForTest();
    const database = hydrateRunDatabase({
      rootId: 'root-1',
      relations: new Map<string, RelationSource>([
        ['blobs', { rows: (await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rows.blobs }],
        ['blob_references', { stored: { tier: 'blob', store, contentKeys: [FIRST_BLOB, SECOND_BLOB] } }],
      ]),
    });
    await database.close();
    const counters = readWorkCounters();
    expect(counters['hydration.rows.copied']).toBe(FORMS.length * 2);
    expect(counters['hydration.rows.written']).toBe(1);
    expect(counters['hydration.writes']).toBe(1);
    expect('rows' in references && references.rows).toHaveLength(FORMS.length);
  });

  it('refuses, coded, when an admitted key left the store between the read and the copy', async () => {
    // Eviction removes a key's ledger row with its rows: done here on a second connection, as another
    // process's write would between this run's read and its copy.
    const evictor = new DatabaseSync(safePath.join(directory, 'projection.db'));
    try {
      evictor.prepare('DELETE FROM "blob_keys" WHERE "contentKey" = ?').run(SECOND_BLOB);
      evictor.prepare(`DELETE FROM "blob_references" WHERE "${blobKeyColumn(PROJECTION_TABLES.blobReferences)}" = ?`).run(SECOND_BLOB);
    } finally {
      evictor.close();
    }
    let thrown: unknown;
    try {
      hydrateRunDatabase({ rootId: 'root-1', relations: new Map([['blob_references', { stored: { tier: 'blob', store, contentKeys: [FIRST_BLOB, SECOND_BLOB] } }]]) });
    } catch (error) {
      thrown = error;
    }
    expect(isStoredRowsEvicted(thrown), String(thrown)).toBe(true);
    expect((thrown as StoredRowsEvictedError).eviction).toStrictEqual({ tier: 'blob', relation: 'blob_references', missing: 1 });
  });

  it('leaves the store unreachable from the run database once hydrated', async () => {
    let database: RunDatabase | undefined;
    try {
      database = hydrateRunDatabase({ rootId: 'root-1', relations: new Map([['blob_references', { stored: { tier: 'blob', store, contentKeys: [FIRST_BLOB] } }]]) });
      const open = database;
      expect(() => open.query('SELECT COUNT(*) AS n FROM vat_store."blob_references"')).toThrow(/no such table/u);
      expect(open.query('SELECT COUNT(*) AS n FROM "blob_references"')).toEqual([{ n: FORMS.length }]);
    } finally {
      await database?.close();
    }
  });

  it('refuses a stored source for a relation whose copy order is not proved', () => {
    expect(() => hydrateRunDatabase({ rootId: 'root-1', relations: new Map([['blob_conditions', { stored: { tier: 'blob', store, contentKeys: [FIRST_BLOB] } }]]) }))
      .toThrow(/cannot be copied/u);
  });
});

/**
 * The stored relations a copy may fill: the five blob tables keyed by the content key and integers,
 * and every row-set table. Stated here, and asserted both ways against the predicate over the whole
 * registry, so a new stored relation lands in one set or the other by a decision in this file.
 */
const COPY_ELIGIBLE = new Set([
  'blobs', 'blob_references', 'blob_sections', 'skill_text_facts', 'skill_text_matches',
  'data__files', 'data__documents', 'data__nodes', 'data__conditions',
  'ts__files', 'ts__imports', 'ts__import_names', 'ts__exports',
]);

/** The stored relations a copy must never fill, each for a reason the predicate reads off the spec. */
const COPY_INELIGIBLE_BLOB_TABLES = new Set([
  // A free-text `message` in its key: SQLite's order is not compareRows'.
  'blob_conditions',
  // Partitioned: written per pair as a run reaches it, so a key's stored rows can be a subset.
  'harness_blob_facts', 'harness_blob_imports',
]);

describe('isCopyEligible', () => {
  it('admits exactly the content-keyed, unpartitioned stored relations keyed by ASCII enums and integers', () => {
    const stored = storedRelationSpecs();
    const eligible = new Set(stored.filter((spec) => isCopyEligible(spec)).map((spec) => spec.name));
    const ineligible = new Set(stored.filter((spec) => !isCopyEligible(spec)).map((spec) => spec.name));
    const extentTables = stored.filter((spec) => spec.kind === 'projection' && spec.scope === 'extent').map((spec) => spec.name);
    expect(eligible).toStrictEqual(COPY_ELIGIBLE);
    expect(ineligible).toStrictEqual(new Set([...extentTables, ...COPY_INELIGIBLE_BLOB_TABLES]));
    expect(extentTables.length, 'the control is not vacuous').toBeGreaterThan(0);
  });

  it('admits no derived relation: a lens writes it per run, never into the store', () => {
    expect(allDerivedSpecs().filter((spec) => isCopyEligible(spec))).toStrictEqual([]);
  });
});

/** The schemas a connection has attached, by name. */
function schemasOf(database: DatabaseSync): string[] {
  return (database.prepare('PRAGMA database_list').all() as { name: string }[]).map((row) => row.name);
}

/** The suite's store as the class that attaches. */
function sqliteStore(): SqliteFactStore {
  if (!(store instanceof SqliteFactStore)) throw new TypeError('the suite opens a SqliteFactStore');
  return store;
}

/** A directory name holding a backslash: on POSIX a filename character. */
const BACKSLASHED_NAME = String.raw`cache\dir`;

describe('SqliteFactStore.attachedTo', () => {
  // On POSIX a backslash is a filename character, so it must reach SQLite as one.
  it.skipIf(process.platform === 'win32')('attaches a store whose directory name holds a backslash', async () => {
    const { DEFAULT_BLOB_TIER_BUDGET_BYTES, DEFAULT_ROW_SET_TIER_BUDGET_BYTES, openSqliteFactStore } = await import('../../src/store.js');
    // Not safePath.join: it would turn the backslash into a separator.
    const backslashed = `${directory}/${BACKSLASHED_NAME}`;
    const opened = openSqliteFactStore({ directory: backslashed, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
    if (!(opened instanceof SqliteFactStore)) throw new TypeError('openSqliteFactStore opens a SqliteFactStore');
    const database = new DatabaseSync(':memory:');
    try {
      expect(existsSync(backslashed), 'the premise: a directory named with a backslash').toBe(true);
      const tables = opened.attachedTo(database, 'held', () => schemasOf(database));
      expect(tables).toContain('held');
    } finally {
      database.close();
      await opened.close();
    }
  });

  it('attaches the store read-only and detaches it after the work', () => {
    const database = new DatabaseSync(':memory:');
    try {
      const during = sqliteStore().attachedTo(database, 'held', () => {
        expect(() => database.exec('DELETE FROM held."blob_keys"')).toThrow(/readonly/u);
        return schemasOf(database);
      });
      expect(during).toContain('held');
      expect(schemasOf(database)).not.toContain('held');
    } finally {
      database.close();
    }
  });

  it('detaches after work that throws, and throws the work\'s error', () => {
    const database = new DatabaseSync(':memory:');
    const original = new Error('the work failed');
    try {
      expect(() => sqliteStore().attachedTo(database, 'held', () => {
        throw original;
      })).toThrow(original);
      expect(schemasOf(database)).not.toContain('held');
    } finally {
      database.close();
    }
  });

  it('throws the work\'s error when the detach after it fails too', () => {
    const database = new DatabaseSync(':memory:');
    const original = new Error('the work failed inside a transaction');
    try {
      // An open read transaction on the attached schema makes the DETACH fail.
      expect(() => sqliteStore().attachedTo(database, 'held', () => {
        database.exec('BEGIN');
        database.prepare('SELECT COUNT(*) AS n FROM held."blob_keys"').get();
        throw original;
      })).toThrow(original);
      database.exec('ROLLBACK');
      database.exec('DETACH DATABASE held');
    } finally {
      database.close();
    }
  });
});
