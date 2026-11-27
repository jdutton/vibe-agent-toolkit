/**
 * The claim that decided the storage engine: several OS processes can write and
 * read one store at once, losing nothing and never observing a half-written
 * projection.
 *
 * This is the arm that cannot be a unit test. The failure it hunts is **silent**
 * — a lost row, a torn read — so every assertion counts rows rather than
 * checking for a thrown error. `pglite` was rejected on exactly this arm: four
 * writers lost 100–150 of 250 rows in every trial and every process exited 0.
 *
 * 🪤 Separate **processes**, never worker threads: POSIX advisory locks are held
 * per process, so two connections inside one process are arbitrated by SQLite's
 * own machinery rather than by the file locks a second process takes. A
 * thread-based harness passes without testing the claim.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  ALL_BLOB_REQUEST,
  ALL_EXTENT_REQUEST,
  type ContentKey,
  isProjectionTable,
  isRowSetTable,
  rowSetIdText,
  storedRelationSpecs,
} from '@vibe-agent-toolkit/resources';
import {
  contractBlobRows,
  contractRowSet,
  contractRowSetId,
  testContentKey,
  uncoveredBlobWrite,
  uncoveredRowSetWrite,
} from '@vibe-agent-toolkit/resources/testing';
import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_BLOB_TIER_BUDGET_BYTES, DEFAULT_ROW_SET_TIER_BUDGET_BYTES, openSqliteFactStore, type SqliteStoreOptions } from '../../src/store.js';
import { storedRowSetText } from '../fixtures.js';

/** The writer script, beside this file. */
const WRITER = resolveFromImportMeta(import.meta.url, 'store-writer-child.mjs');

/** Writers in the loss arm, and blobs each writes. */
const WRITERS = 4;
const BLOBS_EACH = 40;

/** Rewrites the contended extent performs — enough that a reader gets samples. */
const CONTENDED_WRITES = 500;

/** Reads of the contended extent that count as enough evidence of atomicity. */
const ENOUGH_SAMPLES = 2_000;

/**
 * Hard deadline on the reader loop, so a stalled writer fails rather than hangs.
 *
 * A deadline and not an iteration cap: a *miss* reads in microseconds, so a cap
 * large enough to be safe on a slow machine is exhausted in a fraction of a
 * second on a fast one — and the loop then ends before the writer process has
 * even finished booting, reporting zero samples as though nothing were there.
 */
const READ_DEADLINE_MS = 20_000;

let directory: string;

/** Every writer process this file started and has not yet seen exit. */
const running = new Set<ChildProcess>();

beforeEach(() => {
  directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-projection-sqlite-conc-'));
});

afterEach(() => {
  // A test that failed before its writers exited must not leave them running.
  for (const child of running) child.kill('SIGKILL');
  running.clear();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Run one writer process to completion.
 *
 * @param writerId - Distinguishes this writer's keys from the others'
 * @param mode - `distinct` or `contended`; see the writer script
 * @param iterations - How many writes it performs
 * @param retention - `retainedExtentsPerRoot` for the child's store, when this
 *   arm must not have eviction in the picture; the child's default otherwise
 * @returns Its exit code and anything it wrote to stderr
 */
function runWriter(
  writerId: string,
  mode: string,
  iterations: number,
  retention?: number,
): Promise<{ code: number; stderr: string }> {
  const retentionArgs = retention === undefined ? [] : [String(retention)];
  return runChild([writerId, mode, String(iterations), ...retentionArgs]);
}

/**
 * Run the writer script with `args` after the shared directory, to completion.
 *
 * @param args - The script's arguments after `<directory>`
 * @returns Its exit code and anything it wrote to stderr
 */
function runChild(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, directory, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    running.add(child);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => {
      running.delete(child);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/** Open a store on the shared directory. */
function open(options: Partial<Omit<SqliteStoreOptions, 'directory'>> = {}) {
  return openSqliteFactStore({ blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES, ...options, directory });
}

describe('connection configuration', () => {
  it('leaves the database in WAL, which is what makes readers and writers coexist', async () => {
    const store = open();
    await store.close();

    // Read it back through a connection this store never touched: WAL is
    // persisted in the file header, so a claim about the file is stronger than
    // a claim about the connection that set it.
    const probe = new DatabaseSync(safePath.join(directory, 'projection.db'));
    const mode = probe.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    probe.close();
    expect(mode?.journal_mode).toBe('wal');
  });

  it('survives several processes opening a cold store at the same instant', async () => {
    // 🪤 This is the arm that found the sharpest version of the WAL trap:
    // `PRAGMA journal_mode = WAL` is NOT retried through the busy handler, so
    // four simultaneous opens of a brand-new store produced
    // `ERR_SQLITE_ERROR: database is locked` even with the timeout already set.
    // Every writer here opens a store that does not exist yet.
    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, index) => runWriter(`o${index}`, 'distinct', 1)),
    );

    for (const [index, result] of results.entries()) {
      expect(result.code, `opener ${index}: ${result.stderr}`).toBe(0);
    }
  });
});

describe('concurrent writers', () => {
  it('loses nothing when four processes write at once', async () => {
    // Retention is handed to the children so it cannot participate. Each writer
    // takes its own tree under ONE root, so at the shipped default of three this
    // arm would drop the oldest of the four ON PURPOSE — indistinguishable from
    // the silent row loss it exists to detect, and a green wall against ever
    // seeing that loss again. What retention does is asserted separately, in
    // `test/store.test.ts`.
    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, index) => runWriter(`w${index}`, 'distinct', BLOBS_EACH, WRITERS)),
    );

    // Exit codes first, so a crashed writer is diagnosed as a crash rather than
    // as data loss.
    for (const [index, result] of results.entries()) {
      expect(result.code, `writer ${index}: ${result.stderr}`).toBe(0);
    }

    const store = open();
    try {
      // Every writer's extent landed…
      for (let index = 0; index < WRITERS; index += 1) {
        const extent = await store.readExtent({ rootId: 'root-shared', treeHash: `tree-w${index}` }, ALL_EXTENT_REQUEST);
        expect(extent, `writer ${index} extent`).toBeDefined();
      }
      // …and so did every blob row. Counting is the assertion: a lost row
      // throws nothing and exits 0.
      const keys = Array.from({ length: WRITERS * BLOBS_EACH }, (_, flat) => {
        const seed = `w${Math.floor(flat / BLOBS_EACH)}${flat % BLOBS_EACH}`;
        return testContentKey('markdown', seed);
      });
      const facts = (await store.readBlobFacts([...new Set(keys)], ALL_BLOB_REQUEST)).rows;
      expect(facts.blobs).toHaveLength(new Set(keys).size);
    } finally {
      await store.close();
    }
  });

  it('never shows a reader half of a replaced extent', async () => {
    let writing = true;
    const writer = runWriter('c0', 'contended', CONTENDED_WRITES)
      .then((result) => { writing = false; return result; });

    const store = open();
    let samples = 0;
    let torn = 0;
    let attempts = 0;
    const deadline = Date.now() + READ_DEADLINE_MS;
    try {
      // Sample the shared extent while it is being rewritten. Both tables are
      // always written with the same row count, so an inequality can only come
      // from observing one table replaced and the other not.
      // Stops on evidence, not on the writer finishing: a reader looping until
      // the writer exits holds a read lock most of the time and starves it,
      // which turned a one-second arm into a twenty-second one. Enough samples
      // to catch a tear is all this needs.
      while (writing && samples < ENOUGH_SAMPLES && Date.now() < deadline) {
        attempts += 1;
        const extent = await store.readExtent({ rootId: 'root-shared', treeHash: 'tree-contended' }, ALL_EXTENT_REQUEST);
        if (extent !== undefined) {
          samples += 1;
          if (extent.roots.length !== extent.zoneProvenance.length) torn += 1;
        }
      }
    } finally {
      await store.close();
    }

    const result = await writer;
    // Exit code first: a writer that died is diagnosed as a crash, not as an
    // absence of samples.
    expect(result.code, result.stderr).toBe(0);
    // The sample count is asserted too: a zero from a loop that never observed
    // the extent is not evidence of anything.
    expect(samples, `${attempts} attempts`).toBeGreaterThan(0);
    expect(torn).toBe(0);
  });
});

/**
 * The two-writer arm's keys. Each writer holds the shared uncovered pair, an
 * uncovered marker of its own and its own three covered keys, so the union
 * (10) is larger than either held set (6), which is the window.
 */
/** A key of the two-writer arm, of the kind every contract key is. */
function armKey(seed: string): ContentKey {
  return testContentKey('markdown', seed);
}

const UNCOVERED = ['7', '8'].map((seed) => armKey(seed));
const MARKER_OF = { A: armKey('a'), B: armKey('b') } as const;
const COVERED_BY = { A: ['1', '2', '3'], B: ['4', '5', '6'] } as const;
/** The window, in keys; each writer's budget is this many keys' recorded bytes. */
const TWO_WRITER_WINDOW = 6;

type Writer = keyof typeof COVERED_BY;

/**
 * Seed the covered keys oldest first, INTERLEAVED (A1 B1 A2 B2 A3 B3), one
 * write each so every key has its own place in the ledger order.
 *
 * Interleaving is what makes the named mutant red whichever writer commits
 * second: the first writer's eviction takes A1 B1 A2, so the later writer
 * heals some of its keys and leaves others at the old end of the order, where
 * a writer that re-stamps only what it replaced then evicts them.
 */
async function seedInterleaved(): Promise<void> {
  const store = open();
  try {
    for (let index = 0; index < COVERED_BY.A.length; index += 1) {
      for (const seeds of [COVERED_BY.A, COVERED_BY.B]) {
        await store.writeBlobFacts(uncoveredBlobWrite(contractBlobRows(armKey(seeds[index] ?? ''))));
      }
    }
  } finally {
    await store.close();
  }
}

/**
 * The ledger's keys with their rowids and, per blob-scoped table, the keys it
 * holds rows for, read from the file.
 */
function ledgerAndRows(): { ledger: Map<string, number>; rows: Map<string, Set<string>> } {
  const database = new DatabaseSync(safePath.join(directory, 'projection.db'), { readOnly: true });
  try {
    const ledger = new Map((database.prepare('SELECT "contentKey", "rowid" AS id FROM "blob_keys"').all() as { contentKey: string; id: number }[])
      .map((row) => [row.contentKey, row.id] as const));
    const rows = new Map<string, Set<string>>();
    for (const spec of storedRelationSpecs().filter((candidate) => isProjectionTable(candidate))) {
      if (spec.scope !== 'blob') continue;
      const column = String(spec.primaryKey[0]);
      const keys = (database.prepare(`SELECT DISTINCT "${column}" AS k FROM "${spec.name}"`).all() as { k: string }[]).map((row) => row.k);
      rows.set(spec.name, new Set(keys));
    }
    return { ledger, rows };
  } finally {
    database.close();
  }
}

/**
 * The bytes one seeded key records: every key of the arm carries the same rows
 * but its key, and every key is the same length, so all record alike, which is
 * what lets a byte budget of N keys' bytes hold exactly N keys.
 *
 * @returns The one size every seeded key records
 */
function oneKeyBytes(): number {
  const database = new DatabaseSync(safePath.join(directory, 'projection.db'), { readOnly: true });
  try {
    const sizes = new Set((database.prepare('SELECT "bytes" FROM "blob_keys"').all() as { bytes: number }[]).map((row) => row.bytes));
    const [size] = sizes;
    if (sizes.size !== 1 || size === undefined) throw new Error(`the seeded keys record ${sizes.size} sizes, not one`);
    return size;
  } finally {
    database.close();
  }
}

/**
 * Which writer committed second, from the ledger: each writer's marker is a key
 * only it holds and never covers, so it replaces and stamps it in its own
 * transaction, and transactions are serialized, so the later commit holds the
 * larger rowid. An earlier writer's marker may since have been evicted; the
 * later writer's cannot be, by its own write or by the earlier one.
 *
 * 🪤 Not a sequence number taken after the commit: a child descheduled between
 * its commit and taking the number lets the other writer commit and take the
 * number first. Measured: the post-commit counter named the wrong writer in 1
 * of 20 runs against the correct writer.
 *
 * The row-set tier's arm reads the same way, on its own markers' ledger texts.
 *
 * @param ledger - Ledger key to rowid
 * @param markers - Each writer's marker, as the ledger keys it
 * @returns The later writer; the assertion fails when neither marker is held
 */
function laterWriter(ledger: ReadonlyMap<string, number>, markers: Readonly<Record<Writer, string>>): Writer {
  const a = ledger.get(markers.A) ?? -1;
  const b = ledger.get(markers.B) ?? -1;
  expect(a === b, 'neither writer\'s marker is in the ledger').toBe(false);
  return a > b ? 'A' : 'B';
}

/**
 * Run writers A and B at once, each with the arguments `argsOf` gives it, and require both exit 0.
 * Checked first, so a crashed writer is diagnosed as a crash rather than as a ledger disagreement.
 *
 * @param argsOf - A writer's script arguments after `<directory>`
 */
async function runTwoWriters(argsOf: (writer: Writer) => readonly string[]): Promise<void> {
  const results = await Promise.all((['A', 'B'] as const).map((writer) => runChild(argsOf(writer))));
  for (const [index, result] of results.entries()) {
    expect(result.code, `writer ${index}: ${result.stderr}`).toBe(0);
  }
}

describe('two writers sharing one store', () => {
  it('leave the ledger and the rows agreeing, and keep the later writer\'s whole held set', async () => {
    await seedInterleaved();
    const windowBytes = TWO_WRITER_WINDOW * oneKeyBytes();
    const barrier = mkdirSyncReal(safePath.join(directory, 'barrier'));
    const heldBy = (writer: Writer): string[] =>
      [...UNCOVERED, MARKER_OF[writer], ...COVERED_BY[writer].map((seed) => armKey(seed))];

    await runTwoWriters((writer) => [writer, 'covering', String(windowBytes), barrier, '2', heldBy(writer).join(',')]);
    const { ledger, rows } = ledgerAndRows();
    const later = laterWriter(ledger, MARKER_OF);

    // Every ledger key has its tier rows (the writers write a `blobs` and a
    // harness row per key), and no tier row's key lacks a ledger row.
    const blobs = rows.get('blobs') ?? new Set<string>();
    const harness = rows.get('harness_blob_facts') ?? new Set<string>();
    expect([...ledger.keys()].filter((key) => !blobs.has(key) || !harness.has(key)), 'ledger keys without their rows').toEqual([]);
    for (const [table, keys] of rows) {
      expect([...keys].filter((key) => !ledger.has(key)), `${table} rows without a ledger row`).toEqual([]);
    }
    const laterHeld = heldBy(later);
    expect(laterHeld.filter((key) => !ledger.has(key)), `writer ${later} (later) lost held keys`).toEqual([]);
    // Independent of the marker: the later commit re-stamped every key it
    // holds, so they are exactly the newest rowids in the ledger.
    const newest = [...ledger].sort(([, left], [, right]) => right - left).slice(0, laterHeld.length).map(([key]) => key);
    expect(new Set(newest), 'the newest ledger stamps are not the later writer\'s held set').toEqual(new Set(laterHeld));
  });
});

/**
 * The two-writer arm's row sets. Each writer covers its own three seeded row sets and holds, whole,
 * the three the other covers, beside the shared uncovered pair and a marker of its own: nine held
 * by each, ten in the union, against a window of six. Because each writer re-writes what the other
 * covers, neither's eviction can take a row set the later writer covered; a writer that stamps and
 * protects only what it replaced evicts its own covered row sets.
 */
const ROW_SET_UNCOVERED = ['rs-7', 'rs-8'];
const ROW_SET_MARKER_OF = { A: 'rs-a', B: 'rs-b' } as const;
const ROW_SET_COVERED_BY = { A: ['rs-1', 'rs-2', 'rs-3'], B: ['rs-4', 'rs-5', 'rs-6'] } as const;

/**
 * Seed the covered row sets oldest first, interleaved, one write each: {@link seedInterleaved}'s
 * order and reason, on the row-set tier.
 */
async function seedRowSetsInterleaved(): Promise<void> {
  const store = open();
  try {
    for (let index = 0; index < ROW_SET_COVERED_BY.A.length; index += 1) {
      for (const seeds of [ROW_SET_COVERED_BY.A, ROW_SET_COVERED_BY.B]) {
        await store.writeRowSets(uncoveredRowSetWrite(contractRowSet(contractRowSetId(seeds[index] ?? ''))));
      }
    }
  } finally {
    await store.close();
  }
}

/**
 * The store file.
 *
 * @param readOnly - Read-only for a count; writable to recover a killed writer's WAL first
 * @returns An open connection; close it when done
 */
function storeFile(readOnly: boolean): DatabaseSync {
  const database = new DatabaseSync(safePath.join(directory, 'projection.db'), { readOnly });
  // A writer opening the file switches it into WAL under a brief exclusive lock: wait it out, as the store does.
  database.exec('PRAGMA busy_timeout = 5000');
  return database;
}

/**
 * The row-set ledger's row sets with their rowids, and per row-set table each row set's row count,
 * read from the file.
 *
 * @returns Ledger row set text to rowid; table name to row set text to rows
 */
function rowSetLedgerAndRows(): { ledger: Map<string, number>; rows: Map<string, Map<string, number>> } {
  const database = storeFile(true);
  try {
    const ledger = new Map((database.prepare('SELECT "contentKey", "instance", "variant", "rowid" AS id FROM "row_set_keys"').all() as Record<string, string | number>[])
      .map((row) => [storedRowSetText(row['contentKey'], row['instance'], row['variant']), Number(row['id'])] as const));
    const rows = new Map<string, Map<string, number>>();
    for (const spec of storedRelationSpecs().filter((candidate) => isRowSetTable(candidate))) {
      const counted = database.prepare(`SELECT "blob", "variant", COUNT(*) AS n FROM "${spec.name}" GROUP BY "blob", "variant"`).all() as Record<string, string | number>[];
      rows.set(spec.name, new Map(counted.map((row) => [storedRowSetText(row['blob'], spec.instance, row['variant']), Number(row['n'])] as const)));
    }
    return { ledger, rows };
  } finally {
    database.close();
  }
}

/** @returns The one size every seeded row set records */
function oneRowSetBytes(): number {
  const database = storeFile(true);
  try {
    const sizes = new Set((database.prepare('SELECT "bytes" FROM "row_set_keys"').all() as { bytes: number }[]).map((row) => row.bytes));
    const [size] = sizes;
    if (sizes.size !== 1 || size === undefined) throw new Error(`the seeded row sets record ${sizes.size} sizes, not one`);
    return size;
  } finally {
    database.close();
  }
}

describe('two writers sharing one store\'s row-set tier', () => {
  it('leave the ledger and the rows agreeing, and keep every row set the later writer held', async () => {
    await seedRowSetsInterleaved();
    const windowBytes = TWO_WRITER_WINDOW * oneRowSetBytes();
    const barrier = mkdirSyncReal(safePath.join(directory, 'barrier'));
    const other = { A: 'B', B: 'A' } as const;
    const extractedBy = (writer: Writer): string[] => [...ROW_SET_UNCOVERED, ROW_SET_MARKER_OF[writer], ...ROW_SET_COVERED_BY[other[writer]]];
    const heldBy = (writer: Writer): string[] => [...ROW_SET_COVERED_BY[writer], ...extractedBy(writer)];

    await runTwoWriters((writer) =>
      [writer, 'covering-rowsets', String(windowBytes), barrier, '2', ROW_SET_COVERED_BY[writer].join(','), extractedBy(writer).join(',')]);
    const { ledger, rows } = rowSetLedgerAndRows();
    const markerText = (writer: Writer): string => rowSetIdText(contractRowSetId(ROW_SET_MARKER_OF[writer]));
    const later = laterWriter(ledger, { A: markerText('A'), B: markerText('B') });

    // A contract row set is one file, one document and one node: every ledger row set has them
    // all, and no row belongs to a row set the ledger lacks.
    for (const table of ['data__files', 'data__documents', 'data__nodes']) {
      const held = rows.get(table) ?? new Map<string, number>();
      expect([...ledger.keys()].filter((text) => held.get(text) !== 1), `ledger row sets without their one ${table} row`).toEqual([]);
    }
    for (const [table, held] of rows) {
      expect([...held.keys()].filter((text) => !ledger.has(text)), `${table} rows without a ledger row`).toEqual([]);
    }
    const laterHeld = heldBy(later).map((seed) => rowSetIdText(contractRowSetId(seed)));
    expect(laterHeld.filter((text) => !ledger.has(text)), `writer ${later} (later) lost held row sets`).toEqual([]);
    const newest = [...ledger].sort(([, left], [, right]) => right - left).slice(0, laterHeld.length).map(([text]) => text);
    expect(new Set(newest), 'the newest ledger stamps are not the later writer\'s held set').toEqual(new Set(laterHeld));
  });
});

/** Nodes per row set in the kill arm: enough that a write spends its time inside its transaction. */
const KILL_ARM_NODES = 2_000;

/** Committed row sets the kill arm waits for before it kills the writer. */
const KILL_AFTER_ROW_SETS = 8;

/**
 * How many row sets the ledger holds, read beside the writer.
 *
 * @returns The count; 0 while the writer has not yet created the file or its ledger
 */
function committedRowSets(): number {
  if (!existsSync(safePath.join(directory, 'projection.db'))) return 0;
  const database = storeFile(true);
  try {
    if (database.prepare('SELECT 1 FROM "sqlite_master" WHERE "name" = \'row_set_keys\'').get() === undefined) return 0;
    return Number((database.prepare('SELECT COUNT(*) AS n FROM "row_set_keys"').get() as { n: number }).n);
  } finally {
    database.close();
  }
}

/** Kills per run of the kill arm: a kill lands inside a write most of the time, not every time. */
const KILL_ROUNDS = 3;

/**
 * Start a `rowsets-until-killed` writer, wait until the ledger holds `committed` row sets, and
 * kill it.
 *
 * @param writerId - The writer's id, distinct per round so its row sets are new
 * @param committed - The ledger size to wait for
 * @returns Once the killed process has exited
 */
async function killWriterAfter(writerId: string, committed: number): Promise<void> {
  const child = spawn(process.execPath, [WRITER, directory, writerId, 'rowsets-until-killed', String(KILL_ARM_NODES)], { stdio: ['ignore', 'ignore', 'pipe'] });
  running.add(child);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => {
      running.delete(child);
      resolve();
    });
  });
  const deadline = Date.now() + READ_DEADLINE_MS;
  while (committedRowSets() < committed && child.exitCode === null && Date.now() < deadline) await sleep(5);
  expect(child.exitCode, `writer ${writerId} exited before it was killed: ${stderr}`).toBeNull();
  child.kill('SIGKILL');
  await exited;
}

describe('a row-set writer killed mid-write', () => {
  it('leaves no partial row set: each one stored is whole and in the ledger', async () => {
    const expected: Readonly<Record<string, number>> = { data__files: 1, data__documents: 1, data__nodes: KILL_ARM_NODES };
    for (let round = 1; round <= KILL_ROUNDS; round += 1) {
      await killWriterAfter(`K${String(round)}`, round * KILL_AFTER_ROW_SETS);
      // Writable first, so the killed writer's WAL is recovered before anything is counted.
      storeFile(false).close();
      const { ledger, rows } = rowSetLedgerAndRows();
      expect(ledger.size).toBeGreaterThanOrEqual(round * KILL_AFTER_ROW_SETS);
      for (const [table, count] of Object.entries(expected)) {
        const held = rows.get(table) ?? new Map<string, number>();
        expect([...ledger.keys()].filter((text) => held.get(text) !== count), `round ${String(round)}: ledger row sets without their ${String(count)} ${table} rows`).toEqual([]);
        expect([...held.keys()].filter((text) => !ledger.has(text)), `round ${String(round)}: ${table} rows without a ledger row`).toEqual([]);
      }
    }
  });
});
