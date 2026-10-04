/**
 * Which SQLite failures are the CALLER'S statement, and which are the store.
 *
 * `node:sqlite` reports every failure under `code: 'ERR_SQLITE_ERROR'` and puts
 * SQLite's EXTENDED result code in `errcode`. Only exact codes are the
 * statement's fault; masking to the primary code (`& 0xff`) folded the whole
 * READONLY family in — `SQLITE_READONLY_DIRECTORY` (1544) and
 * `SQLITE_READONLY_CANTINIT` (1288) are a read-only store directory, an
 * environment fault, and a WAL-mode SELECT can meet either.
 */

import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { isStatementRefusal, runGated } from '../src/store.js';

/** A `node:sqlite`-shaped error carrying one extended result code. */
function sqliteError(errcode: number): Error {
  return Object.assign(new Error(`sqlite errcode ${errcode}`), { code: 'ERR_SQLITE_ERROR', errcode });
}

describe('isStatementRefusal — exact extended codes only', () => {
  it.each([
    [1, 'SQLITE_ERROR — a name the schema lacks, a syntax error'],
    [8, 'SQLITE_READONLY — a write PRAGMA query_only stopped'],
    [25, 'SQLITE_RANGE — a bind index out of range'],
    [257, 'SQLITE_ERROR_MISSING_COLLSEQ — the statement names a collation that does not exist'],
  ])('codes %i (%s) as the statement\'s refusal', (errcode) => {
    expect(isStatementRefusal(sqliteError(errcode))).toBe(true);
  });

  it.each([
    [1544, 'SQLITE_READONLY_DIRECTORY'],
    [1288, 'SQLITE_READONLY_CANTINIT'],
    [264, 'SQLITE_READONLY_RECOVERY'],
    [520, 'SQLITE_READONLY_CANTLOCK'],
    [776, 'SQLITE_READONLY_ROLLBACK'],
    [1032, 'SQLITE_READONLY_DBMOVED'],
    [513, 'SQLITE_ERROR_RETRY'],
    [769, 'SQLITE_ERROR_SNAPSHOT'],
    [26, 'SQLITE_NOTADB'],
    [11, 'SQLITE_CORRUPT'],
    [5, 'SQLITE_BUSY'],
    [2067, 'SQLITE_CONSTRAINT_UNIQUE'],
  ])('does NOT code %i (%s) — the store failed, not the statement', (errcode) => {
    expect(isStatementRefusal(sqliteError(errcode))).toBe(false);
  });

  it('does not code an error that is not node:sqlite\'s', () => {
    expect(isStatementRefusal(Object.assign(new Error('x'), { errcode: 1 }))).toBe(false);
  });
});

describe('runGated — the original failure always wins', () => {
  it('rethrows the step\'s error even when restoring the connection then fails', () => {
    const database = new DatabaseSync(':memory:');
    // The step faults AND leaves the connection unusable, so the `finally`'s
    // `PRAGMA query_only = 0` throws too — the case where a restore failure
    // would replace the error that actually happened.
    const run = (): unknown => runGated(database, 'SELECT 1 AS x', [], () => {
      database.close();
      throw new Error('the original fault');
    });

    expect(run).toThrow('the original fault');
  });
});
