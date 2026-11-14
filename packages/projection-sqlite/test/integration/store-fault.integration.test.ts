/**
 * A fault in the STORE is not a fault in the caller's statement.
 *
 * `node:sqlite` reports every SQLite failure under one `code`,
 * `ERR_SQLITE_ERROR`; only the primary result code (`errcode & 0xff`) says
 * which. A gate that coded all of them `PROJECTION_STATEMENT_REFUSED` would
 * publish a corrupt database, a full disk or a lock timeout to `vat resources
 * query` as `USAGE_INVALID` — "your statement is wrong" — with no stack. This
 * file builds a real engine fault (a database whose file stopped being one
 * while a connection held it open) and pins that the statement gate lets it
 * propagate uncoded, next to a real statement refusal that must stay coded.
 *
 * The fault is subjected to the gate directly, over a raw connection to a real
 * file-backed store: the fact store has no SQL surface, and the run database is
 * in memory, so no file can stop being a database under it.
 */

import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { PROJECTION_STATEMENT_REFUSED_CODE } from '@vibe-agent-toolkit/resources';
import { isVatError, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { openRunDatabase, type RunDatabase } from '../../src/run-database.js';
import { runGated } from '../../src/sql-gate.js';
import { openSqliteFactStore } from '../../src/store.js';
import { sampleProjection } from '../fixtures.js';

/** What a call threw, or `undefined` when it did not throw. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The store's database file — `DATABASE_FILENAME` in `src/store.ts`, which is not exported. */
const DATABASE_FILE = 'projection.db';

describe('a store fault propagates uncoded (integration)', () => {
  let directory: string | undefined;
  let held: DatabaseSync | undefined;
  let database: RunDatabase | undefined;

  afterEach(async () => {
    held?.close();
    held = undefined;
    await database?.close().catch(() => undefined);
    database = undefined;
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  it('does NOT code "file is not a database" as a refused statement', async () => {
    directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-store-fault-'));
    // The fact store lays the schema down and puts the file in WAL mode.
    await openSqliteFactStore({ directory }).close();
    held = new DatabaseSync(safePath.join(directory, DATABASE_FILE));
    const openDatabase = held;
    runGated(openDatabase, 'SELECT COUNT(*) AS n FROM "blobs"', [], (statement) => statement.all());
    // A second connection commits, so the held connection's next read
    // transaction sees the WAL index move and must re-read pages rather than
    // serve its cache.
    const other = new DatabaseSync(safePath.join(directory, DATABASE_FILE));
    other.exec('PRAGMA user_version = 7');
    other.close();
    // Then the database and its WAL are overwritten while the connection holds
    // them open: the re-read finds no database.
    //
    // 🪤 IN PLACE (`r+`), and NEVER the `-shm` index. SQLite memory-maps and
    // byte-range-locks `-shm`; Windows refuses to truncate a mapped file
    // (`UNKNOWN`) and to write a locked range (`EBUSY`). The database and WAL
    // carry no lock in the bytes written here, so the fault is the same fault on
    // both OSes — and the commit above is what makes the stale cache visible.
    for (const file of readdirSync(directory).filter((name) => !name.endsWith('-shm'))) {
      const path = safePath.join(directory, file);
      const garbage = Buffer.alloc(Math.max(statSync(path).size, 4096), 0x5a);
      const descriptor = openSync(path, 'r+');
      try {
        writeSync(descriptor, garbage, 0, garbage.length, 0);
      } finally {
        closeSync(descriptor);
      }
    }

    const fault = thrownBy(() =>
      runGated(openDatabase, 'SELECT COUNT(*) AS n FROM "blobs"', [], (statement) => statement.all()));

    // The positive half first: the engine really did fail, with NOTADB.
    expect(fault).toBeInstanceOf(Error);
    expect((fault as { errcode?: number }).errcode).toBe(26);
    // And that failure is the database's, not the statement's.
    expect(isVatError(fault, PROJECTION_STATEMENT_REFUSED_CODE)).toBe(false);
  });

  it('still codes a name the schema lacks as a refused statement', () => {
    database = openRunDatabase(sampleProjection());
    const openDatabase = database;

    const refusal = thrownBy(() => openDatabase.query('SELECT "no_such_column" FROM "blobs"'));

    expect(isVatError(refusal, PROJECTION_STATEMENT_REFUSED_CODE)).toBe(true);
  });
});
