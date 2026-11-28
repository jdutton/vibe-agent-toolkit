/**
 * The row-set tier through the run's one reader: each table of a row set is held from one read,
 * a later request reads only the tables not yet held, an id a read finds absent from the ledger is
 * forgotten whole and answered uncovered, rows joined from several reads equal one whole read's in
 * primary-key order, and a write forgets the ids it moves.
 */

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { orderContentKeys, type ContentKey } from '../src/content-key.js';
import { emptyRowSetRows } from '../src/projection/derived-table-registry.js';
import { rowSetIdText, type RowSetId, type RowSetIdText } from '../src/projection/row-set-id.js';
import type { RowSetRows, RowSetTableName } from '../src/projection/row-set-table-registry.js';
import { rowSetCoverage, STORE_REQUEST_UNMET } from '../src/projection/store-hydration.js';
import type { FactStore, RowSetRead, RowSetRequest, RowSetWrite } from '../src/projection/store.js';
import { PROJECTION_STORE_READ_FAILED_CODE, runStoredReads, type StoreReads } from '../src/projection/stored-reads.js';
import type { DataFileRow, DataNodeRow } from '../src/schemas/projection-data.js';
import { testContentKey } from '../src/testing.js';

/** Every row-set table, empty. */
const emptyRowSets = emptyRowSetRows;

/** One stored row set: its id, and its rows by table. */
interface StoredRowSet {
  readonly id: RowSetId;
  readonly rows: ReturnType<typeof emptyRowSets>;
}

/** A row set of `key` read as `json`: its head row, one document, and `nodes` node rows. */
function rowSetOf(key: ContentKey, nodes: number): StoredRowSet {
  const id: RowSetId = { contentKey: key, instance: 'data', variant: 'json' };
  const rows = emptyRowSets();
  rows.dataFiles.push({ blob: key, variant: 'json', documents: 1, bom: false, nodeCount: nodes, maxDepth: 1 } satisfies DataFileRow);
  rows.dataDocuments.push({ blob: key, variant: 'json', doc: 0, rootType: 'object', nodeCount: nodes, maxDepth: 1 });
  for (let ordinal = 0; ordinal < nodes; ordinal++) {
    rows.dataNodes.push({
      blob: key, variant: 'json', doc: 0, ordinal, parent: ordinal === 0 ? null : 0, pointer: ordinal === 0 ? '' : `/k${String(ordinal)}`,
      key: ordinal === 0 ? null : `k${String(ordinal)}`, idx: null, depth: ordinal === 0 ? 1 : 2, type: ordinal === 0 ? 'object' : 'number',
      value: ordinal === 0 ? null : ordinal, lexeme: ordinal === 0 ? null : String(ordinal), childCount: ordinal === 0 ? nodes - 1 : 0, tag: null, aliasOf: null,
      shadowed: false, line: ordinal + 1, column: 1,
    } satisfies DataNodeRow);
  }
  return { id, rows };
}

/** What one port read was asked: the ids, as text, and the tables. */
interface AskedRead {
  readonly ids: readonly RowSetIdText[];
  readonly tables: readonly RowSetTableName[];
}

/**
 * The row-set members of a store, held in memory, recording every read: the rest of the port is
 * not the row-set tier's and throws. Rows are answered in the order they were filed, which the
 * fixtures file in primary-key order, so a whole read is the oracle of the order a join must keep.
 */
class RowSetStore implements FactStore {
  readonly asked: AskedRead[] = [];
  /** Set to make the next reads reject with `failure`. */
  failing = false;
  readonly failure = new Error('disk I/O error');
  /** Set to answer every requested id present, whatever the ledger holds: the presence-blind mutant. */
  presenceBlind = false;
  /** Set to answer without `present`: a backend that ignores the port. */
  withoutPresence = false;
  /** Set to answer without the tables of a request: a backend that ignores the port. */
  withoutTables = false;
  private readonly held = new Map<RowSetIdText, StoredRowSet>();

  /** @param rowSets - The row sets the store holds, in primary-key order */
  constructor(rowSets: readonly StoredRowSet[]) {
    for (const rowSet of rowSets) this.held.set(rowSetIdText(rowSet.id), rowSet);
  }

  /** @param id - A row set to drop from the store, ledger and rows: an eviction */
  evict(id: RowSetId): void {
    this.held.delete(rowSetIdText(id));
  }

  /**
   * @param id - A row set
   * @param table - A table
   * @returns How many reads asked for the table of the row set
   */
  readsOf(id: RowSetId, table: RowSetTableName): number {
    return this.asked.filter((read) => read.ids.includes(rowSetIdText(id)) && read.tables.includes(table)).length;
  }

  readRowSets<Table extends RowSetTableName>(ids: readonly RowSetId[], request: RowSetRequest<Table>): Promise<RowSetRead<Table>> {
    const texts = new Set(ids.map((id) => rowSetIdText(id)));
    this.asked.push({ ids: [...texts], tables: [...request.tables] });
    if (this.failing) return Promise.reject(this.failure);
    const rows: Partial<Record<RowSetTableName, unknown[]>> = {};
    if (!this.withoutTables) for (const table of request.tables) rows[table] = [];
    for (const [text, rowSet] of this.held) {
      if (!texts.has(text)) continue;
      for (const table of request.tables) rows[table]?.push(...rowSet.rows[table]);
    }
    const present = new Set(this.presenceBlind ? texts : [...texts].filter((text) => this.held.has(text)));
    const answer = { rows: rows as unknown as Pick<RowSetRows, Table>, present };
    return Promise.resolve(this.withoutPresence ? ({ rows: answer.rows } as RowSetRead<Table>) : answer);
  }

  writeRowSets(write: RowSetWrite): Promise<void> {
    const covered = new Set(write.coveredAtRead.map((id) => rowSetIdText(id)));
    for (const head of write.rows.dataFiles ?? []) {
      const id: RowSetId = { contentKey: head.blob, instance: 'data', variant: head.variant };
      if (covered.has(rowSetIdText(id))) continue;
      const rows = emptyRowSets();
      for (const table of Object.keys(rows) as RowSetTableName[]) {
        const written = (write.rows[table] ?? []) as readonly { readonly blob: ContentKey; readonly variant: string }[];
        (rows[table] as unknown[]).push(...written.filter((row) => row.blob === head.blob && row.variant === head.variant));
      }
      this.held.set(rowSetIdText(id), { id, rows });
    }
    return Promise.resolve();
  }

  writeBlobFacts(): Promise<void> { return Promise.reject(new Error('not the row-set tier')); }
  readBlobFacts(): never { throw new Error('not the row-set tier'); }
  writeExtent(): Promise<void> { return Promise.reject(new Error('not the row-set tier')); }
  readExtent(): never { throw new Error('not the row-set tier'); }
  close(): Promise<void> { return Promise.resolve(); }
  attachedTo(): never { throw new Error('not the row-set tier'); }
}

/** Two row sets, A before B in primary-key order, a store holding them, and a run's reader of it. */
function twoRowSets(): { a: StoredRowSet; b: StoredRowSet; store: RowSetStore; reads: StoreReads } {
  const [first, second] = [testContentKey('none', 'a.json'), testContentKey('none', 'b.json')].sort(orderContentKeys);
  if (first === undefined || second === undefined) throw new Error('the premise: two keys');
  const a = rowSetOf(first, 3);
  const b = rowSetOf(second, 2);
  const store = new RowSetStore([a, b]);
  return { a, b, store, reads: runStoredReads().of(store) };
}

/** The ids a head read of `ids` covers, through `reads`. */
async function coveredBy(reads: StoreReads, ids: readonly RowSetId[]): Promise<RowSetIdText[]> {
  const { covered } = rowSetCoverage(await reads.rowSets(ids, { tables: ['dataFiles'] }), ids);
  return covered.map((id) => rowSetIdText(id));
}

describe('a row set read through the run\'s reader', () => {
  it('always reads the head table, and answers exactly the requested tables', async () => {
    const { a, store, reads } = twoRowSets();

    const answer = await reads.rowSets([a.id], { tables: ['dataNodes'] });

    expect(Object.keys(answer)).toEqual(['dataNodes']);
    expect(answer.dataNodes).toEqual(a.rows.dataNodes);
    expect(store.asked.map((read) => [...read.tables].sort(compareCodeUnits))).toEqual([['dataFiles', 'dataNodes']]);
  });

  it('reads under a wider request only the tables it does not hold, each table once', async () => {
    const { a, b, store, reads } = twoRowSets();

    await reads.rowSets([a.id, b.id], { tables: ['dataFiles'] });
    const wider = await reads.rowSets([a.id, b.id], { tables: ['dataFiles', 'dataNodes'] });
    await reads.rowSets([a.id, b.id], { tables: ['dataNodes'] });

    expect(store.asked.map((read) => read.tables)).toEqual([['dataFiles'], ['dataNodes']]);
    for (const id of [a.id, b.id]) {
      for (const table of ['dataFiles', 'dataNodes'] as const) expect(store.readsOf(id, table), `${table} read once`).toBe(1);
    }
    expect(wider.dataNodes).toEqual([...a.rows.dataNodes, ...b.rows.dataNodes]);
  });

  it('joins rows from several reads into one whole read\'s rows, in primary-key order', async () => {
    const { a, b, store } = twoRowSets();
    const whole = await store.readRowSets([a.id, b.id], { tables: ['dataFiles', 'dataDocuments', 'dataNodes', 'dataConditions'] });
    const reads = runStoredReads().of(store);

    // B's head first, then both under the whole request, asked in the reverse of key order: A is
    // read whole and B only for the tables it lacks, two reads joined.
    await reads.rowSets([b.id], { tables: ['dataFiles'] });
    const joined = await reads.rowSets([b.id, a.id], { tables: ['dataFiles', 'dataDocuments', 'dataNodes', 'dataConditions'] });

    expect(store.asked.length - 1, 'the premise: two reads joined').toBe(3);
    expect(joined).toEqual(whole.rows);
  });

  it('shares one read per table between overlapping requests', async () => {
    const { a, store, reads } = twoRowSets();

    const answers = await Promise.all([
      reads.rowSets([a.id], { tables: ['dataFiles'] }),
      reads.rowSets([a.id], { tables: ['dataFiles', 'dataNodes'] }),
      reads.rowSets([a.id], { tables: ['dataNodes'] }),
    ]);

    expect(store.readsOf(a.id, 'dataFiles')).toBe(1);
    expect(store.readsOf(a.id, 'dataNodes')).toBe(1);
    expect(answers[2].dataNodes).toEqual(a.rows.dataNodes);
  });
});

/** A head read of A and B, A evicted, then a read of their nodes, and a coverage read after. */
async function evictedBetweenReads(store: RowSetStore, a: StoredRowSet, b: StoredRowSet): Promise<{ before: RowSetIdText[]; nodes: Pick<RowSetRows, 'dataNodes'>; after: RowSetIdText[] }> {
  const reads = runStoredReads().of(store);
  const before = await coveredBy(reads, [a.id, b.id]);
  store.evict(a.id);
  const nodes = await reads.rowSets([a.id, b.id], { tables: ['dataNodes'] });
  const after = await coveredBy(reads, [a.id, b.id]);
  return { before, nodes, after };
}

describe('a row set evicted between a head read and a later read', () => {
  // The mutant the presence check catches: to the reader, a store blind to presence is a reader
  // that joins two reads without the check. Asserted, so the seed cannot pass on a setup error.
  it('over a store blind to presence, is judged covered on the first read\'s head row with no nodes', async () => {
    const { a, b, store } = twoRowSets();
    store.presenceBlind = true;

    const { before, nodes, after } = await evictedBetweenReads(store, a, b);

    expect(before, 'the premise: both covered at the head read').toEqual([rowSetIdText(a.id), rowSetIdText(b.id)]);
    expect(after, 'the mutant covers the evicted id').toContain(rowSetIdText(a.id));
    expect(nodes.dataNodes.filter((row) => row.blob === a.id.contentKey), 'with none of its nodes').toEqual([]);
  });

  it('is forgotten whole: uncovered, and none of its rows held', async () => {
    const { a, b, store } = twoRowSets();

    const { nodes, after } = await evictedBetweenReads(store, a, b);
    const reads = runStoredReads().of(store);
    const heads = await reads.rowSets([a.id, b.id], { tables: ['dataFiles'] });

    expect(after).toEqual([rowSetIdText(b.id)]);
    expect(nodes.dataNodes).toEqual(b.rows.dataNodes);
    expect(heads.dataFiles.some((row) => row.blob === a.id.contentKey)).toBe(false);
  });

  it('stays absent for the run, reading nothing more, until it is forgotten', async () => {
    const { a, b, store, reads } = twoRowSets();
    await reads.rowSets([a.id], { tables: ['dataFiles'] });
    store.evict(a.id);
    await reads.rowSets([a.id], { tables: ['dataNodes'] });
    // Another process files it again: the run still holds it absent.
    await store.writeRowSets({ rows: a.rows, coveredAtRead: [] });
    const asked = store.asked.length;

    expect(await coveredBy(reads, [a.id]), 'absent for the run').toEqual([]);
    expect(store.asked.length, 'and read no more').toBe(asked);
    reads.forgetRowSets([a.id, b.id]);
    expect(await coveredBy(reads, [a.id]), 'forgotten, it is read again').toEqual([rowSetIdText(a.id)]);
  });
});

describe('a row-set write through the reader', () => {
  it('forgets the ids it moved and keeps the ids covered at read', async () => {
    const { a, b, store, reads } = twoRowSets();
    await reads.rowSets([a.id, b.id], { tables: ['dataFiles'] });

    // A was covered at read and is carried by its head row; B is written whole.
    const rows = emptyRowSets();
    rows.dataFiles.push(...a.rows.dataFiles, ...b.rows.dataFiles);
    rows.dataNodes.push(...b.rows.dataNodes);
    await reads.writeSets({ rows, coveredAtRead: [a.id] });
    await reads.rowSets([a.id, b.id], { tables: ['dataFiles'] });

    expect(store.readsOf(a.id, 'dataFiles'), 'a covered id is not read again').toBe(1);
    expect(store.readsOf(b.id, 'dataFiles'), 'a moved id is').toBe(2);
  });

  it('forgetting ids makes the next coverage read read their head rows again', async () => {
    const { a, store, reads } = twoRowSets();
    await coveredBy(reads, [a.id]);

    reads.forgetRowSets([a.id]);
    await coveredBy(reads, [a.id]);

    expect(store.readsOf(a.id, 'dataFiles')).toBe(2);
  });
});

describe('the reader holds the port to its answer', () => {
  it('codes a rejected read as the store\'s, and reads the tables again after it', async () => {
    const { a, store, reads } = twoRowSets();

    store.failing = true;
    await expect(reads.rowSets([a.id], { tables: ['dataNodes'] })).rejects.toMatchObject({ code: PROJECTION_STORE_READ_FAILED_CODE, cause: store.failure });
    store.failing = false;
    const retried = await reads.rowSets([a.id], { tables: ['dataNodes'] });

    expect(retried.dataNodes).toEqual(a.rows.dataNodes);
  });

  it('refuses an answer without presence', async () => {
    const { a, store } = twoRowSets();
    store.withoutPresence = true;

    await expect(runStoredReads().of(store).rowSets([a.id], { tables: ['dataFiles'] })).rejects.toMatchObject({ code: STORE_REQUEST_UNMET, tier: 'rowSet', table: 'present' });
  });

  it('refuses an answer lacking a requested table', async () => {
    const { a, store } = twoRowSets();
    store.withoutTables = true;

    await expect(runStoredReads().of(store).rowSets([a.id], { tables: ['dataFiles'] })).rejects.toMatchObject({ code: STORE_REQUEST_UNMET, tier: 'rowSet' });
  });
});

describe('row-set coverage', () => {
  it('covers exactly the ids whose head row the rows hold, in the ids\' order', () => {
    const { a, b } = twoRowSets();
    const unread: RowSetId = { contentKey: a.id.contentKey, instance: 'data', variant: 'jsonc' };

    const coverage = rowSetCoverage({ dataFiles: b.rows.dataFiles }, [unread, b.id, a.id]);

    expect(coverage.covered).toEqual([b.id]);
    expect(coverage.uncovered).toEqual([unread, a.id]);
  });
});
