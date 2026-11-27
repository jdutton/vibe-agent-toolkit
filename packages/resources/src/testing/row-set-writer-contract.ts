/**
 * The row-set writer's contract, written once and run against every {@link FactStore}: the SQLite
 * store and the test double alike, the row-set tier's twin of the blob writer contract.
 *
 * Framework-free, like the blob contract: each case is a plain async function that throws an
 * `AssertionError` on failure, and each suite registers them with its own runner
 * (`for (const c of ROW_SET_WRITER_CONTRACT) it(c.name, () => c.run(open))`).
 *
 * The rule under test (`FactStore.writeRowSets`): held = the head-table ids of the write's rows.
 * (1) each covered id is looked up in the ledger; (2) every held id not covered at read is replaced
 * whole, and a covered id gone from the ledger is left absent, never written partially (the write
 * carries only its head row); (3) every held id still in the ledger is re-stamped; (4) the tier is
 * evicted past its budget, never a held id.
 *
 * Every case names the mutant it was proved red with: a writer that breaks the one rule the case pins.
 */

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { compareCodeUnits, readWorkCounters } from '@vibe-agent-toolkit/utils';

import { rowSetIdText, type RowSetId } from '../projection/row-set-id.js';
import type { RowSetRows, RowSetTableName } from '../projection/row-set-table-registry.js';
import type { FactStore, RowSetRequest, RowSetWrite } from '../projection/store.js';
import type { DataVariant } from '../schemas/projection-data.js';

import { testContentKey } from './test-content-key.js';
import { MIXED_SEEDS, mintThree, PRESENCE_CASE, PRESENCE_SEEDS } from './writer-contract-shared.js';

/** One store under the contract, and what the port does not offer. */
export interface RowSetWriterContractSubject {
  readonly store: FactStore;
  /**
   * Evict one row set as the store's own eviction does: its rows in every table of its instance
   * and its ledger row, together.
   *
   * @param id - The row set to evict
   */
  evict(id: RowSetId): Promise<void>;
  /**
   * The row-set ledger as the store holds it: each tracked row set (by `rowSetIdText`) and the
   * bytes it records.
   */
  ledgerBytes(): Promise<Readonly<Record<string, number>>>;
  /**
   * `storedRowBytes` summed over each row set's STORED rows, measured from the rows themselves and
   * not from the ledger, by `rowSetIdText`: what the ledger must equal.
   */
  storedBytes(): Promise<Readonly<Record<string, number>>>;
}

/**
 * Open a fresh, empty store (a new one on every call, sharing nothing with an earlier one) whose
 * row-set tier is kept within `rowSetTierBudgetBytes`.
 */
export type RowSetWriterContractFactory = (options: { readonly rowSetTierBudgetBytes: number }) => Promise<RowSetWriterContractSubject>;

/** One case of the contract. */
export interface RowSetWriterContractCase {
  /** The rule, as a test name. */
  readonly name: string;
  /** The writer change that turns this case red. */
  readonly mutant: string;
  /** Run the case against a fresh store; throws on failure. */
  run(open: RowSetWriterContractFactory): Promise<void>;
}

/** Every table of the `data` instance: what a whole read of a row set asks for. */
const ALL_DATA_TABLES: RowSetRequest<RowSetTableName> = { tables: ['dataFiles', 'dataDocuments', 'dataNodes', 'dataConditions'] };

/**
 * A row set the contract writes: a `none` content key (a data file's bytes have no parser kind),
 * read as `variant`.
 *
 * @param seed - Distinguishes one contract row set's bytes from another's
 * @param variant - How the bytes were read
 * @returns The id
 */
export function contractRowSetId(seed: string, variant: DataVariant = 'json'): RowSetId {
  return { contentKey: testContentKey('none', seed), instance: 'data', variant };
}

/**
 * One row set's rows: a head row, one document and one string node, no condition. `documents` is
 * the head value a case alters to tell a rewrite from a kept row; `extra` grows the node's value,
 * so row sets of one shape differ in size by exactly the difference of their `extra`.
 *
 * @param id - The row set
 * @param extra - Extra characters in the node's value
 * @param documents - The head row's `documents`
 * @returns Every table of the instance
 */
export function contractRowSet(id: RowSetId, extra = 0, documents = 1): RowSetRows {
  const blob = id.contentKey;
  const { variant } = id;
  return {
    dataFiles: [{ blob, variant, documents, bom: false, nodeCount: 1, maxDepth: 0 }],
    dataDocuments: [{ blob, variant, doc: 0, rootType: 'string', nodeCount: 1, maxDepth: 0 }],
    dataNodes: [{
      blob, variant, doc: 0, ordinal: 0, parent: null, pointer: '', key: null, idx: null, depth: 1,
      type: 'string', value: `v${'x'.repeat(extra)}`, lexeme: null, childCount: 0, shadowed: false, line: 1, column: 1,
    }],
    dataConditions: [],
  };
}

/**
 * The head row alone of a row set: what a run holds of a row set its read served.
 *
 * @param id - The row set
 * @param documents - The head row's `documents`
 * @returns Every table of the instance, all but the head empty
 */
function headOnly(id: RowSetId, documents = 1): RowSetRows {
  return { ...emptyRowSets(), dataFiles: contractRowSet(id, 0, documents).dataFiles };
}

/** @returns Every table of the instance, empty */
function emptyRowSets(): RowSetRows {
  return { dataFiles: [], dataDocuments: [], dataNodes: [], dataConditions: [] };
}

/**
 * Several row sets' rows as one bundle.
 *
 * @param bundles - One bundle per row set
 * @returns Their tables concatenated
 */
function merged(bundles: readonly RowSetRows[]): RowSetRows {
  return bundles.reduce<RowSetRows>((into, bundle) => ({
    dataFiles: [...into.dataFiles, ...bundle.dataFiles],
    dataDocuments: [...into.dataDocuments, ...bundle.dataDocuments],
    dataNodes: [...into.dataNodes, ...bundle.dataNodes],
    dataConditions: [...into.dataConditions, ...bundle.dataConditions],
  }), emptyRowSets());
}

/**
 * A write whose read covered nothing: every held row set is replaced.
 *
 * @param rows - The rows to write
 * @returns The write
 */
export function uncoveredRowSetWrite(rows: RowSetRows): RowSetWrite {
  return { rows, coveredAtRead: [] };
}

/**
 * Every row the store holds for some row sets, every table.
 *
 * @param store - The store
 * @param ids - The row sets
 * @returns The rows
 */
async function heldRows(store: FactStore, ids: readonly RowSetId[]): Promise<RowSetRows> {
  return (await store.readRowSets(ids, ALL_DATA_TABLES)).rows;
}

/**
 * Open a store, run `body`, and close the store however `body` ends.
 *
 * @param open - The factory
 * @param rowSetTierBudgetBytes - The budget
 * @param body - The case
 * @returns What `body` returns
 */
async function withStore<T>(
  open: RowSetWriterContractFactory,
  rowSetTierBudgetBytes: number,
  body: (subject: RowSetWriterContractSubject) => Promise<T>,
): Promise<T> {
  const subject = await open({ rowSetTierBudgetBytes });
  try {
    return await body(subject);
  } finally {
    await subject.store.close();
  }
}

/** A budget no case crosses unless it means to. */
const WIDE_BUDGET = 1_000_000_000;

/**
 * What one {@link contractRowSet} measures in the store under test: written alone to a fresh
 * store with a wide budget, read off its ledger.
 *
 * @param open - The factory
 * @param extra - The size parameter
 * @returns The row set's recorded bytes
 */
function measuredSize(open: RowSetWriterContractFactory, extra: number): Promise<number> {
  return withStore(open, WIDE_BUDGET, async ({ store, ledgerBytes }) => {
    const id = contractRowSetId('probe');
    await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(id, extra)));
    const bytes = (await ledgerBytes())[rowSetIdText(id)];
    ok(bytes !== undefined && bytes > 0, `the probe row set recorded ${String(bytes)} bytes`);
    return bytes;
  });
}

/**
 * The row sets a ledger tracks, as text, sorted.
 *
 * @param ledger - The ledger
 * @returns Its ids in code-unit order
 */
function tracked(ledger: Readonly<Record<string, number>>): readonly string[] {
  return Object.keys(ledger).sort(compareCodeUnits);
}

/**
 * Some ids as sorted text, to compare with {@link tracked}.
 *
 * @param ids - The ids
 * @returns Their text in code-unit order
 */
function idTexts(ids: readonly RowSetId[]): readonly string[] {
  return ids.map((id) => rowSetIdText(id)).sort(compareCodeUnits);
}

/** @returns This thread's `store.rows.decoded.repeated` so far */
function repeatedDecodes(): number {
  return readWorkCounters()['store.rows.decoded.repeated'];
}

/** The writer cases, in the order the port's steps run, then the ledger's and the reader's. */
export const ROW_SET_WRITER_CONTRACT: readonly RowSetWriterContractCase[] = [
  {
    name: 'a covered row set still in the ledger is not rewritten',
    mutant: 'ignore coveredAtRead: replace every held row set',
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store }) => {
      const id = contractRowSetId('covered');
      await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(id)));
      const first = await heldRows(store, [id]);

      await store.writeRowSets({ rows: headOnly(id, 2), coveredAtRead: [id] });

      deepStrictEqual(await heldRows(store, [id]), first, 'a covered row set in the ledger was rewritten');
    }),
  },
  {
    name: 'a covered row set evicted since the read is left absent, never written partially',
    mutant: 'trust coveredAtRead without the ledger lookup',
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store, evict, ledgerBytes }) => {
      const id = contractRowSetId('evicted-covered');
      await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(id)));
      await evict(id);

      await store.writeRowSets({ rows: headOnly(id), coveredAtRead: [id] });

      const read = await store.readRowSets([id], ALL_DATA_TABLES);
      deepStrictEqual([...read.present], [], 'a covered row set evicted since the read was called present');
      deepStrictEqual(read.rows, emptyRowSets(), 'a covered row set evicted since the read was written partially');
      deepStrictEqual(tracked(await ledgerBytes()), [], 'a covered row set evicted since the read was re-stamped');
    }),
  },
  {
    name: 'an uncovered row set evicted earlier is written whole again (healing)',
    mutant: 'apply the covered-and-evicted rule to an uncovered row set: leave it absent',
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store, evict }) => {
      const id = contractRowSetId('healed');
      await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(id)));
      const first = await heldRows(store, [id]);
      await evict(id);

      await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(id)));

      const read = await store.readRowSets([id], ALL_DATA_TABLES);
      deepStrictEqual([...read.present], [rowSetIdText(id)], 'an uncovered row set was not written back');
      deepStrictEqual(read.rows, first, 'an uncovered row set was not written whole');
    }),
  },
  {
    name: 'every held row set is re-stamped before eviction',
    mutant: 'stamp only replaced row sets and protect only them from the budget',
    // A budget of one byte: only the held row sets' exclusion keeps anything.
    run: (open) => withStore(open, 1, async ({ store, ledgerBytes }) => {
      const covered = ['c', 'd', 'e', 'f'].map((seed) => contractRowSetId(`restamp-${seed}`));
      const added = contractRowSetId('restamp-added');
      await store.writeRowSets(uncoveredRowSetWrite(merged(covered.map((id) => contractRowSet(id)))));

      const held = [...covered, added];
      await store.writeRowSets({ rows: merged([...covered.map((id) => headOnly(id)), contractRowSet(added)]), coveredAtRead: covered });

      deepStrictEqual(tracked(await ledgerBytes()), idTexts(held), 'a write evicted row sets it held at a budget of one byte');
      const kept = (await heldRows(store, held)).dataNodes.length;
      strictEqual(kept, held.length, 'a held row set lost its rows');
    }),
  },
  {
    name: 'a covered row set\'s re-stamp makes it newer than a row set written after it',
    mutant: 'stamp only replaced row sets (protection of every held row set kept)',
    run: async (open: RowSetWriterContractFactory): Promise<void> => {
      // Room for two row sets. `older` is re-stamped by a write that covers it, so the next write
      // evicts `newer`, the one now least recently held.
      const budget = 2 * (await measuredSize(open, 0));
      const [older, newer, later] = mintThree((seed) => contractRowSetId(`recency-${seed}`), ['older', 'newer', 'later']);
      await withStore(open, budget, async ({ store, ledgerBytes }) => {
        await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(older)));
        await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(newer)));
        await store.writeRowSets({ rows: headOnly(older), coveredAtRead: [older] });
        await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(later)));
        deepStrictEqual(tracked(await ledgerBytes()), idTexts([older, later]), 'the re-stamped row set was evicted before the one written after it');
      });
    },
  },
  {
    name: 'every held row set stays even when the held row sets alone exceed the budget',
    mutant: 'cut by bytes alone, without excluding the held row sets (evict the write\'s own)',
    run: async (open: RowSetWriterContractFactory): Promise<void> => {
      // Two writes of five row sets, each larger than three row sets' bytes. Each keeps all five
      // of its own; the second takes every row set of the first.
      const extras = [100, 150, 200, 250, 300];
      const budget = 3 * (await measuredSize(open, 100));
      const first = extras.map((_, index) => contractRowSetId(`first-${index}`));
      const second = extras.map((_, index) => contractRowSetId(`second-${index}`));
      await withStore(open, budget, async ({ store, ledgerBytes }) => {
        await store.writeRowSets(uncoveredRowSetWrite(merged(first.map((id, index) => contractRowSet(id, extras[index])))));
        deepStrictEqual(tracked(await ledgerBytes()), idTexts(first), 'a write evicted its own held row sets');
        await store.writeRowSets(uncoveredRowSetWrite(merged(second.map((id, index) => contractRowSet(id, extras[index])))));
        deepStrictEqual(tracked(await ledgerBytes()), idTexts(second), 'the second write kept another set than its own');
        deepStrictEqual(await heldRows(store, first), emptyRowSets(), 'an evicted row set kept its rows');
      });
    },
  },
  {
    name: 'the ledger equals the measure of the stored rows for every row set after mixed writes',
    mutant: 're-stamp a covered row set with the bytes of the rows the write carries for it (its head row alone)',
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store, ledgerBytes, storedBytes }) => {
      const [a, b, c] = mintThree((seed) => contractRowSetId(seed), MIXED_SEEDS);
      await store.writeRowSets(uncoveredRowSetWrite(merged([contractRowSet(a, 20), contractRowSet(b, 30)])));
      const before = (await ledgerBytes())[rowSetIdText(a)];
      // a covered and re-stamped beside c replaced; then b replaced at another size.
      await store.writeRowSets({ rows: merged([headOnly(a), contractRowSet(c, 5)]), coveredAtRead: [a] });
      await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(b, 90)));

      strictEqual((await ledgerBytes())[rowSetIdText(a)], before, 'a re-stamp changed the recorded bytes');
      deepStrictEqual(await ledgerBytes(), await storedBytes(), 'the ledger is not the measure of the stored rows');
      deepStrictEqual(tracked(await ledgerBytes()), idTexts([a, b, c]), 'a row set left the ledger');
    }),
  },
  {
    name: 'two variants of one content key are two row sets',
    mutant: 'clear a replaced row set by its content key alone',
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store }) => {
      const json = contractRowSetId('both', 'json');
      const jsonc = contractRowSetId('both', 'jsonc');
      await store.writeRowSets(uncoveredRowSetWrite(merged([contractRowSet(json), contractRowSet(jsonc)])));
      const other = await heldRows(store, [jsonc]);

      await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(json, 7, 3)));

      deepStrictEqual(await heldRows(store, [jsonc]), other, 'replacing one variant changed the other');
      notStrictEqual((await heldRows(store, [json])).dataFiles[0]?.documents, 1, 'the replaced variant kept its old head row');
    }),
  },
  {
    ...PRESENCE_CASE,
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store, evict }) => {
      const [kept, evicted, unwritten] = mintThree((seed) => contractRowSetId(seed), PRESENCE_SEEDS);
      await store.writeRowSets(uncoveredRowSetWrite(merged([contractRowSet(kept), contractRowSet(evicted)])));
      await evict(evicted);

      const read = await store.readRowSets([kept, evicted, unwritten], { tables: ['dataFiles'] });
      deepStrictEqual([...read.present], [rowSetIdText(kept)], 'presence named another set than the one row set the ledger holds');
      deepStrictEqual(read.rows.dataFiles.map((row) => row.blob), [kept.contentKey], 'an evicted row set kept its rows');

      // contractRowSet holds no condition: a request for conditions alone returns no row of it.
      const narrow = await store.readRowSets([kept], { tables: ['dataConditions'] });
      deepStrictEqual(narrow.rows.dataConditions, [], 'the contract row set grew a condition row');
      deepStrictEqual([...narrow.present], [rowSetIdText(kept)], 'a row set with no row in the requested tables was called absent');
    }),
  },
  {
    name: 'a replaced row set\'s decoded rows are forgotten, so reading it again repeats nothing',
    mutant: 'keep the decode-ledger entry of a replaced row set',
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store }) => {
      const id = contractRowSetId('decoded');
      await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(id)));
      await store.readRowSets([id], ALL_DATA_TABLES);
      const before = repeatedDecodes();
      await store.readRowSets([id], ALL_DATA_TABLES);
      ok(repeatedDecodes() > before, 'a second read of the same row set counted no repeated decode');

      await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(id)));
      const afterWrite = repeatedDecodes();
      await store.readRowSets([id], ALL_DATA_TABLES);

      strictEqual(repeatedDecodes(), afterWrite, 'a read after the row set was replaced counted its rows as repeated');
    }),
  },
];
