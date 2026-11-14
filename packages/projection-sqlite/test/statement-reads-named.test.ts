/**
 * A statement reads only the relations it names itself.
 *
 * A run hydrates every relation some declared statement names, so a relation can EXIST in the run
 * database because another statement named it. SQLite reads `FROM 'blobs'` as the table `blobs`
 * when one exists, though the planner reads `'blobs'` as a string — so without this gate a check
 * written that way answered only while some other check named `blobs`, and refused when it was the
 * only one. The gate reads what the compiled program OPENS (each `OpenRead` root page, mapped to
 * its relation) and refuses a relation the statement does not name, on `query`, `columns` and the
 * compile probe, whose schema holds every relation.
 */

import { PROJECTION_STATEMENT_REFUSED_CODE } from '@vibe-agent-toolkit/resources';
import { isVatError } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type ProjectionCompileProbe,
  type RunDatabase,
} from '../src/run-database.js';

import { closeGatedHandles, openGatedHandles, sampleProjection } from './fixtures.js';

/** What one call threw, or undefined. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Statements that open a relation they do not name as an identifier. */
const UNNAMED_READS: readonly (readonly [string, string])[] = [
  ['a single-quoted table name', "SELECT COUNT(*) AS n FROM 'blobs'"],
  ['a single-quoted table beside a named one', `SELECT s."title" FROM "blob_sections" s JOIN 'blobs' b ON b."contentKey" = s."blob"`],
  ['a single-quoted table in a subquery', `SELECT "title" FROM "blob_sections" WHERE "blob" IN (SELECT "contentKey" FROM 'blobs')`],
  ['a single-quoted table the statement also names as a qualifier', "SELECT blobs.\"contentKey\" AS k FROM 'blobs'"],
  ['a single-quoted table followed by an unclosed comment naming it', "SELECT COUNT(*) AS n FROM 'blobs' /* blobs"],
  ['a single-quoted table beside an alias spelled as it, with no space after AS', `SELECT COUNT(*) AS n FROM "blob_sections" AS"blobs" JOIN 'blobs' ON 1`],
];

/** Every identifier spelling of the relation reads it. */
const NAMED_READS: readonly string[] = [
  'SELECT COUNT(*) AS n FROM blobs',
  'SELECT COUNT(*) AS n FROM "blobs"',
  'SELECT COUNT(*) AS n FROM [blobs]',
  'SELECT COUNT(*) AS n FROM `blobs`',
  'SELECT COUNT(*) AS n FROM main.blobs',
  "SELECT COUNT(*) AS n FROM blobs WHERE 'blobs' = 'blobs'",
];

let database: RunDatabase;
let probe: ProjectionCompileProbe;

beforeAll(() => {
  ({ database, probe } = openGatedHandles(['blobs', 'blobSections']));
});

afterAll(async () => {
  await closeGatedHandles({ database, probe });
});

describe('a relation the statement opens but does not name is refused, though the run holds it', () => {
  it.each(UNNAMED_READS)('query: %s', (_label, sql) => {
    const refusal = thrownBy(() => database.query(sql));
    expect(isVatError(refusal, PROJECTION_STATEMENT_REFUSED_CODE), String(refusal)).toBe(true);
    expect(String(refusal)).toContain('blobs');
  });

  it.each(UNNAMED_READS)('columns: %s', (_label, sql) => {
    expect(isVatError(thrownBy(() => database.columns(sql)), PROJECTION_STATEMENT_REFUSED_CODE)).toBe(true);
  });

  it.each(UNNAMED_READS)('compile probe, whose schema holds every relation: %s', (_label, sql) => {
    expect(isVatError(thrownBy(() => probe.assertCompiles(sql, [])), PROJECTION_STATEMENT_REFUSED_CODE)).toBe(true);
  });
});

describe('the controls answer', () => {
  it.each(NAMED_READS)('%s', (sql) => {
    expect(database.query(sql)[0]?.['n']).toBe(sampleProjection().blobs.length);
    expect(() => database.columns(sql)).not.toThrow();
    expect(() => probe.assertCompiles(sql, [])).not.toThrow();
  });

  it('reads a relation through its index, named', () => {
    expect(() => database.query('SELECT "title" FROM "blob_sections" WHERE "blob" = ? ORDER BY "ordinal"', 'k')).not.toThrow();
  });
});

describe('a derived relation a lens wrote', () => {
  it('is read when named and refused when only single-quoted, after the write created it', async () => {
    await database.writeDerived({ edges: [] });
    expect(database.query('SELECT COUNT(*) AS n FROM edges')[0]?.['n']).toBe(0);
    expect(isVatError(thrownBy(() => database.query("SELECT COUNT(*) AS n FROM 'edges'")), PROJECTION_STATEMENT_REFUSED_CODE)).toBe(true);
  });
});
