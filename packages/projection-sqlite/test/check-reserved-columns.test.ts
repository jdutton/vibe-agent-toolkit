/**
 * The reserved row columns of `resources.checks` against the projection's real schema.
 *
 * `path`, `finding_severity`, `finding_line` and `finding_column` are read as something other than
 * evidence. The last three are spelled so that NO projection relation carries them: several tables
 * carry a `severity`, `line` or `column` of their own (`blob_conditions`, `blob_references`,
 * `harness_blob_imports`, `realization_conditions`), and when those names were the reserved ones a
 * `SELECT bc.*` handed a table's own `severity` to the finding — overriding the check's declared
 * one. With the prefixed names a `SELECT *` cannot feed a reserved column, by construction; the
 * enforcer below keeps it so as the schema grows.
 */

import {
  allDerivedSpecs,
  CHECK_FINDING_COLUMNS,
  issuesFromCheckRows,
  type ExtentKey,
} from '@vibe-agent-toolkit/resources';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openEphemeralProjectionStore, type SqlQueryableStore } from '../src/store.js';

import { sampleBlobRows, sampleExtentRows } from './fixtures.js';

const KEY: ExtentKey = { rootId: 'root-1', treeHash: 'tree-aaa' };
/** Declared `error`, so a finding at any other severity took it from the row. */
const CHECK = { description: 'pin', sql: 'unused', severity: 'error' } as const;

let store: SqlQueryableStore;

beforeEach(async () => {
  store = openEphemeralProjectionStore();
  await store.writeBlobFacts(sampleBlobRows());
  await store.writeExtent(KEY, sampleExtentRows());
});

afterEach(async () => {
  await store.close();
});

/**
 * The findings one statement produces.
 *
 * @param sql - The check's statement
 * @returns The conversion of its rows
 */
function findingsOf(sql: string): ReturnType<typeof issuesFromCheckRows> {
  return issuesFromCheckRows('pin', CHECK, store.query(sql));
}

/**
 * Every relation a check can read, with its columns: every table and view the store creates, read
 * back from SQLite itself, and every derived relation, from the registry its DDL is built from.
 *
 * @returns Relation name → its column names
 */
function everyRelationsColumns(): Map<string, readonly string[]> {
  const relations = new Map<string, readonly string[]>();
  const named = store.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'");
  for (const { name } of named) {
    const columns = store.query('SELECT name FROM pragma_table_info(?)', String(name)).map((row) => String(row['name']));
    relations.set(String(name), columns);
  }
  for (const spec of allDerivedSpecs()) relations.set(spec.name, spec.columns);
  return relations;
}

describe('the reserved check columns and the projection schema', () => {
  it('reserve exactly path and the three finding_ names', () => {
    expect(CHECK_FINDING_COLUMNS).toStrictEqual(['path', 'finding_severity', 'finding_line', 'finding_column']);
  });

  it('are carried by no relation a check can read, so SELECT * can never feed one', () => {
    const relations = everyRelationsColumns();
    const prefixed = new Set<string>(CHECK_FINDING_COLUMNS.filter((name) => name !== 'path'));
    // Case-insensitively: a relation carrying `Finding_Line` would feed a near miss, not evidence.
    const carriers = [...relations].flatMap(([relation, columns]) =>
      columns.filter((column) => prefixed.has(column.toLowerCase())).map((column) => `${relation}.${column}`));

    expect(carriers).toStrictEqual([]);
  });

  it('saw the tables that motivated the rename, so the scan above is not vacuous', () => {
    const relations = everyRelationsColumns();

    expect(relations.get('blob_conditions')).toContain('severity');
    expect(relations.get('blob_references')).toEqual(expect.arrayContaining(['line', 'column']));
    expect(relations.get('changed_files')).toContain('path');
  });
});

describe('a check selecting a projection table\'s own severity, line and column', () => {
  it('keeps blob_conditions.* as evidence: the declared severity stands', () => {
    const result = findingsOf(
      'SELECT r.path, c.* FROM blob_conditions c JOIN resource_realizations r ON r.contentKey = c.blob',
    );

    expect(result.ok && result.issues.map((issue) => issue.severity)).toStrictEqual(['error']);
    expect(result.ok && result.issues[0]?.evidence).toMatchObject({ severity: 'info' });
  });

  it('keeps a joined blob_references.line as evidence, and places the finding only by finding_line', () => {
    const evidenceOnly = findingsOf(
      'SELECT r.path, b.line FROM blob_references b JOIN resource_realizations r ON r.contentKey = b.blob',
    );
    const placed = findingsOf(
      'SELECT r.path, b.line AS finding_line FROM blob_references b JOIN resource_realizations r ON r.contentKey = b.blob',
    );

    expect(evidenceOnly.ok && evidenceOnly.issues.map((issue) => [issue.location, issue.line])).toStrictEqual([['docs/a.md', undefined]]);
    expect(placed.ok && placed.issues.map((issue) => [issue.location, issue.line])).toStrictEqual([['docs/a.md', 1]]);
  });
});
