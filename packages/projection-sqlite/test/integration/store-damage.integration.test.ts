/**
 * A store file that cannot be opened is recognisable as such, and can be
 * discarded; a store that closes leaves one complete database file behind.
 *
 * Both exist for a cache directory that CI saves and restores
 * (`VAT_CACHE_DIR`): a restored file can be damaged, and a saved directory must
 * not depend on a `-wal` file that a partial save could leave out.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { ALL_EXTENT_REQUEST, type ExtentKey } from '@vibe-agent-toolkit/resources';
import { isVatError, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROJECTION_STORE_UNOPENABLE_CODE,
  discardStoreDatabase,
  isStoreInUse,
  isStoreUnopenableError,
  DEFAULT_BLOB_TIER_BUDGET_BYTES,
  DEFAULT_ROW_SET_TIER_BUDGET_BYTES,
  openSqliteFactStore,
} from '../../src/store.js';
import { sampleExtentRows } from '../fixtures.js';

const KEY: ExtentKey = { rootId: 'root-1', treeHash: 'tree-aaa' };

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-projection-damage-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** The store's database file under the test directory. */
function databaseFile(dir: string = directory): string {
  return safePath.join(dir, 'projection.db');
}

/** What opening the store threw, or `undefined`. */
async function openFailure(): Promise<unknown> {
  try {
    const store = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
    await store.close();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Write a real store holding one extent, and close it. */
async function writeRealStore(dir: string = directory): Promise<void> {
  const store = openSqliteFactStore({ directory: dir, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
  await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
  await store.close();
}

describe('a damaged store file is reported as unopenable', () => {
  it('names a file that is not a database, with SQLite\'s own error', async () => {
    writeFileSync(databaseFile(), Buffer.alloc(4096, 0x5a));
    const error = await openFailure();
    expect(isStoreUnopenableError(error)).toBe(true);
    expect(isVatError(error, PROJECTION_STORE_UNOPENABLE_CODE)).toBe(true);
    expect(isStoreUnopenableError(error) ? error.databasePath : '').toBe(databaseFile());
    expect(String((error as Error).message)).toMatch(/not a database/u);
  });

  it('names a truncated database', async () => {
    await writeRealStore();
    const bytes = readFileSync(databaseFile());
    writeFileSync(databaseFile(), bytes.subarray(0, Math.floor(bytes.length / 2)));
    const error = await openFailure();
    expect(isStoreUnopenableError(error)).toBe(true);
    expect(String((error as Error).message)).toMatch(/malformed|not a database/u);
  });

  it('never calls a store it could not open at all (SQLITE_CANTOPEN) damaged: that is the machine, not the file', async () => {
    // A directory where the database file should be: SQLite cannot open it, and deleting files
    // will not fix it. Reporting it as unopenable would invite the caller to discard a cache
    // that is not broken (a permission or path fault is the machine's state).
    mkdirSyncReal(databaseFile());
    const error = await openFailure();
    expect(error).toBeInstanceOf(Error);
    expect(isStoreUnopenableError(error)).toBe(false);
  });

  it('is discarded whole, and a fresh store opens in its place', async () => {
    writeFileSync(databaseFile(), Buffer.alloc(4096, 0x5a));
    writeFileSync(`${databaseFile()}-wal`, 'stale');
    writeFileSync(`${databaseFile()}-shm`, 'stale');
    const error = await openFailure();
    if (!isStoreUnopenableError(error)) throw new Error('expected an unopenable store');

    discardStoreDatabase(error.databasePath);
    expect(readdirSync(directory)).toEqual([]);

    const store = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
    try {
      expect(await store.readExtent(KEY, ALL_EXTENT_REQUEST)).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});

describe('close leaves one complete database file', () => {
  it('checkpoints the WAL into projection.db even while another connection is open', async () => {
    // Without a checkpoint, a second open connection keeps SQLite from folding
    // the WAL back on close, and the committed rows live only in `-wal`.
    const bystander = new DatabaseSync(databaseFile(directory), { open: false });
    const store = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
    bystander.open();
    // A finished read: the connection now has the WAL index mapped, holding no
    // transaction — an idle second `vat` process, not a reader mid-snapshot.
    bystander.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
    try {
      await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
      await store.close();

      const copy = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-projection-copy-'));
      try {
        // Only the database file: what a save that missed `-wal` would carry.
        writeFileSync(databaseFile(copy), readFileSync(databaseFile()));
        const reopened = openSqliteFactStore({ directory: copy, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
        try {
          expect((await reopened.readExtent(KEY, ALL_EXTENT_REQUEST))?.resources).toHaveLength(1);
        } finally {
          await reopened.close();
        }
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    } finally {
      bystander.close();
    }
  });

  it('closes without failing while a reader holds a snapshot, and the store stays consistent', async () => {
    await writeRealStore();
    const store = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
    await store.writeExtent({ ...KEY, treeHash: 'tree-bbb' }, sampleExtentRows(KEY.rootId));

    const reader = new DatabaseSync(databaseFile());
    try {
      reader.exec('BEGIN');
      // A read inside the transaction pins the reader to its snapshot, so a
      // TRUNCATE checkpoint cannot complete while it is held.
      reader.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
      await expect(store.close()).resolves.toBeUndefined();
      reader.exec('COMMIT');
    } finally {
      reader.close();
    }

    const check = new DatabaseSync(databaseFile());
    try {
      expect(check.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
    } finally {
      check.close();
    }
    const reopened = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
    try {
      expect((await reopened.readExtent({ ...KEY, treeHash: 'tree-bbb' }, ALL_EXTENT_REQUEST))?.resources).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });
});

describe('whether another connection has a store open', () => {
  it('says so while an open store holds it, and not once it is closed', async () => {
    const store = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
    expect(isStoreInUse(directory)).toBe(true);
    await store.close();
    expect(isStoreInUse(directory)).toBe(false);
  });

  it('counts an idle reader connection as in use', async () => {
    await writeRealStore();
    const reader = new DatabaseSync(databaseFile());
    try {
      reader.prepare('SELECT 1').get();
      expect(isStoreInUse(directory)).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('is not in use when absent, and asking never creates the file', () => {
    expect(isStoreInUse(directory)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('is not in use when the file is not a database: nothing could hold it', () => {
    writeFileSync(databaseFile(), Buffer.alloc(4096, 0x5a));
    expect(isStoreInUse(directory)).toBe(false);
  });
});
