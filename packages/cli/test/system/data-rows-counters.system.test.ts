/**
 * What the `data` instance spends, counted through the real CLI (spec 3.9's shared proofs, with
 * PR1's numbers): `vat resources query` over the clean data corpus (`../helpers/data-rows.ts`),
 * store on, one CLI process.
 *
 * - **Cold:** every routed pair extracted, each head row decoded once (the write's read-back), every
 *   node copied; and the data stage reads no byte the population did not: `content.read` and
 *   `content.hashed` equal a cold run that names no data relation.
 * - **Warm unchanged:** nothing extracted or written; the head rows decoded once (the coverage read);
 *   every node copied.
 * - **One-file edit:** the edited pair alone extracted; the head rows decoded once each; every node,
 *   the edited pair's included, copied, none written by the rows lane.
 * - **Foreign variant:** a store shared with another root holds `(A, jsonc)` while this run routes
 *   `(A, json)` and `(B, jsonc)`: the copied tables hold no row of `(A, jsonc)`.
 * - **Narrow then wider:** naming `data__values` decodes the head rows (narrow) and then the nodes
 *   (wider), each once, cold and warm: `store.rows.decoded.repeated` zero.
 *
 * Red runs, each seeded once in `src` and reverted, are recorded in the test they turned red.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  answeredRows,
  CLEAN_NODES,
  countedQuery,
  countersOf,
  DATA_CONFIG,
  DATA_RUN_COUNTERS,
  EDITED_BYTES,
  EDITED_NODES,
  EDITED_PATH,
  FILES_SQL,
  freshDataArm,
  NO_DATA_SQL,
  NODES_SQL,
  ROUTED_PAIRS,
  storedDataRowSets,
  VALUES_SQL,
  writeCleanCorpus,
} from '../helpers/data-rows.js';
import { commitTestFixture, writeCorpus } from '../test-helpers.js';

import { createSuiteContext } from './test-common.js';

const context = createSuiteContext('vat-data-rows-counters-', import.meta.url);
beforeAll(() => context.setup());
afterAll(() => context.cleanup());

/** The clean corpus, committed, at a fresh root. */
function plant(): string {
  const cwd = safePath.join(context.createTempDir(), 'corpus');
  writeCleanCorpus(cwd, DATA_CONFIG);
  commitTestFixture(cwd);
  return cwd;
}

/** Node rows the clean corpus's `data__values` holds: every node, none shadowed but the first `/name`. */
const VALUE_ROWS = CLEAN_NODES - 1;

describe('the data instance, counted', () => {
  // Red, seeded once and reverted: `data-stage.ts` `extractOne` reading each routed file a second time
  // through `readContentWithKey` (bypassing the run's content reader) before extracting: content.read 19
  // and content.hashed 19 against 11 and 11, 1 failure.
  it('cold: every pair extracted, each head decoded once, every node copied, and no byte read twice', async () => {
    const cwd = plant();
    const cold = await countedQuery(context, cwd, freshDataArm(context, false), NODES_SQL);
    expect(answeredRows(cold)).toHaveLength(CLEAN_NODES);
    expect(countersOf(cold.counters, DATA_RUN_COUNTERS)).toEqual({
      'rowSet.extracted': ROUTED_PAIRS,
      'rowSet.storeServed': 0,
      'rowSet.refused': 0,
      'rowSet.rows.decoded': ROUTED_PAIRS,
      'hydration.rows.copied': CLEAN_NODES,
      'hydration.rows.written': 0,
      'store.rows.decoded.repeated': 0,
    });
    const noData = await countedQuery(context, cwd, freshDataArm(context, false), NO_DATA_SQL);
    answeredRows(noData);
    // Positive control: the population read and hashed every file, so equal counts compare real reads.
    // A committed file is a git member, read from git's object store (`content.gitRead`), not from disk.
    const reads = ['content.read', 'content.hashed', 'content.gitRead'] as const;
    expect(noData.counters['content.read'] + noData.counters['content.gitRead'], 'files the population read').toBeGreaterThanOrEqual(ROUTED_PAIRS);
    expect(countersOf(cold.counters, reads), 'bytes read beside a run naming no data relation')
      .toEqual(countersOf(noData.counters, reads));
  });

  it('warm unchanged: nothing extracted or written, each head decoded once, every node copied', async () => {
    const cwd = plant();
    const arm = freshDataArm(context, false);
    const cold = await countedQuery(context, cwd, arm, NODES_SQL);
    // Positive control for the write count below: the cold run wrote.
    expect(cold.counters['store.rows.written.persistent'], 'rows the cold run wrote').toBeGreaterThan(0);
    const warm = await countedQuery(context, cwd, arm, NODES_SQL);
    expect(answeredRows(warm)).toEqual(answeredRows(cold));
    expect(countersOf(warm.counters, [...DATA_RUN_COUNTERS, 'store.rows.written.persistent'])).toEqual({
      'rowSet.extracted': 0,
      'rowSet.storeServed': ROUTED_PAIRS,
      'rowSet.refused': 0,
      'rowSet.rows.decoded': ROUTED_PAIRS,
      'hydration.rows.copied': CLEAN_NODES,
      'hydration.rows.written': 0,
      'store.rows.decoded.repeated': 0,
      'store.rows.written.persistent': 0,
    });
  });

  // Red, seeded once and reverted: `data-stage.ts` `heldRowSets` handing the extracted rows in hand
  // (`inHand: extraction.rows`) store on whenever it extracted, so the edited pair takes the rows lane
  // in place of the copy: the run answered the edited pair's 4 rows against 29, 1 failure.
  it('one-file edit: the edited pair alone extracted, every node copied, none written by the rows lane', async () => {
    const cwd = plant();
    const arm = freshDataArm(context, false);
    answeredRows(await countedQuery(context, cwd, arm, NODES_SQL));
    writeFileSync(safePath.join(cwd, EDITED_PATH), EDITED_BYTES);
    const edited = await countedQuery(context, cwd, arm, NODES_SQL);
    const nodes = CLEAN_NODES - 8 + EDITED_NODES;
    expect(answeredRows(edited)).toHaveLength(nodes);
    expect(countersOf(edited.counters, DATA_RUN_COUNTERS)).toEqual({
      'rowSet.extracted': 1,
      'rowSet.storeServed': ROUTED_PAIRS - 1,
      'rowSet.refused': 0,
      // The served pairs' heads at the coverage read, and the edited pair's read back after its write.
      'rowSet.rows.decoded': ROUTED_PAIRS,
      'hydration.rows.copied': nodes,
      'hydration.rows.written': 0,
      'store.rows.decoded.repeated': 0,
    });
  });

  // Red, seeded once and reverted: the stored reader (`stored-reads.ts` `rowSets`) forgetting every
  // id it is asked for before reading, so the node read re-reads the heads the coverage read holds:
  // rowSet.rows.decoded 49 and store.rows.decoded.repeated 8 against 41 and 0, cold and warm, 1 failure.
  it('narrow then wider: data__values decodes each head and then each node once, cold and warm', async () => {
    const cwd = plant();
    const arm = freshDataArm(context, false);
    const cold = await countedQuery(context, cwd, arm, VALUES_SQL);
    const warm = await countedQuery(context, cwd, arm, VALUES_SQL);
    expect(answeredRows(cold)).toHaveLength(VALUE_ROWS);
    expect(answeredRows(warm)).toEqual(answeredRows(cold));
    const decoded = ROUTED_PAIRS + CLEAN_NODES;
    const watched = ['rowSet.extracted', 'rowSet.rows.decoded', 'store.rows.decoded.repeated'] as const;
    expect({ cold: countersOf(cold.counters, watched), warm: countersOf(warm.counters, watched) }).toEqual({
      cold: { 'rowSet.extracted': ROUTED_PAIRS, 'rowSet.rows.decoded': decoded, 'store.rows.decoded.repeated': 0 },
      warm: { 'rowSet.extracted': 0, 'rowSet.rows.decoded': decoded, 'store.rows.decoded.repeated': 0 },
    });
  });

  // Red, seeded once and reverted: the copy filtering by `blob IN (...) AND variant IN (...)`
  // (`projection-sqlite` `run-database.ts`, the row-set copy) in place of the pairs: the copy also took
  // (A, jsonc), 3 data__files rows against 2, 1 failure.
  it('foreign variant: a stored (A, jsonc) another root wrote is never copied into a run routing (A, json)', async () => {
    const shared = freshDataArm(context, false);
    const bytesA = '{"shared": "A"}\n';
    const foreign = safePath.join(context.createTempDir(), 'foreign');
    writeCorpus(foreign, { 'vibe-agent-toolkit.config.yaml': DATA_CONFIG, 'tsconfig.json': bytesA });
    commitTestFixture(foreign);
    expect(answeredRows(await countedQuery(context, foreign, shared, FILES_SQL)).map((row) => row['variant'])).toEqual(['jsonc']);
    const own = safePath.join(context.createTempDir(), 'own');
    writeCorpus(own, { 'vibe-agent-toolkit.config.yaml': DATA_CONFIG, 'package.json': bytesA, 'tsconfig.json': '{"own": "B"}\n' });
    commitTestFixture(own);
    const offRows = answeredRows(await countedQuery(context, own, freshDataArm(context, true), FILES_SQL));
    const shared2 = await countedQuery(context, own, shared, FILES_SQL);
    // The store holds the foreign pair at the moment it is asked: (A, jsonc) beside the run's two.
    // Content identity is per source: the store-on run keys a member by its object id, the store-off
    // run by its disk checksum, so the two are compared by which file each row names, not its id.
    const onRows = answeredRows(shared2);
    const blobA = onRows.find((row) => row['variant'] === 'json')?.['blob'];
    expect(storedDataRowSets(shared.cacheDir).map((id) => `${id.contentKey} ${id.variant}`)).toContain(`${String(blobA)} jsonc`);
    const named = (rows: ReadonlyArray<Record<string, unknown>>): string[] => {
      const a = rows.find((row) => row['variant'] === 'json')?.['blob'];
      return rows.map((row) => `${String(row['blob'] === a ? 'A' : 'B')} ${String(row['variant'])} ${String(row['nodeCount'])}`).toSorted((left, right) => left.localeCompare(right));
    };
    expect(named(onRows)).toEqual(named(offRows));
    expect(named(offRows)).toEqual(['A json 2', 'B jsonc 2']);
    expect(countersOf(shared2.counters, ['rowSet.extracted', 'hydration.rows.copied']), 'both pairs extracted, then copied').toEqual({
      'rowSet.extracted': 2,
      'hydration.rows.copied': 2,
    });
  });
});
