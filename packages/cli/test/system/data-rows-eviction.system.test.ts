/**
 * A row set evicted while a query holds it: the attempt retries once, re-extracting exactly the
 * evicted row set, and answers as the unseeded run does; a second eviction refuses
 * `PROJECTION_STORE_ROWS_EVICTED`. Driven through the real CLI by the data stage's two test seams
 * (`VAT_TEST_EVICT_ROW_SET`, `VAT_TEST_EVICT_ROW_SET_BEFORE_VALUES`: the query attempts at which the
 * first `facts` row set is evicted), honoured only in a test process.
 *
 * - **Between write and copy** (a statement naming `data__nodes`): the copy finds the row set gone.
 * - **Before the `data__values` node read**: the extending read finds it gone.
 *
 * Each arm is cold: the first attempt extracts every pair, so a retry's one extra extraction and one
 * extra head decode are exactly the evicted row set's, and the retry's coverage read serves the rest.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_EVICT_ROW_SET_BEFORE_VALUES_ENV, TEST_EVICT_ROW_SET_ENV } from '../../src/utils/projection-store.js';
import {
  answeredRows,
  CLEAN_NODES,
  countedQuery,
  countersOf,
  DATA_CONFIG,
  DATA_RUN_COUNTERS,
  expectEvictedTwice,
  freshDataArm,
  NODES_SQL,
  ROUTED_PAIRS,
  VALUES_SQL,
  writeCleanCorpus,
  type CountedQuery,
} from '../helpers/data-rows.js';
import { commitTestFixture } from '../test-helpers.js';

import { createSuiteContext } from './test-common.js';

const context = createSuiteContext('vat-data-rows-eviction-', import.meta.url);
let cwd = '';
beforeAll(() => {
  context.setup();
  cwd = safePath.join(context.createTempDir(), 'corpus');
  writeCleanCorpus(cwd, DATA_CONFIG);
  commitTestFixture(cwd);
});
afterAll(() => context.cleanup());

/**
 * One cold run of `sql`, with the seam variable naming `attempts`, or none.
 *
 * @param sql - The statement
 * @param seam - The seam variable and the attempts it names, or undefined for the unseeded arm
 * @returns The run
 */
function coldRun(sql: string, seam?: { readonly variable: string; readonly attempts: string }): Promise<CountedQuery> {
  return countedQuery(context, cwd, freshDataArm(context, false), sql, seam === undefined ? {} : { [seam.variable]: seam.attempts });
}

describe('a row set evicted while a query holds it', () => {
  // Red, seeded once and reverted: the blob tier's retry applied to row sets
  // (`projection-query.ts` `referencesAfterEviction` returning `'rows'` for every tier, forgetting
  // nothing): the retry is served the evicted head its reader still holds, the copy misses it again,
  // and the run refuses as evicted twice where the unseeded arm answers, 1 failure. The before-values
  // test stayed green under that seed; its own red is the next one.
  it('between write and copy: one more extraction, one more head decode, the same rows', async () => {
    const unseeded = await coldRun(NODES_SQL);
    const seeded = await coldRun(NODES_SQL, { variable: TEST_EVICT_ROW_SET_ENV, attempts: '1' });
    expect(answeredRows(seeded)).toEqual(answeredRows(unseeded));
    expect(answeredRows(unseeded)).toHaveLength(CLEAN_NODES);
    const base = countersOf(unseeded.counters, DATA_RUN_COUNTERS);
    expect(base['rowSet.extracted'], 'the unseeded arm extracts every pair').toBe(ROUTED_PAIRS);
    expect(countersOf(seeded.counters, DATA_RUN_COUNTERS)).toEqual({
      ...base,
      'rowSet.extracted': base['rowSet.extracted'] + 1,
      // The retry's coverage read: every pair but the evicted one, still held by the run's reader.
      'rowSet.storeServed': ROUTED_PAIRS - 1,
      'rowSet.rows.decoded': base['rowSet.rows.decoded'] + 1,
    });
  });

  it('between write and copy, twice: the retry refuses', async () => {
    expectEvictedTwice(await coldRun(NODES_SQL, { variable: TEST_EVICT_ROW_SET_ENV, attempts: '1,2' }));
  });

  // Red, seeded once and reverted: `data-stage.ts` `nodesOf` reading an absent row set as one with no
  // nodes (the `assertPresent` after the node read dropped): the seeded run answered 30 rows against 32,
  // without the evicted pair's values, and the doubly seeded run answered rather than refused, 2 failures.
  it('before the data__values node read: retried once, the same rows', async () => {
    const unseeded = await coldRun(VALUES_SQL);
    const seeded = await coldRun(VALUES_SQL, { variable: TEST_EVICT_ROW_SET_BEFORE_VALUES_ENV, attempts: '1' });
    expect(answeredRows(seeded)).toEqual(answeredRows(unseeded));
    const base = countersOf(unseeded.counters, DATA_RUN_COUNTERS);
    expect(base['rowSet.extracted'], 'the unseeded arm extracts every pair').toBe(ROUTED_PAIRS);
    expect(base['rowSet.rows.decoded'], 'each head and each node once').toBe(ROUTED_PAIRS + CLEAN_NODES);
    // The evicted pair's head again, read back after the retry's write; every node still once: the
    // first attempt's node read held the other pairs', the retry's extends to the evicted one's.
    expect(countersOf(seeded.counters, DATA_RUN_COUNTERS)).toEqual({
      ...base,
      'rowSet.extracted': base['rowSet.extracted'] + 1,
      'rowSet.storeServed': ROUTED_PAIRS - 1,
      'rowSet.rows.decoded': base['rowSet.rows.decoded'] + 1,
    });
  });

  it('before the data__values node read, twice: the retry refuses', async () => {
    expectEvictedTwice(await coldRun(VALUES_SQL, { variable: TEST_EVICT_ROW_SET_BEFORE_VALUES_ENV, attempts: '1,2' }));
  });
});
