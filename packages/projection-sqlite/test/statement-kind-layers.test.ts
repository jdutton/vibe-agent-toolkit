/**
 * A statement that is not a query is refused by two layers, and each refuses it alone.
 *
 * The first is the kind gate, which reads the leading keyword. The second is the program gate,
 * which asks SQLite itself: it compiles the statement as a subquery (`SELECT EXISTS (…)`), which
 * SQLite's grammar admits only for a `SELECT`, a `WITH … SELECT` or a `VALUES`. Neither layer reads
 * what the other reads, so loosening the keyword list cannot let a `PRAGMA` through.
 *
 * Each layer is called here on its own, with the other out of the path, as "disabled" means.
 */

import { DatabaseSync } from 'node:sqlite';

import { PROJECTION_STATEMENT_REFUSED_CODE } from '@vibe-agent-toolkit/resources';
import { isVatError, readWorkCounters } from '@vibe-agent-toolkit/utils';
import { __resetWorkCountersForTest } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertIsQuery, assertOpcodesAdmitted, assertProgramAdmitted, type GateConnection, openGate } from '../src/sql-gate.js';

/** What one call threw, or undefined. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The message of what one call threw. */
function messageOf(refusal: unknown): string {
  return refusal instanceof Error ? refusal.message : String(refusal);
}

/** The context a subquery refusal carries after SQLite's own error: how a non-query is refused. */
const SUBQUERY_CONTEXT = 'Only a SELECT, a WITH ... SELECT or a VALUES compiles as a subquery';
/** PRAGMA statements, row-returning and not, in the spellings a keyword scan could miss. */
const PRAGMA_STATEMENTS: readonly string[] = [
  'PRAGMA table_info(blobs)',
  'PRAGMA table_info("blobs")',
  'pragma database_list',
  'PRAGMA compile_options',
  'PRAGMA user_version',
  'PRAGMA main.index_list(blobs)',
  'PRAGMA query_only = 0',
  '/* a note */ PRAGMA table_info(blobs)',
  '-- a note\nPRAGMA table_info(blobs)',
  'PRAGMA table_info(blobs);',
];

/** Table-valued pragma functions inside a query: the keyword layer admits these by design. */
const PRAGMA_FUNCTIONS: readonly string[] = [
  "SELECT name FROM pragma_table_info('blobs')",
  'SELECT name FROM pragma_database_list',
  'SELECT * FROM pragma_compile_options',
  "SELECT name FROM pragma_index_list('blobs') AS json_each",
];

/** Queries both layers admit, including the forms a subquery wrapper could trip on. */
const QUERIES: readonly string[] = [
  'SELECT k FROM blobs',
  'SELECT 1 AS a, 2 AS b',
  'VALUES (1), (2)',
  'WITH c(x) AS (VALUES (1)) SELECT x FROM c',
  'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT i FROM n LIMIT 2',
  'SELECT 1 AS x UNION SELECT 2 ORDER BY 1',
  'SELECT k FROM blobs -- a trailing note',
  'SELECT k FROM blobs /* an unclosed trailing note',
  'SELECT k FROM blobs; -- a note after the terminator',
  'SELECT k FROM blobs WHERE k = ?',
];

let database: DatabaseSync;
let gate: GateConnection;

beforeAll(() => {
  database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE blobs (k TEXT, v TEXT); CREATE INDEX blobs_k ON blobs (k)');
  gate = openGate(database);
});

afterAll(() => {
  database.close();
});

describe('the precondition: SQLite compiles every PRAGMA on a bare connection', () => {
  it.each(PRAGMA_STATEMENTS)('%s', (sql) => {
    expect(() => database.prepare(sql)).not.toThrow();
  });
});

describe('the kind layer alone refuses a PRAGMA statement', () => {
  it.each(PRAGMA_STATEMENTS)('%s', (sql) => {
    expect(isVatError(thrownBy(() => assertIsQuery(sql)), PROJECTION_STATEMENT_REFUSED_CODE)).toBe(true);
  });
});

describe('the program layer alone refuses a PRAGMA statement', () => {
  it.each(PRAGMA_STATEMENTS)('%s', (sql) => {
    const refusal = thrownBy(() => assertProgramAdmitted(gate, sql));
    expect(isVatError(refusal, PROJECTION_STATEMENT_REFUSED_CODE), String(refusal)).toBe(true);
    // SQLite's own error leads; the read-only context follows it, so a PRAGMA still says why.
    expect(messageOf(refusal)).toMatch(/^near "pragma": syntax error\n/iu);
    expect(messageOf(refusal)).toContain(SUBQUERY_CONTEXT);
  });
});

describe('the program layer refuses a table-valued pragma function inside a query', () => {
  it.each(PRAGMA_FUNCTIONS)('%s', (sql) => {
    expect(() => assertIsQuery(sql)).not.toThrow();
    const refusal = thrownBy(() => assertProgramAdmitted(gate, sql));
    expect(isVatError(refusal, PROJECTION_STATEMENT_REFUSED_CODE), String(refusal)).toBe(true);
    expect(String(refusal)).toMatch(/opens the virtual table pragma_\w+/);
  });
});

describe('the program layer refuses a setting PRAGMA without applying it', () => {
  // SQLite applies a setting PRAGMA when it COMPILES one: `EXPLAIN PRAGMA recursive_triggers = 1`
  // flips the setting. So the program layer must refuse before it compiles the statement at all.
  const SETTINGS: readonly (readonly [string, number])[] = [
    ['recursive_triggers', 1],
    ['foreign_keys', 0],
    ['reverse_unordered_selects', 1],
    ['cache_size', 7],
  ];

  it.each(SETTINGS)('PRAGMA %s = %s', (name, value) => {
    const read = (): unknown => Object.values(database.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    const before = read();
    expect(before, 'the precondition: the value differs from the one the statement sets').not.toBe(value);

    const refusal = thrownBy(() => assertProgramAdmitted(gate, `PRAGMA ${name} = ${String(value)}`));

    expect(isVatError(refusal, PROJECTION_STATEMENT_REFUSED_CODE), String(refusal)).toBe(true);
    expect(read()).toBe(before);
  });
});

describe('a query SQLite compiles alone but not as a subquery: SQLite\'s own error', () => {
  // 999 nested additions: SQLite's expression-depth limit is 1000, and the subquery is one deeper.
  const sql = `SELECT 1${' + 1'.repeat(999)} AS x`;

  it('compiles alone, so the refusal below is the wrapper', () => {
    expect(() => database.prepare(sql)).not.toThrow();
  });

  it('is refused with SQLite\'s own reason', () => {
    const refusal = messageOf(thrownBy(() => assertProgramAdmitted(gate, sql)));
    expect(refusal.startsWith('Expression tree is too large'), refusal).toBe(true);
  });
});

describe('a write behind a WITH: refused by the subquery layer with SQLite\'s own error', () => {
  it('names SQLite\'s syntax error, and claims no nesting limit', () => {
    const refusal = thrownBy(() => assertProgramAdmitted(gate, 'WITH c AS (VALUES (1)) DELETE FROM blobs RETURNING k'));
    expect(isVatError(refusal, PROJECTION_STATEMENT_REFUSED_CODE), String(refusal)).toBe(true);
    expect(messageOf(refusal).startsWith('near "DELETE": syntax error\n'), messageOf(refusal)).toBe(true);
    expect(messageOf(refusal)).toContain(SUBQUERY_CONTEXT);
    expect(String(refusal)).not.toContain('nest');
  });

  it('a relation the run does not hold: the message LEADS with SQLite\'s own "no such table"', () => {
    // A typo must read as a typo: SQLite's error first, the read-only context after it.
    const refusal = thrownBy(() => assertProgramAdmitted(gate, 'SELECT * FROM nowhere'));
    expect(isVatError(refusal, PROJECTION_STATEMENT_REFUSED_CODE), String(refusal)).toBe(true);
    expect(messageOf(refusal).startsWith('no such table: nowhere\n'), messageOf(refusal)).toBe(true);
    expect(String(refusal)).not.toContain('not a query');
  });

  it('a missing column: the message LEADS with SQLite\'s own "no such column"', () => {
    const refusal = thrownBy(() => assertProgramAdmitted(gate, 'SELECT nope FROM blobs'));
    expect(messageOf(refusal).startsWith('no such column: nope\n'), messageOf(refusal)).toBe(true);
  });

  it.each([
    ['an unfinished WHERE', 'SELECT k FROM blobs WHERE'],
    ['an unclosed string', "SELECT 'a"],
  ])('%s: SQLite\'s error leads, and the context names the wrapper it may point into', (_label, sql) => {
    // SQLite parses `SELECT EXISTS (\n<statement>\n)`, so its error can name a `)` the author never
    // typed or span the wrapper's newline: the context must say what SQLite was given.
    const refusal = messageOf(thrownBy(() => assertProgramAdmitted(gate, sql)));
    expect(refusal).toMatch(/^(near|unrecognized token)/u);
    expect(refusal).toContain('wrapped as SELECT EXISTS (<statement>)');
  });

  it('carries SQLite\'s error, untouched, as its cause (a pin: the cause was carried before too)', () => {
    const refusal = thrownBy(() => assertProgramAdmitted(gate, 'SELECT * FROM nowhere'));
    const cause = refusal instanceof Error ? refusal.cause : undefined;
    expect(cause instanceof Error ? cause.message : cause).toBe('no such table: nowhere');
  });
});

describe('naming a refused virtual table costs a handful of EXPLAINs, not one per word', () => {
  it('a refused statement with a 500-value IN list', () => {
    const values = Array.from({ length: 500 }, (_, index) => String(index)).join(', ');
    const sql = `SELECT x.pageno IN (${values}) AS hit FROM dbstat AS x`;
    __resetWorkCountersForTest();
    expect(String(thrownBy(() => assertProgramAdmitted(gate, sql)))).toContain('opens the virtual table dbstat,');
    expect(readWorkCounters()['statement.explained']).toBeLessThanOrEqual(3);
  });
});

describe('the opcode layer alone refuses a write, the backstop behind the subquery check', () => {
  it.each([
    'WITH c AS (VALUES (1)) DELETE FROM blobs RETURNING k',
    "WITH c AS (VALUES (1)) INSERT INTO blobs (k) VALUES ('x') RETURNING k",
  ])('%s', (sql) => {
    const refusal = thrownBy(() => assertOpcodesAdmitted(gate, sql));
    expect(isVatError(refusal, PROJECTION_STATEMENT_REFUSED_CODE), String(refusal)).toBe(true);
    expect(String(refusal)).toContain('This statement writes');
    expect(database.prepare('SELECT COUNT(*) AS n FROM blobs').get()?.['n']).toBe(0);
  });
});

describe('a virtual-table refusal names the table, whatever alias it wears', () => {
  it.each([
    ['SELECT x.name FROM dbstat AS x', 'dbstat'],
    ['SELECT json_each.name FROM dbstat AS json_each', 'dbstat'],
    ['SELECT j.name FROM "dbstat" j', 'dbstat'],
    ["SELECT json_tree.name FROM pragma_table_info('blobs') AS json_tree", 'pragma_table_info'],
  ])('%s', (sql, table) => {
    expect(String(thrownBy(() => assertProgramAdmitted(gate, sql)))).toContain(`opens the virtual table ${table},`);
  });
});

describe('the controls: both layers admit a query', () => {
  it.each(QUERIES)('%s', (sql) => {
    expect(() => assertIsQuery(sql)).not.toThrow();
    expect(() => assertProgramAdmitted(gate, sql)).not.toThrow();
  });
});
