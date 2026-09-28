/**
 * A fault in the STORE is not a fault in the caller's statement.
 *
 * `node:sqlite` reports every SQLite failure under one `code`,
 * `ERR_SQLITE_ERROR`; only the primary result code (`errcode & 0xff`) says
 * which. A store that coded all of them `PROJECTION_STATEMENT_REFUSED` would
 * publish a corrupt database, a full disk or a lock timeout to `vat resources
 * query` as `USAGE_INVALID` — "your statement is wrong" — with no stack. This
 * file builds a real engine fault (a database whose file stopped being one
 * while the store held it open) and pins that it propagates uncoded, next to a
 * real statement refusal that must stay coded.
 */

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { PROJECTION_STATEMENT_REFUSED_CODE } from '@vibe-agent-toolkit/resources';
import { isVatError, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteProjectionStore, type SqlQueryableStore } from '../../src/store.js';

/** What a call threw, or `undefined` when it did not throw. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('a store fault propagates uncoded (integration)', () => {
  let directory: string | undefined;
  let store: SqlQueryableStore | undefined;

  afterEach(async () => {
    await store?.close().catch(() => undefined);
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  it('does NOT code "file is not a database" as a refused statement', () => {
    directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-store-fault-'));
    store = openSqliteProjectionStore({ directory });
    // The database, its WAL and its shared-memory index all overwritten while
    // the connection is open: the next read transaction finds no database.
    for (const file of readdirSync(directory)) {
      const path = safePath.join(directory, file);
      writeFileSync(path, Buffer.alloc(Math.max(statSync(path).size, 4096), 0x5a));
    }
    const openStore = store;

    const fault = thrownBy(() => openStore.query('SELECT COUNT(*) AS n FROM "blobs"'));

    // The positive half first: the engine really did fail, with NOTADB.
    expect(fault).toBeInstanceOf(Error);
    expect((fault as { errcode?: number }).errcode).toBe(26);
    // And that failure is the store's, not the statement's.
    expect(isVatError(fault, PROJECTION_STATEMENT_REFUSED_CODE)).toBe(false);
  });

  it('still codes a name the schema lacks as a refused statement', () => {
    directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-store-fault-'));
    store = openSqliteProjectionStore({ directory });
    const openStore = store;

    const refusal = thrownBy(() => openStore.query('SELECT "no_such_column" FROM "blobs"'));

    expect(isVatError(refusal, PROJECTION_STATEMENT_REFUSED_CODE)).toBe(true);
  });
});
