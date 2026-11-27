/**
 * The `git-sha1` duplicate bound: identical bytes at several git members are one key, one blob.
 *
 * A store-on run keys a git member by its object name, which is a function of the bytes alone,
 * so a tracked file, a tracked copy and an untracked copy (the snapshot stages untracked files
 * too) share one `git-sha1` key and the run files one `blobs` row for it. A key that depended on
 * the path, or on whether git tracks the file, would file one key per copy.
 */

import { mkdirSyncReal, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_ENV, PROJECTION_STORE_SQLITE } from '../../src/utils/projection-store.js';
import { createSuiteContext, executeCli, join, writeTestFile } from '../system/test-common.js';
import { commitTestFixture } from '../test-helpers.js';

const context = createSuiteContext('vat-store-git-duplicates-', import.meta.url);

/** The bytes every copy holds. */
const SHARED_BYTES = '# Shared\n\nThe same bytes at three paths.\n';

/** Two committed copies, then one untracked. */
const COMMITTED = ['docs/a.md', 'docs/b.md'];
const UNTRACKED = 'docs/untracked.md';

/**
 * Ask the store-on run one question over the corpus.
 *
 * @param cwd - The repository
 * @param sql - The question
 * @returns The rows
 */
async function ask(cwd: string, sql: string): Promise<Array<Record<string, unknown>>> {
  const result = await executeCli(context.binPath, ['resources', 'query', sql, '--format', 'json'], {
    cwd,
    env: { [PROJECTION_STORE_ENV]: PROJECTION_STORE_SQLITE, [VAT_CACHE_DIR_ENV]: join(cwd, '..', 'cache') },
  });
  expect(result.status, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as { data: { rows: Array<Record<string, unknown>> } }).data.rows;
}

describe('identical bytes at several git members', () => {
  let repo: string;

  beforeAll(() => {
    context.setup();
    repo = join(context.createTempDir(), 'corpus');
    mkdirSyncReal(join(repo, 'docs'), { recursive: true });
    for (const path of COMMITTED) writeTestFile(join(repo, path), SHARED_BYTES);
    commitTestFixture(repo);
    writeTestFile(join(repo, UNTRACKED), SHARED_BYTES);
  });

  afterAll(context.cleanup);

  it('are one git-sha1 key and one blob, however many paths and whether or not git tracks them', async () => {
    const realized = await ask(repo, `SELECT "path", "contentKey" FROM resource_realizations WHERE "path" LIKE 'docs/%' ORDER BY "path"`);
    expect(realized.map((row) => row['path']), 'every copy is realized').toEqual([...COMMITTED, UNTRACKED].sort((a, b) => a.localeCompare(b)));
    const keys = [...new Set(realized.map((row) => String(row['contentKey'])))];
    expect(keys, 'one key for the three copies').toHaveLength(1);
    expect(keys[0], 'the key is the bytes\' git object name').toMatch(/^markdown\.git-sha1\.[0-9a-f]{40}$/u);
    const blobs = await ask(repo, `SELECT "contentKey" FROM blobs WHERE "contentKey" = '${keys[0] ?? ''}'`);
    expect(blobs, 'one blob row for the key').toHaveLength(1);
  });
});
