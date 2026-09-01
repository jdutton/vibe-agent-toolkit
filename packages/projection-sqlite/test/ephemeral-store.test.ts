/**
 * The ephemeral, in-memory store.
 *
 * Stage 5 answers a query against the projection whether or not a store
 * happened to be on disk. If `vat resources query` only worked where a cache
 * existed, the answer would depend on whether one was there, and two callers
 * would hold differently-shaped views of one tree — the same divergence
 * objection that killed demand-scoped blobs. So the on-disk store is purely a
 * speed-up: with none, stage 5 builds this store from the projection and runs
 * the same SQL against the same schema. One dialect, one schema, one answer.
 *
 * 🪤 **The file-backed configuration cannot simply be pointed at `:memory:`.**
 * Measured on Node 24.13.1: `PRAGMA journal_mode = WAL` on an in-memory
 * database is *accepted without throwing* and leaves the mode at `memory`. So
 * `enableWal`'s `catch` never fires, its `journalMode()` check never returns
 * `'wal'`, all 50 attempts burn a blocking `Atomics.wait`, and it ends at the
 * final `throw` — after about a second — with the wrong diagnosis: it names a
 * rollback journal, and this is a memory journal. The retry loop is correct for
 * its real purpose (racing processes on a cold *file*, where WAL is a
 * persistent property of the file); it simply has no meaning without one.
 *
 * That is why these tests assert on opening at all, not only on round-tripping:
 * routing the ephemeral store back through the file-backed `configure()` is the
 * regression, and it throws rather than silently degrading.
 */

import { mkdtempSync, rmSync } from 'node:fs';

import type { ExtentKey, ProjectionStore } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openEphemeralProjectionStore, openSqliteProjectionStore } from '../src/store.js';

import { FIRST_BLOB, SECOND_BLOB, sampleBlobRows, sampleExtentRows } from './fixtures.js';

const KEY: ExtentKey = { rootId: 'root-1', treeHash: 'tree-aaa' };

/**
 * A bound generous enough that only the WAL stall can trip it.
 *
 * The stall is 50 × 20 ms of blocking `Atomics.wait` — about a second — against
 * single-digit milliseconds for an honest open. Two orders of magnitude of
 * headroom, so this measures the defect and not the machine.
 */
const OPEN_BUDGET_MS = 300;

let store: ProjectionStore;

beforeEach(() => {
  store = openEphemeralProjectionStore();
});

afterEach(async () => {
  await store.close();
});

describe('openEphemeralProjectionStore', () => {
  it('opens without throwing, and without the file-backed WAL stall', async () => {
    const before = performance.now();
    const opened = openEphemeralProjectionStore();
    const elapsed = performance.now() - before;
    await opened.close();

    expect(
      elapsed,
      'opening took long enough to be the WAL retry loop — the ephemeral store must bypass enableWal, '
      + 'which cannot succeed on an in-memory database and burns ~1s before throwing',
    ).toBeLessThan(OPEN_BUDGET_MS);
  });

  it('round-trips an extent write, so a query gets rows and not an empty answer', async () => {
    await store.writeBlobFacts(sampleBlobRows());
    await store.writeExtent(KEY, sampleExtentRows(FIRST_BLOB));

    const read = await store.readExtent(KEY);

    expect(read, 'a written extent read back as a miss').toBeDefined();
    expect(read).toEqual(sampleExtentRows(FIRST_BLOB));
  });

  it('reports a miss for an extent it never wrote', async () => {
    const read = await store.readExtent({ rootId: 'root-1', treeHash: 'never-written' });

    expect(read, 'an unwritten extent must be a miss, not empty tables').toBeUndefined();
  });

  it('holds nothing across instances — it is a cache that cannot hit', async () => {
    await store.writeBlobFacts(sampleBlobRows());
    await store.writeExtent(KEY, sampleExtentRows(FIRST_BLOB));

    const fresh = openEphemeralProjectionStore();
    try {
      expect(
        await fresh.readExtent(KEY),
        "a second ephemeral store saw the first one's rows — it is sharing a file, not memory",
      ).toBeUndefined();
    } finally {
      await fresh.close();
    }
  });
});

/**
 * The contract that matters: **the same SQL must get the same answer** whether
 * a store was on disk or not. A round-trip test on the ephemeral store alone
 * would pass against a schema that had quietly diverged from the file-backed
 * one, so both are written the same way and their reads compared directly.
 */
describe('the ephemeral store answers identically to the file-backed one', () => {
  let directory: string;
  let onDisk: ProjectionStore;

  beforeEach(() => {
    directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-projection-ephemeral-'));
    onDisk = openSqliteProjectionStore({ directory });
  });

  afterEach(async () => {
    await onDisk.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('returns the same rows for the same writes', async () => {
    for (const target of [store, onDisk]) {
      await target.writeBlobFacts(sampleBlobRows());
      await target.writeBlobFacts(sampleBlobRows(SECOND_BLOB));
      await target.writeExtent(KEY, sampleExtentRows(FIRST_BLOB));
    }

    const fromMemory = await store.readExtent(KEY);
    const fromDisk = await onDisk.readExtent(KEY);

    expect(fromDisk, 'the file-backed control read back as a miss — the comparison is vacuous').toBeDefined();
    expect(fromMemory).toEqual(fromDisk);
  });

  it('agrees on a miss too', async () => {
    const absent: ExtentKey = { rootId: 'root-1', treeHash: 'never-written' };

    expect(await store.readExtent(absent)).toEqual(await onDisk.readExtent(absent));
    expect(await onDisk.readExtent(absent)).toBeUndefined();
  });
});
