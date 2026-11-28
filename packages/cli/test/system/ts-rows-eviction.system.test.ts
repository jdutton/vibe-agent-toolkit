/**
 * The `ts` instance under the row-set tier's budget, through the real CLI:
 *
 * - **Eviction between write and copy** (`VAT_TEST_EVICT_ROW_SET`, honoured only in a test process):
 *   the attempt retries once, re-extracting exactly the evicted row set, and answers as the unseeded
 *   run does; a second eviction refuses `PROJECTION_STORE_ROWS_EVICTED`.
 * - **Two instances, one budget (spec D2):** a run naming `data__*` and `ts__*` together, at the
 *   store's default row-set budget, writes both instances' row sets cold and extracts nothing warm:
 *   one instance's write never evicts the other's.
 *
 * Each eviction arm is cold: the first attempt extracts every pair, so a retry's one extra extraction
 * and one extra head decode are exactly the evicted row set's.
 */

import { DEFAULT_ROW_SET_TIER_BUDGET_BYTES } from '@vibe-agent-toolkit/projection-sqlite';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_EVICT_ROW_SET_ENV } from '../../src/utils/projection-store.js';
import {
  answeredRows,
  countedQuery,
  countersOf,
  DATA_CONFIG,
  DATA_RUN_COUNTERS,
  expectEvictedTwice,
  freshDataArm,
  ROUTED_PAIRS,
  ROW_SET_COUNTERS,
  rowSetLedgerByInstance,
  writeCleanCorpus,
  type CountedQuery,
} from '../helpers/data-rows.js';
import { TS_ROUTED_PAIRS, writeTsCorpus } from '../helpers/ts-rows.js';

import { createSuiteContext } from './test-common.js';

const context = createSuiteContext('vat-ts-rows-eviction-', import.meta.url);
/** The clean `ts` corpus beside the clean data corpus: both instances route files here. */
let cwd = '';
beforeAll(() => {
  context.setup();
  cwd = safePath.join(context.createTempDir(), 'corpus');
  writeCleanCorpus(cwd, DATA_CONFIG);
  writeTsCorpus(cwd, { config: DATA_CONFIG });
});
afterAll(() => context.cleanup());

/** Each `ts` row set's head row: a copy from the store. */
const TS_FILES_SQL = 'SELECT blob, variant, moduleSyntax, hasJsx FROM ts__files ORDER BY blob, variant';

/** Both instances' head rows in one statement, so one run demands both. */
const BOTH_SQL = "SELECT 'data' AS instance, blob, variant FROM data__files UNION ALL SELECT 'ts', blob, variant FROM ts__files ORDER BY 1, 2, 3";

/**
 * One cold run of `sql` naming the eviction seam's `attempts`, or none.
 *
 * @param sql - The statement
 * @param attempts - The attempts the seam evicts at, or undefined for the unseeded arm
 * @returns The run
 */
function coldRun(sql: string, attempts?: string): Promise<CountedQuery> {
  return countedQuery(context, cwd, freshDataArm(context, false), sql, attempts === undefined ? {} : { [TEST_EVICT_ROW_SET_ENV]: attempts });
}

describe('a ts row set evicted between write and copy', () => {
  it('once: one more extraction, one more head decode, the same rows', async () => {
    const unseeded = await coldRun(TS_FILES_SQL);
    const seeded = await coldRun(TS_FILES_SQL, '1');
    expect(answeredRows(unseeded)).toHaveLength(TS_ROUTED_PAIRS);
    expect(answeredRows(seeded)).toEqual(answeredRows(unseeded));
    const base = countersOf(unseeded.counters, DATA_RUN_COUNTERS);
    expect(base['rowSet.extracted'], 'the unseeded arm extracts every ts pair and no data pair').toBe(TS_ROUTED_PAIRS);
    expect(countersOf(seeded.counters, DATA_RUN_COUNTERS)).toEqual({
      ...base,
      'rowSet.extracted': base['rowSet.extracted'] + 1,
      // The retry's coverage read: every pair but the evicted one, still held by the run's reader.
      'rowSet.storeServed': TS_ROUTED_PAIRS - 1,
      'rowSet.rows.decoded': base['rowSet.rows.decoded'] + 1,
    });
  });

  it('twice: the retry refuses', async () => {
    expectEvictedTwice(await coldRun(TS_FILES_SQL, '1,2'));
  });
});

describe('data and ts demanded together share one row-set budget (spec D2)', () => {
  // Red, seeded once and reverted, with the budget lowered by a throwaway seam the CLI does not ship:
  // `data-stage.ts` writing each instance's row sets in a write of its own, with no other instance's
  // heads, at a budget derived from this cold run's ledger (data 6,484 bytes, ts 2,349; budget 7,658,
  // below the union and above each alone): the ts write evicted data row sets before their copy, the
  // cold run refused as evicted twice and the warm run extracted 4 and refused, 1 failure. Unseeded at
  // that budget, cold extracted 13 and warm 0. At the default budget nothing is evicted, so this test
  // stays green under that seed: it pins the default-budget claim, the seed pins the mechanism.
  it('at the default budget: cold writes both instances, warm extracts nothing for either', async () => {
    const arm = freshDataArm(context, false);
    const cold = await countedQuery(context, cwd, arm, BOTH_SQL);
    const pairs = ROUTED_PAIRS + TS_ROUTED_PAIRS;
    expect(answeredRows(cold)).toHaveLength(pairs);
    expect(cold.counters['rowSet.extracted'], 'the cold run extracts both instances').toBe(pairs);
    const ledger = rowSetLedgerByInstance(arm.cacheDir);
    expect(Object.fromEntries(Object.entries(ledger).map(([instance, share]) => [instance, share.sets]))).toEqual({ data: ROUTED_PAIRS, ts: TS_ROUTED_PAIRS });
    // Premise: the default budget is the one the run opened under, and the union fits it.
    expect(Object.values(ledger).reduce((sum, share) => sum + share.bytes, 0)).toBeLessThan(DEFAULT_ROW_SET_TIER_BUDGET_BYTES);

    const warm = await countedQuery(context, cwd, arm, BOTH_SQL);
    expect(answeredRows(warm)).toEqual(answeredRows(cold));
    expect(countersOf(warm.counters, [...ROW_SET_COUNTERS, 'store.rows.decoded.repeated'])).toEqual({
      'rowSet.extracted': 0,
      'rowSet.storeServed': pairs,
      'rowSet.refused': 0,
      'rowSet.rows.decoded': pairs,
      'store.rows.decoded.repeated': 0,
    });
  });
});
