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
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { ALL_BLOB_REQUEST, ALL_EXTENT_REQUEST, PROJECTION_TABLES } from '@vibe-agent-toolkit/resources';
import { contractBlobRows, contractContentKey, uncoveredBlobWrite } from '@vibe-agent-toolkit/resources/testing';
import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteFactStore, type SqliteStoreOptions } from '../../src/store.js';

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
function open(options: Omit<SqliteStoreOptions, 'directory'> = {}) {
  return openSqliteFactStore({ ...options, directory });
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
        const digits = seed.padEnd(64, '0').slice(0, 64).replaceAll(/[^\da-f]/gu, '0');
        return `markdown.${digits}`;
      });
      const facts = await store.readBlobFacts([...new Set(keys)], ALL_BLOB_REQUEST);
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
const UNCOVERED = ['7', '8'].map((seed) => contractContentKey(seed));
const MARKER_OF = { A: contractContentKey('a'), B: contractContentKey('b') } as const;
const COVERED_BY = { A: ['1', '2', '3'], B: ['4', '5', '6'] } as const;
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
  const store = open({ retainedBlobKeys: 100 });
  try {
    for (let index = 0; index < COVERED_BY.A.length; index += 1) {
      for (const seeds of [COVERED_BY.A, COVERED_BY.B]) {
        await store.writeBlobFacts(uncoveredBlobWrite(contractBlobRows(contractContentKey(seeds[index] ?? ''))));
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
    for (const spec of Object.values(PROJECTION_TABLES)) {
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
 * @param ledger - Ledger key to rowid
 * @returns The later writer, or `undefined` when neither marker is held
 */
function laterWriter(ledger: ReadonlyMap<string, number>): Writer | undefined {
  const a = ledger.get(MARKER_OF.A) ?? -1;
  const b = ledger.get(MARKER_OF.B) ?? -1;
  if (a === b) return undefined;
  return a > b ? 'A' : 'B';
}

describe('two writers sharing one store', () => {
  it('leave the ledger and the rows agreeing, and keep the later writer\'s whole held set', async () => {
    await seedInterleaved();
    const barrier = mkdirSyncReal(safePath.join(directory, 'barrier'));
    const heldBy = (writer: Writer): string[] =>
      [...UNCOVERED, MARKER_OF[writer], ...COVERED_BY[writer].map((seed) => contractContentKey(seed))];

    const results = await Promise.all((['A', 'B'] as const).map((writer) =>
      runChild([writer, 'covering', String(TWO_WRITER_WINDOW), barrier, '2', heldBy(writer).join(',')])));

    for (const [index, result] of results.entries()) {
      expect(result.code, `writer ${index}: ${result.stderr}`).toBe(0);
    }
    const { ledger, rows } = ledgerAndRows();
    const later = laterWriter(ledger);
    expect(later, 'neither writer\'s marker is in the ledger').toBeDefined();

    // Every ledger key has its tier rows (the writers write a `blobs` and a
    // harness row per key), and no tier row's key lacks a ledger row.
    const blobs = rows.get('blobs') ?? new Set<string>();
    const harness = rows.get('harness_blob_facts') ?? new Set<string>();
    expect([...ledger.keys()].filter((key) => !blobs.has(key) || !harness.has(key)), 'ledger keys without their rows').toEqual([]);
    for (const [table, keys] of rows) {
      expect([...keys].filter((key) => !ledger.has(key)), `${table} rows without a ledger row`).toEqual([]);
    }
    const laterHeld = heldBy(later ?? 'A');
    expect(laterHeld.filter((key) => !ledger.has(key)), `writer ${String(later)} (later) lost held keys`).toEqual([]);
    // Independent of the marker: the later commit re-stamped every key it
    // holds, so they are exactly the newest rowids in the ledger.
    const newest = [...ledger].sort(([, left], [, right]) => right - left).slice(0, laterHeld.length).map(([key]) => key);
    expect(new Set(newest), 'the newest ledger stamps are not the later writer\'s held set').toEqual(new Set(laterHeld));
  });
});
