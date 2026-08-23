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

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteProjectionStore, type SqliteStoreOptions } from '../../src/store.js';

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

beforeEach(() => {
  directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-projection-sqlite-conc-'));
});

afterEach(() => {
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
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, directory, writerId, mode, String(iterations), ...retentionArgs], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/** Open a store on the shared directory. */
function open(options: Omit<SqliteStoreOptions, 'directory'> = {}) {
  return openSqliteProjectionStore({ ...options, directory });
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
  }, 30_000);
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
        const extent = await store.readExtent({ rootId: 'root-shared', treeHash: `tree-w${index}` });
        expect(extent, `writer ${index} extent`).toBeDefined();
      }
      // …and so did every blob row. Counting is the assertion: a lost row
      // throws nothing and exits 0.
      const keys = Array.from({ length: WRITERS * BLOBS_EACH }, (_, flat) => {
        const seed = `w${Math.floor(flat / BLOBS_EACH)}${flat % BLOBS_EACH}`;
        const digits = seed.padEnd(64, '0').slice(0, 64).replaceAll(/[^\da-f]/gu, '0');
        return `markdown.${digits}`;
      });
      const facts = await store.readBlobFacts([...new Set(keys)]);
      expect(facts.blobs).toHaveLength(new Set(keys).size);
    } finally {
      await store.close();
    }
  }, 30_000);

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
        const extent = await store.readExtent({ rootId: 'root-shared', treeHash: 'tree-contended' });
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
  }, 30_000);
});
