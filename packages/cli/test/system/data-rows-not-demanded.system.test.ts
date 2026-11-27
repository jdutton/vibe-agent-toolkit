/**
 * A run that names no row-set relation pays nothing for the `data` instance: `vat validate` over the
 * clean data corpus, whose config declares no check, counts zero on every row-set counter in the
 * `vat validate` process and its checks child, cold and warm. The positive twin: the same corpus,
 * asked a statement naming `data__nodes`, extracts every routed pair, so the zeros are an instance
 * that did not run, never one that had nothing to route.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { answeredRows, countedQuery, countersOf, DATA_CONFIG, freshDataArm, NODES_SQL, ROUTED_PAIRS, ROW_SET_COUNTERS, writeCleanCorpus } from '../helpers/data-rows.js';
import { freshValidateArm, validateCounts, validateCountsSuite } from '../helpers/work-counters-validate.js';
import { commitTestFixture } from '../test-helpers.js';

const context = validateCountsSuite('vat-data-rows-not-demanded-', import.meta.url);

/** Every row-set counter at zero. */
const ZERO = Object.fromEntries(ROW_SET_COUNTERS.map((name) => [name, 0]));

describe('vat validate names no row-set relation and pays nothing for the data instance', () => {
  // Red, seeded once and reverted: `data-stage.ts` `dataDemandOf` demanding `data__files` when no
  // statement named a data relation (a decode of an unnamed row-set table):
  // the checks child counted rowSet.extracted 8 and rowSet.rows.decoded 8 cold, rowSet.storeServed 8
  // and rowSet.rows.decoded 8 warm, 1 failure. And `dataDemandOf` demanding the workspace step when no
  // statement named a workspace relation: the checks child counted rowSet.extracted 8 and
  // rowSet.rows.decoded 28 cold, 1 failure.
  it('zero on every row-set counter, parent and checks child, cold and warm', async () => {
    const cwd = safePath.join(context.createTempDir(), 'corpus');
    writeCleanCorpus(cwd, DATA_CONFIG);
    commitTestFixture(cwd);
    // The positive twin, first: this corpus routes every pair when a statement asks.
    const twin = await countedQuery(context, cwd, freshDataArm(context, false), NODES_SQL);
    answeredRows(twin);
    expect(twin.counters['rowSet.extracted'], 'pairs a data statement extracts from this corpus').toBe(ROUTED_PAIRS);

    const arm = freshValidateArm(context, false);
    const cold = await validateCounts(context, cwd, arm);
    const warm = await validateCounts(context, cwd, arm);
    expect({
      cold: { parent: countersOf(cold.parent, ROW_SET_COUNTERS), children: countersOf({ ...ZERO, ...cold.children }, ROW_SET_COUNTERS) },
      warm: { parent: countersOf(warm.parent, ROW_SET_COUNTERS), children: countersOf({ ...ZERO, ...warm.children }, ROW_SET_COUNTERS) },
    }).toEqual({ cold: { parent: ZERO, children: ZERO }, warm: { parent: ZERO, children: ZERO } });
    // The checks child ran and dumped its counters, so its zeros were counted, not missing.
    for (const run of [cold, warm]) expect(Object.keys(run.children), 'the checks child\'s counters').toEqual(expect.arrayContaining([...ROW_SET_COUNTERS]));
  });
});
