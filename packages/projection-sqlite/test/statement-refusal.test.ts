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

import { isVatError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { isStatementRefusal, openGate, runGated } from '../src/sql-gate.js';

/** A `node:sqlite`-shaped error carrying one extended result code. */
function sqliteError(errcode: number): Error {
  return Object.assign(new Error(`sqlite errcode ${errcode}`), { code: 'ERR_SQLITE_ERROR', errcode });
}

describe('isStatementRefusal — exact extended codes only', () => {
  it.each([
    [1, 'SQLITE_ERROR — a name the schema lacks, a syntax error'],
    [8, 'SQLITE_READONLY — a write PRAGMA query_only stopped'],
    [18, 'SQLITE_TOOBIG — the statement built a string or blob over the engine\'s limit'],
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

describe('runGated — nothing attached reaches a statement', () => {
  it('refuses to prepare while a schema other than main and temp is attached, uncoded', () => {
    const database = new DatabaseSync(':memory:');
    try {
      const gate = openGate(database);
      // Attached directly, past the kind gate that refuses an ATTACH statement: this check is
      // what stands when something else attached one.
      database.exec(`ATTACH DATABASE ':memory:' AS x`);
      let caught: unknown;
      try {
        runGated(gate, 'SELECT 1 AS n', [], (statement) => statement.all());
      } catch (error) {
        caught = error;
      }
      expect(caught, 'a statement compiled beside an attached schema').toBeInstanceOf(Error);
      expect(String(caught)).toMatch(/"x" is attached/u);
      // A driver invariant, not the caller's statement: no statement code.
      expect(isVatError(caught), 'the refusal blames the statement').toBe(false);
    } finally {
      database.close();
    }
  });

  it('detaches every schema a step attached, a name needing quotes included', () => {
    const database = new DatabaseSync(':memory:');
    try {
      const gate = openGate(database);
      const rows = runGated(gate, 'SELECT 1 AS x', [], (statement) => {
        const answer = statement.all();
        // The step runs after the gate; a schema attached here is the sweep's to unwind.
        database.exec('PRAGMA query_only = 0');
        database.exec(`ATTACH DATABASE ':memory:' AS plain`);
        database.exec(`ATTACH DATABASE ':memory:' AS "we""ird"`);
        return answer;
      });
      expect(rows).toEqual([{ x: 1 }]);

      const schemas = (database.prepare('PRAGMA database_list').all() as { name: string }[]).map(({ name }) => name);
      expect(schemas).toEqual(['main']);
    } finally {
      database.close();
    }
  });
});

describe('runGated — the original failure always wins', () => {
  it('rethrows the step\'s error even when restoring the connection then fails', () => {
    const database = new DatabaseSync(':memory:');
    const gate = openGate(database);
    // The step faults AND leaves the connection unusable, so the `finally`'s
    // `PRAGMA query_only = 0` throws too — the case where a restore failure
    // would replace the error that actually happened.
    const run = (): unknown => runGated(gate, 'SELECT 1 AS x', [], () => {
      database.close();
      throw new Error('the original fault');
    });

    expect(run).toThrow('the original fault');
  });
});
