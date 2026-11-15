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

import { PROJECTION_STATEMENT_REFUSED_CODE } from '@vibe-agent-toolkit/resources';
import { isVatError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { isStatementRefusal, openGate, refreshRelationPagesAfter, runGated } from '../src/sql-gate.js';

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

/** What one call threw, or undefined. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** An engine-shaped `no such table`, as SQLite reports a table-valued function this build lacks. */
function noSuchTable(name: string): Error {
  return Object.assign(new Error(`no such table: ${name}`), { code: 'ERR_SQLITE_ERROR', errcode: 1 });
}

/**
 * A connection on which every `prepare` whose text matches `pattern` fails with `fault(matched)`, and
 * every other `prepare` reaches the real connection.
 *
 * @param database - The real connection
 * @param pattern - Which statements fail
 * @param fault - The error a matching statement throws, from the matched text
 * @returns The connection, as the gate sees it
 */
function withPrepareFault(database: DatabaseSync, pattern: RegExp, fault: (matched: string) => Error): DatabaseSync {
  return new Proxy(database, {
    get(target, key) {
      if (key === 'prepare') {
        return (sql: string) => {
          const matched = pattern.exec(sql)?.[0];
          if (matched !== undefined) throw fault(matched);
          return target.prepare(sql);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * A connection whose SQLite has no `jsonb_each` or `jsonb_tree`, as on the declared Node floor: every
 * `prepare` naming one fails as that build's does.
 *
 * @param database - The real connection
 * @returns The connection, as the gate sees it
 */
function withoutJsonb(database: DatabaseSync): DatabaseSync {
  return withPrepareFault(database, /jsonb_(?:each|tree)/u, noSuchTable);
}

describe('openGate — the reference functions this runtime has', () => {
  it('admits the members present and refuses a statement naming an absent one with the statement code', () => {
    const database = new DatabaseSync(':memory:');
    try {
      const gate = openGate(withoutJsonb(database));
      expect(gate.referenceVirtualTables.size).toBe(2);
      expect(runGated(gate, "SELECT j.value AS v FROM json_each('[1]') j", [], (statement) => statement.all()).map((row) => ({ ...row }))).toStrictEqual([{ v: 1 }]);
      const refused = thrownBy(() => runGated(gate, "SELECT j.value AS v FROM jsonb_each('[1]') j", [], (statement) => statement.all()));
      expect(isVatError(refused, PROJECTION_STATEMENT_REFUSED_CODE), String(refused)).toBe(true);
      expect(String(refused)).toContain('no such table: jsonb_each');
    } finally {
      database.close();
    }
  });

  // Only the reference probe fails, so the schema read after it cannot be what throws.
  it.each([
    [11, 'SQLITE_CORRUPT, the store failing'],
    [18, 'SQLITE_TOOBIG, a statement refusal that is not an absent name'],
  ])('propagates a probe failure that is not an absent function: errcode %i, %s', (errcode) => {
    const database = new DatabaseSync(':memory:');
    try {
      const fault = sqliteError(errcode);
      expect(thrownBy(() => openGate(withPrepareFault(database, /\bjson_each\b/u, () => fault)))).toBe(fault);
    } finally {
      database.close();
    }
  });
});

describe('refreshRelationPagesAfter — the write\'s failure wins, and only a write\'s', () => {
  it('propagates a refresh failure after a write that succeeded, and drops it after one that failed', () => {
    const database = new DatabaseSync(':memory:');
    const gate = openGate(database);
    database.close();
    expect(() => refreshRelationPagesAfter(gate, false)).toThrow(/not open/u);
    expect(() => refreshRelationPagesAfter(gate, true)).not.toThrow();
  });
});

describe('runGated — query_only stands behind every step', () => {
  it('refuses a write the step itself makes, with the engine\'s own words', () => {
    // The program gate refuses a write STATEMENT before it compiles; this is the
    // layer behind it. A step writing on the gated connection meets `query_only`.
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('CREATE TABLE t (x INTEGER)');
      const gate = openGate(database);
      const run = (): unknown => runGated(gate, 'SELECT 1 AS x', [], () => database.exec('DELETE FROM t'));
      expect(run).toThrow(/attempt to write a readonly database/);
      // Restored after: the handle's own writes still land.
      database.exec('INSERT INTO t VALUES (1)');
      expect(database.prepare('SELECT COUNT(*) AS n FROM t').get()?.['n']).toBe(1);
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
