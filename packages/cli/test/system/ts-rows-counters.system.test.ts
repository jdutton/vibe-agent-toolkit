/**
 * What the `ts` instance spends, counted through the real CLI (spec 3.9's shared proofs, with T1's
 * numbers): `vat resources query` over the clean `ts` corpus (`../helpers/ts-rows.ts`), store on, one
 * CLI process. The row-set counters are shared by every instance, so each proof isolates one.
 *
 * - **Cold:** every routed pair extracted, each head row decoded once (the write's read-back), every
 *   head row copied; and the stage reads no byte the population did not: `content.read`,
 *   `content.hashed` and `content.gitRead` equal a cold run that names no `ts` relation, whose every
 *   row-set counter is zero.
 * - **Warm unchanged:** nothing extracted or written; the head rows decoded once (the coverage read).
 * - **One-file edit:** the edited pair alone extracted.
 * - **Narrow then wider:** `ts_imports` decodes the head rows (narrow) and then the imports (wider),
 *   each once, cold and warm: `store.rows.decoded.repeated` zero.
 * - **Variants:** the same bytes at `x.ts` and `x.d.ts` are two row sets; at `x.ts` and `y.mts`, one.
 * - **One instance named:** over a tree holding both instances' files, a run naming only `data__*`
 *   extracts exactly the data pairs and no `ts` pair (the module it never loads: Task 12's
 *   `module-load-budget` integration test).
 *
 * Red runs, each seeded once in `src` and reverted, are recorded in the test they turned red.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  answeredRows,
  countedQuery,
  countersOf,
  DATA_CONFIG,
  DATA_RUN_COUNTERS,
  FILES_SQL,
  freshDataArm,
  NO_DATA_SQL,
  ROUTED_PAIRS,
  ROW_SET_COUNTERS,
  writeCleanCorpus,
} from '../helpers/data-rows.js';
import { TS_ROUTED_PAIRS, writeTsCorpus } from '../helpers/ts-rows.js';
import { commitTestFixture, writeCorpus } from '../test-helpers.js';

import { createSuiteContext } from './test-common.js';

const context = createSuiteContext('vat-ts-rows-counters-', import.meta.url);
beforeAll(() => context.setup());
afterAll(() => context.cleanup());

/** The clean `ts` corpus, committed, at a fresh root. */
function plant(): string {
  const cwd = safePath.join(context.createTempDir(), 'corpus');
  writeTsCorpus(cwd, { config: DATA_CONFIG });
  return cwd;
}

/** Each `ts` row set's head row. */
const TS_FILES_SQL = 'SELECT blob, variant, moduleSyntax, hasJsx FROM ts__files ORDER BY blob, variant';

/** The derived `ts_imports`: the head rows, then every import row. */
const TS_IMPORTS_SQL = 'SELECT path, ordinal, kind, specifier, package, builtin FROM ts_imports ORDER BY path, ordinal';

/** The clean corpus's `ts__imports` rows (read off `CLEAN_TS_ANSWER`). */
const TS_IMPORT_ROWS = 6;

/** The file a one-file edit rewrites, and its bytes after. */
const EDITED_SOURCE = 'src/b.ts';
const EDITED_SOURCE_BYTES = "import fs from 'node:fs';\nexport const b = fs.existsSync('./edited');\n";

describe('the ts instance, counted', () => {
  // One corpus, one cold run and one store: the cold proof reads that run's counters, and the warm
  // proof reads the same store back.
  describe('cold, then warm over the same store', () => {
    let cwd = '';
    let arm: ReturnType<typeof freshDataArm>;
    let cold: Awaited<ReturnType<typeof countedQuery>>;

    beforeAll(async () => {
      cwd = plant();
      arm = freshDataArm(context, false);
      cold = await countedQuery(context, cwd, arm, TS_FILES_SQL);
    });

    // Red, seeded once and reverted: `data-stage.ts` `extractOne` reading each routed file a second time
    // through `readContentWithKey` (bypassing the run's content reader) before extracting: content.read 5
    // and content.hashed 5 against 0 and 0 (content.gitRead 8 on both), 1 failure.
    it('cold: every pair extracted, each head decoded once and copied, and no byte read beside a run naming no ts relation', async () => {
      expect(answeredRows(cold)).toHaveLength(TS_ROUTED_PAIRS);
      expect(countersOf(cold.counters, DATA_RUN_COUNTERS)).toEqual({
        'rowSet.extracted': TS_ROUTED_PAIRS,
        'rowSet.storeServed': 0,
        'rowSet.refused': 0,
        'rowSet.rows.decoded': TS_ROUTED_PAIRS,
        'hydration.rows.copied': TS_ROUTED_PAIRS,
        'hydration.rows.written': 0,
        'store.rows.decoded.repeated': 0,
      });
      const noRows = await countedQuery(context, cwd, freshDataArm(context, false), NO_DATA_SQL);
      answeredRows(noRows);
      expect(countersOf(noRows.counters, ROW_SET_COUNTERS), 'a run naming no row-set relation').toEqual({
        'rowSet.extracted': 0,
        'rowSet.storeServed': 0,
        'rowSet.refused': 0,
        'rowSet.rows.decoded': 0,
      });
      // Positive control: the population read every source file, so equal counts compare real reads. A
      // committed file is a git member, read from git's object store (`content.gitRead`), not from disk.
      const reads = ['content.read', 'content.hashed', 'content.gitRead'] as const;
      expect(noRows.counters['content.read'] + noRows.counters['content.gitRead'], 'files the population read').toBeGreaterThanOrEqual(TS_ROUTED_PAIRS);
      expect(countersOf(cold.counters, reads), 'bytes read beside a run naming no ts relation').toEqual(countersOf(noRows.counters, reads));
    });

    it('warm unchanged: nothing extracted or written, each head decoded once', async () => {
      expect(cold.counters['store.rows.written.persistent'], 'rows the cold run wrote').toBeGreaterThan(0);
      const warm = await countedQuery(context, cwd, arm, TS_FILES_SQL);
      expect(answeredRows(warm)).toEqual(answeredRows(cold));
      expect(countersOf(warm.counters, [...DATA_RUN_COUNTERS, 'store.rows.written.persistent'])).toEqual({
        'rowSet.extracted': 0,
        'rowSet.storeServed': TS_ROUTED_PAIRS,
        'rowSet.refused': 0,
        'rowSet.rows.decoded': TS_ROUTED_PAIRS,
        'hydration.rows.copied': TS_ROUTED_PAIRS,
        'hydration.rows.written': 0,
        'store.rows.decoded.repeated': 0,
        'store.rows.written.persistent': 0,
      });
    });
  });

  it('one-file edit: the edited pair alone extracted', async () => {
    const cwd = plant();
    const arm = freshDataArm(context, false);
    const before = answeredRows(await countedQuery(context, cwd, arm, TS_FILES_SQL));
    writeFileSync(safePath.join(cwd, EDITED_SOURCE), EDITED_SOURCE_BYTES);
    const edited = await countedQuery(context, cwd, arm, TS_FILES_SQL);
    const after = answeredRows(edited);
    expect(after).toHaveLength(TS_ROUTED_PAIRS);
    expect(after.filter((row) => !before.some((held) => held['blob'] === row['blob'])), 'the edited pair is new content').toHaveLength(1);
    expect(countersOf(edited.counters, DATA_RUN_COUNTERS)).toEqual({
      'rowSet.extracted': 1,
      'rowSet.storeServed': TS_ROUTED_PAIRS - 1,
      'rowSet.refused': 0,
      // The served pairs' heads at the coverage read, and the edited pair's read back after its write.
      'rowSet.rows.decoded': TS_ROUTED_PAIRS,
      'hydration.rows.copied': TS_ROUTED_PAIRS,
      'hydration.rows.written': 0,
      'store.rows.decoded.repeated': 0,
    });
  });

  it('narrow then wider: ts_imports decodes each head and then each import once, cold and warm', async () => {
    const cwd = plant();
    const arm = freshDataArm(context, false);
    const cold = await countedQuery(context, cwd, arm, TS_IMPORTS_SQL);
    const warm = await countedQuery(context, cwd, arm, TS_IMPORTS_SQL);
    expect(answeredRows(cold)).toHaveLength(TS_IMPORT_ROWS);
    expect(answeredRows(warm)).toEqual(answeredRows(cold));
    const decoded = TS_ROUTED_PAIRS + TS_IMPORT_ROWS;
    const watched = ['rowSet.extracted', 'rowSet.rows.decoded', 'store.rows.decoded.repeated'] as const;
    expect({ cold: countersOf(cold.counters, watched), warm: countersOf(warm.counters, watched) }).toEqual({
      cold: { 'rowSet.extracted': TS_ROUTED_PAIRS, 'rowSet.rows.decoded': decoded, 'store.rows.decoded.repeated': 0 },
      warm: { 'rowSet.extracted': 0, 'rowSet.rows.decoded': decoded, 'store.rows.decoded.repeated': 0 },
    });
  });

  it.each([
    { name: 'x.ts and x.d.ts are two row sets of one content key', paths: ['x.ts', 'x.d.ts'], variants: ['dts', 'ts'] },
    { name: 'x.ts and y.mts are one row set', paths: ['x.ts', 'y.mts'], variants: ['ts'] },
  ])('the same bytes routed twice: $name', async ({ paths, variants }) => {
    const cwd = safePath.join(context.createTempDir(), 'variants');
    const bytes = 'export declare const x: number;\n';
    writeCorpus(cwd, { 'vibe-agent-toolkit.config.yaml': DATA_CONFIG, ...Object.fromEntries(paths.map((path) => [path, bytes])) });
    commitTestFixture(cwd);
    const run = await countedQuery(context, cwd, freshDataArm(context, false), TS_FILES_SQL);
    const files = answeredRows(run);
    expect(new Set(files.map((row) => row['blob'])).size, 'one content key').toBe(1);
    expect(files.map((row) => row['variant'])).toEqual(variants);
    const routes = answeredRows(await countedQuery(context, cwd, freshDataArm(context, false), 'SELECT path, variant FROM ts__routes ORDER BY path'));
    expect(routes.map((row) => row['path'])).toEqual(paths.toSorted((left, right) => left.localeCompare(right)));
    expect(run.counters['rowSet.extracted']).toBe(variants.length);
  });

  it('a run naming only data__* extracts exactly the data pairs, over a tree holding ts files too', async () => {
    const cwd = safePath.join(context.createTempDir(), 'both');
    writeCleanCorpus(cwd, DATA_CONFIG);
    writeTsCorpus(cwd, { config: DATA_CONFIG });
    const arm = freshDataArm(context, false);
    const run = await countedQuery(context, cwd, arm, FILES_SQL);
    expect(answeredRows(run)).toHaveLength(ROUTED_PAIRS);
    expect(countersOf(run.counters, ['rowSet.extracted', 'rowSet.storeServed', 'rowSet.refused'])).toEqual({
      'rowSet.extracted': ROUTED_PAIRS,
      'rowSet.storeServed': 0,
      'rowSet.refused': 0,
    });
    // Positive control: the same tree, asked for `ts`, extracts every ts pair and nothing of data's.
    const ts = await countedQuery(context, cwd, arm, TS_FILES_SQL);
    expect(answeredRows(ts)).toHaveLength(TS_ROUTED_PAIRS);
    expect(ts.counters['rowSet.extracted']).toBe(TS_ROUTED_PAIRS);
  });
});
