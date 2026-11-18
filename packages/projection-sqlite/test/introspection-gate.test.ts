/**
 * The introspection gate: a statement may read the rows of the relations a run hydrated, and
 * nothing that says which relations exist, how they are stored, or what the connection last did.
 *
 * Hydration holds only the relations a run's statements name, so "which relations exist" would
 * otherwise say what the run asked; the schema table, `dbstat` and every `pragma_*` function answer
 * exactly that. Each form is asked through all three gated surfaces — `query`, `columns` and the
 * compile probe — alone and beside a hydrated relation, in a join and under `UNION ALL`, since
 * "beside" is within one statement.
 */

import { DatabaseSync } from 'node:sqlite';

import { PROJECTION_STATEMENT_REFUSED_CODE } from '@vibe-agent-toolkit/resources';
import { isVatError, readWorkCounters } from '@vibe-agent-toolkit/utils';
import { __resetWorkCountersForTest } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  hydrateRunDatabase,
  openProjectionCompileProbe,
  type ProjectionCompileProbe,
  type RunDatabase,
} from '../src/run-database.js';
import { isStatementRefusal } from '../src/sql-gate.js';

import { closeGatedHandles, openGatedHandles, sampleProjection } from './fixtures.js';

/**
 * Whether this runtime's SQLite has a table-valued function. `jsonb_each` and `jsonb_tree` arrived in
 * SQLite 3.51.0: Node 22.16.0 (SQLite 3.49.1) lacks them, Node 22.23.3 (SQLite 3.51.3) has them.
 *
 * @param name - The function
 * @returns True when it compiles
 */
function runtimeHas(name: string): boolean {
  const database = new DatabaseSync(':memory:');
  try {
    database.prepare(`SELECT * FROM ${name}('[]')`);
    return true;
  } catch (error) {
    if (isStatementRefusal(error) && error.message.includes(`no such table: ${name}`)) return false;
    throw error;
  } finally {
    database.close();
  }
}

/** A FROM item that describes the database, exposing a `name` column, and the alias it reads as. */
interface IntrospectionSource {
  readonly label: string;
  /** The FROM item, aliased. */
  readonly item: string;
  readonly alias: string;
}

/** The sources, two of them aliased to a JSON walker's name — the alias changes nothing EXPLAIN shows. */
const INTROSPECTION_SOURCES: readonly IntrospectionSource[] = [
  { label: 'dbstat', item: 'dbstat AS x', alias: 'x' },
  { label: 'pragma_table_info', item: "pragma_table_info('blobs') AS x", alias: 'x' },
  { label: 'sqlite_schema', item: 'sqlite_schema AS x', alias: 'x' },
  { label: 'sqlite_temp_schema', item: 'sqlite_temp_schema AS x', alias: 'x' },
  { label: 'dbstat under a json_each alias', item: 'dbstat AS json_each', alias: 'json_each' },
  { label: 'pragma_table_info under a json_tree alias', item: "pragma_table_info('blobs') AS json_tree", alias: 'json_tree' },
];

/** Each source alone, joined to a hydrated relation, and beside one under UNION ALL. */
const INTROSPECTING_STATEMENTS: readonly (readonly [string, string])[] = INTROSPECTION_SOURCES.flatMap(({ label, item, alias }) => [
  [`${label}, alone`, `SELECT ${alias}.name FROM ${item}`],
  [`${label}, joined to blobs`, `SELECT b."contentKey", ${alias}.name FROM "blobs" b, ${item}`],
  [`${label}, beside blobs under UNION ALL`, `SELECT "contentKey" AS v FROM "blobs" UNION ALL SELECT ${alias}.name FROM ${item}`],
]);

/** The connection-state functions, alone and beside a hydrated relation. */
const CONNECTION_STATE_STATEMENTS: readonly (readonly [string, string])[] = ['changes', 'total_changes', 'last_insert_rowid'].flatMap((name) => [
  [`${name}(), alone`, `SELECT ${name}() AS n`],
  [`${name}(), beside blobs`, `SELECT "contentKey", ${name}() AS n FROM "blobs"`],
]);

/**
 * Named-parameter forms positional values never reach: each binds NULL or drops a tail. `$` is a
 * name character after every sigil, as in SQLite's tokenizer, so `#$`, `@$`, `:$` and `$$` are
 * parameters too.
 */
const NAMED_PARAMETER_STATEMENTS: readonly (readonly [string, string])[] = [
  ['a # parameter, which binds NULL', 'SELECT "path" FROM "resource_realizations" WHERE "path" = #p'],
  ['a # parameter whose suffix hides a second statement', `SELECT "path" FROM "resource_realizations" WHERE "path" <> #p(') ; SELECT 'x`],
  ...['#$', '@$', ':$', '$$'].map((name) => [`the parameter ${name}`, `SELECT "path" FROM "resource_realizations" WHERE "path" = ${name}`] as const),
  ['a #$ parameter whose suffix hides a second statement', `SELECT "path" FROM "resource_realizations" WHERE "path" <> #$(') ; SELECT 'x`],
];

/** A NUL ends the statement for SQLite, which drops everything after it. */
const NUL_STATEMENTS: readonly (readonly [string, string])[] = [
  ['a NUL before a WHERE that would select nothing', 'SELECT 1 AS x\u0000 WHERE 0'],
];

/** A write passes the kind gate on its first keyword and compiles; it must never be admitted. */
const WRITE_STATEMENTS: readonly (readonly [string, string])[] = [
  ['a DELETE with RETURNING under a WITH', 'WITH c AS (VALUES (1)) DELETE FROM "blobs" RETURNING "contentKey"'],
];

/** The refusals every gated surface must make. */
const REFUSED: readonly (readonly [string, string])[] = [
  ...INTROSPECTING_STATEMENTS,
  ...CONNECTION_STATE_STATEMENTS,
  ...NAMED_PARAMETER_STATEMENTS,
  ...NUL_STATEMENTS,
  ...WRITE_STATEMENTS,
];

/** What one call threw, or undefined. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

let database: RunDatabase;
let probe: ProjectionCompileProbe;

beforeAll(() => {
  ({ database, probe } = openGatedHandles(['blobs', 'resourceRealizations']));
});

afterAll(async () => {
  await closeGatedHandles({ database, probe });
});

describe('the precondition: the introspection sources exist on this SQLite', () => {
  it('compiles dbstat and pragma_table_info on a bare connection, so a refusal below is the gate', () => {
    const bare = new DatabaseSync(':memory:');
    try {
      bare.exec('CREATE TABLE "blobs" ("contentKey" TEXT)');
      for (const { item, alias } of INTROSPECTION_SOURCES) {
        expect(() => bare.prepare(`SELECT ${alias}.name FROM ${item}`), item).not.toThrow();
      }
    } finally {
      bare.close();
    }
  });
});

describe('the introspection gate refuses, with the statement code, on every gated surface', () => {
  it.each(REFUSED)('query: %s', (_label, sql) => {
    expect(isVatError(thrownBy(() => database.query(sql)), PROJECTION_STATEMENT_REFUSED_CODE), sql).toBe(true);
  });

  it.each(REFUSED)('columns: %s', (_label, sql) => {
    expect(isVatError(thrownBy(() => database.columns(sql)), PROJECTION_STATEMENT_REFUSED_CODE), sql).toBe(true);
  });

  it.each(REFUSED)('compile probe: %s', (_label, sql) => {
    expect(isVatError(thrownBy(() => probe.assertCompiles(sql, [])), PROJECTION_STATEMENT_REFUSED_CODE), sql).toBe(true);
  });
});

describe('a write is refused by the gate itself, before it runs, on every gated surface', () => {
  // The coded refusal above does not tell the gate from `PRAGMA query_only`, which also refuses a
  // write once `query` steps it. Only the gate says this.
  it.each(WRITE_STATEMENTS)('%s', (_label, sql) => {
    for (const surface of [() => database.query(sql), () => database.columns(sql), () => probe.assertCompiles(sql, [])]) {
      expect(String(thrownBy(surface))).toContain('SQLite does not accept this statement as a subquery');
    }
  });
});

describe('a relation the run did not hydrate', () => {
  // A real relation, which the compile probe holds: only its absence here can refuse it.
  const sql = 'SELECT "title" FROM "blob_sections"';

  it('is one the compile probe compiles, so the refusal below is the absence', () => {
    expect(() => probe.assertCompiles(sql, [])).not.toThrow();
  });

  it('refuses through query and columns with the statement code', () => {
    expect(isVatError(thrownBy(() => database.query(sql)), PROJECTION_STATEMENT_REFUSED_CODE)).toBe(true);
    expect(isVatError(thrownBy(() => database.columns(sql)), PROJECTION_STATEMENT_REFUSED_CODE)).toBe(true);
  });
});

describe('the controls answer', () => {
  it('a hydrated relation', () => {
    expect(database.query('SELECT COUNT(*) AS n FROM "blobs"')[0]?.['n']).toBe(sampleProjection().blobs.length);
  });

  it.each(['json_each', 'json_tree'])('%s, which every supported runtime has', (name) => {
    expect(runtimeHas(name)).toBe(true);
  });

  it.each(['json_each', 'json_tree', 'jsonb_each', 'jsonb_tree'])('%s over a column, or a statement refusal where this runtime lacks it', (name) => {
    const sql = `SELECT j.key FROM "blobs" b, ${name}(b."frontmatter") j`;
    if (runtimeHas(name)) {
      expect(() => database.query(sql)).not.toThrow();
      expect(() => database.columns(sql)).not.toThrow();
      expect(() => probe.assertCompiles(sql, [])).not.toThrow();
      return;
    }
    expect(isVatError(thrownBy(() => database.query(sql)), PROJECTION_STATEMENT_REFUSED_CODE)).toBe(true);
    expect(isVatError(thrownBy(() => database.columns(sql)), PROJECTION_STATEMENT_REFUSED_CODE)).toBe(true);
    expect(isVatError(thrownBy(() => probe.assertCompiles(sql, [])), PROJECTION_STATEMENT_REFUSED_CODE)).toBe(true);
  });
});

describe('statement.explained', () => {
  /** `EXPLAIN`s a handle runs when constructed: one per reference virtual table, present on this runtime or not. */
  const PER_HANDLE = 4;
  const explained = (): number => readWorkCounters()['statement.explained'];

  beforeEach(() => {
    __resetWorkCountersForTest();
  });

  it('moves by four when a handle is constructed and by one per gated call', async () => {
    const opened = hydrateRunDatabase({ rootId: 'root-1', relations: new Map() });
    try {
      expect(explained()).toBe(PER_HANDLE);
      opened.query('SELECT 1 AS n');
      expect(explained()).toBe(PER_HANDLE + 1);
      opened.columns('SELECT 1 AS n');
      expect(explained()).toBe(PER_HANDLE + 2);
    } finally {
      await opened.close();
    }
  });

  it('moves the same way on the compile probe', async () => {
    const opened = openProjectionCompileProbe();
    try {
      expect(explained()).toBe(PER_HANDLE);
      opened.assertCompiles('SELECT 1 AS n', []);
      expect(explained()).toBe(PER_HANDLE + 1);
    } finally {
      await opened.close();
    }
  });
});
