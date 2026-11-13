/**
 * A real `vat resources query` dumps its work counters, and a warm run's counts
 * are a pure function of the tree and the store.
 *
 * The cold run parses; two warm runs after it parse nothing and count exactly
 * the same work, which is what lets the lab's `work` facet compare one run's
 * counts with another's. The temp directory (where the parse cache lives) and
 * the store are private to the suite, so no other run's cache turns the cold
 * run warm.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { WORK_COUNTERS_ENV, type WorkCounterDump } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_DIR_ENV } from '../../src/utils/projection-store.js';
import { createSuiteContext, executeCli, join, writeTestFile } from '../system/test-common.js';
import { commitTestFixture } from '../test-helpers.js';

const context = createSuiteContext('vat-work-query-', import.meta.url);

let repo: string;
let storeDir: string;
let tmpDir: string;

/**
 * One query over the repository, its counters dumped to a fresh directory.
 *
 * @returns The CLI process's dump
 */
async function queryCounts(): Promise<WorkCounterDump['counters']> {
  const dumpDir = context.createTempDir();
  const result = await executeCli(context.binPath, ['resources', 'query', 'SELECT 1 AS x', '--format', 'json'], {
    cwd: repo,
    env: {
      [PROJECTION_STORE_DIR_ENV]: storeDir,
      [WORK_COUNTERS_ENV]: dumpDir,
      TMPDIR: tmpDir,
      TEMP: tmpDir,
      TMP: tmpDir,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const dumps = readdirSync(dumpDir).map(
    (name) => JSON.parse(readFileSync(join(dumpDir, name), 'utf-8')) as WorkCounterDump,
  );
  const cli = dumps.filter((dump) => dump.role === 'cli');
  expect(cli, `dumps: ${JSON.stringify(dumps)}`).toHaveLength(1);
  return (cli[0] as WorkCounterDump).counters;
}

describe('the work counters of a real query', () => {
  beforeAll(() => {
    context.setup();
    repo = context.createTempDir();
    writeTestFile(join(repo, 'a.md'), '# A\n\nSee [b](./b.md).\n');
    writeTestFile(join(repo, 'b.md'), '# B\n\nPlain.\n');
    commitTestFixture(repo);
    storeDir = context.createTempDir();
    tmpDir = context.createTempDir();
  });

  afterAll(context.cleanup);

  it('parses cold, then counts the same work and no parse on every warm run', async () => {
    const cold = await queryCounts();
    expect(cold['parse.dispatched']).toBeGreaterThan(0);
    expect(cold['extent.derived']).toBe(1);

    const warm = await queryCounts();
    const again = await queryCounts();
    expect(warm['parse.dispatched']).toBe(0);
    expect(warm['extent.served']).toBe(1);
    expect(again).toStrictEqual(warm);
  });
});
