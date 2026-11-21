/**
 * `isStoreUnavailableNow`: which SQLite refusals say the store cannot answer
 * now while its file is sound, read off SQLite's primary result code anywhere
 * in the `cause` chain. The real lock is `cli`'s
 * `stored-document-contention.integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { isStoreUnavailableNow } from '../src/store.js';

/** A SQLite refusal as `node:sqlite` raises one. */
function sqliteError(errcode: number): Error {
  return Object.assign(new Error(`sqlite ${errcode}`), { code: 'ERR_SQLITE_ERROR', errcode });
}

describe('isStoreUnavailableNow', () => {
  it.each([
    ['SQLITE_BUSY', 5],
    ['SQLITE_LOCKED', 6],
    ['SQLITE_READONLY', 8],
    ['SQLITE_BUSY_RECOVERY, an extended code of the busy family', 5 | (1 << 8)],
    ['SQLITE_READONLY_DIRECTORY, an extended code of the read-only family', 8 | (6 << 8)],
    ['SQLITE_CANTOPEN, a read-only directory with no database to open', 14],
    ['SQLITE_CANTOPEN_ISDIR, an extended code of the cannot-open family', 14 | (2 << 8)],
  ])('answers yes for %s', (_name, errcode) => {
    expect(isStoreUnavailableNow(sqliteError(errcode))).toBe(true);
  });

  it.each([
    ['SQLITE_CORRUPT', 11],
    ['SQLITE_FULL', 13],
    ['SQLITE_NOTADB', 26],
    ['SQLITE_IOERR', 10],
  ])('answers no for %s', (_name, errcode) => {
    expect(isStoreUnavailableNow(sqliteError(errcode))).toBe(false);
  });

  it('reads the cause chain', () => {
    expect(isStoreUnavailableNow(new Error('wrapped', { cause: sqliteError(5) }))).toBe(true);
  });

  it('answers no for an error SQLite did not raise, whatever its errcode', () => {
    expect(isStoreUnavailableNow(Object.assign(new Error('database is locked'), { errcode: 5 }))).toBe(false);
  });
});
