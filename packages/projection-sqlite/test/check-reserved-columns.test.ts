/**
 * What a check's statement feeds a finding when it selects a projection table's OWN columns.
 *
 * `path`, `severity`, `line` and `column` are reserved row columns of `resources.checks`. Several
 * projection tables carry columns of exactly those names, so a statement that selects them — by
 * name, by `*`, or through a join — hands their values to the finding. These pins run real SQL
 * against a real store so the consequence the docs name is a fact about the shipped tables, not a
 * claim about them.
 */

import { issuesFromCheckRows, type ExtentKey } from '@vibe-agent-toolkit/resources';
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

describe('a check selecting a projection table\'s reserved columns', () => {
  it('takes blob_conditions.severity as the finding\'s severity', () => {
    const result = findingsOf(
      'SELECT r.path, c.severity FROM blob_conditions c JOIN resource_realizations r ON r.contentKey = c.blob',
    );

    expect(result.ok && result.issues.map((issue) => issue.severity)).toStrictEqual(['info']);
  });

  it('takes a joined blob_references.line as the finding\'s line, beside the realization\'s path', () => {
    const result = findingsOf(
      'SELECT r.path, b.line FROM blob_references b JOIN resource_realizations r ON r.contentKey = b.blob',
    );

    expect(result.ok && result.issues.map((issue) => [issue.location, issue.line])).toStrictEqual([['docs/a.md', 1]]);
  });
});
