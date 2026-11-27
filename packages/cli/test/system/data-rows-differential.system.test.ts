/**
 * I0 over the `data` instance: the clean data corpus (`../helpers/data-rows.ts`: strict and JSONC,
 * the same bytes under both variants, a UTF-8 BOM, UTF-16 with its BOM, CRLF, lone CR, a duplicate
 * key, 2^53+1, a scalar root, nesting to depth 4) and the YAML corpus beside it (anchors and aliases,
 * `<<` stored literally, a two-document stream, an empty stream, `---` alone, non-string keys, tags,
 * a repeated key, `.inf`/`.nan` and a hex integer, CRLF and lone CR, `%YAML 1.2`, routed by the
 * `pnpm-workspace.yaml` default and by an `include` of `.yaml` and `.yml`) answers the full dump
 * identically store-off, cold, warm and with half the blob tier evicted, and the census of every
 * `data__*` relation holds rows in every arm, and the YAML corpus's own answer, before it is compared.
 *
 * The blob-tier eviction is the row-set tier's independence too: evicting blob keys leaves every row
 * set stored, so that arm extracts none and is served every pair.
 *
 * Seeds over the same corpus, store-off against warm:
 * - half the row-set tier evicted after the prime: the warm run re-extracts exactly those row sets;
 * - one file edited after the prime: the warm run extracts exactly the edited pair;
 * - a wrong `data__nodes` row planted in the store (the root `package.json`'s `/version`): the
 *   differential names `data__nodes`, `data__values` and `workspace_packages` (whose root row reads
 *   that `version`), the relations that read it, and nothing else.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { relationRows, seedTitle, treeSeedSuite, type I0Seed } from '../helpers/cache-differential.js';
import {
  DATA_TREE,
  EDITED_BYTES,
  EDITED_PATH,
  expectCleanDataCensus,
  PLANTED_VALUE,
  plantWrongNode,
  recordedCounters,
  rowSetEvictionSeed,
  TREE_PAIRS,
  WARM_ARMS,
  WARM_MEASURED,
  warmRowSetSpend,
} from '../helpers/data-rows.js';

const ARMS = ['storeOff', 'cold', 'warmSameHistory', 'partialEviction'] as const;

/** The clean seed's consumed runs: each arm's measured run. */
const measuredOf = (arms: readonly string[]): Array<`${(typeof ARMS)[number]}:measured`> => arms.map((arm) => `${arm}:measured` as `${(typeof ARMS)[number]}:measured`);

/**
 * The warm measured dump's row-set extractions and servings, after the clean census holds.
 *
 * @param runs - The seed's consumed runs
 * @returns What the warm run extracted and was served
 */
function warmRowSetSpendAfterCensus(runs: Parameters<I0Seed['consumed']['check']>[0]): { extracted: number; served: number } {
  expectCleanDataCensus(runs);
  return warmRowSetSpend(runs);
}

/**
 * No plant: every arm over the clean corpus.
 *
 * Reds, each seeded once and reverted:
 * - the root `package.json` rewritten with no duplicate key and no lossy number, so every arm agrees
 *   on an empty `data__conditions`: the census failed on store-off, "relations with no row:
 *   data__conditions", before any comparison, 1 failure;
 * - one defective file (`bad/package.json`, `{"a": }`) in the clean corpus: the census failed on
 *   store-off, "routed paths", 20 paths for 19, 1 failure;
 * - the `.yml` include dropped from the config: the census failed on store-off, "routed paths", 18
 *   paths for 19, 1 failure;
 * - the two-document stream made one document: "head rows by documents" read { 0: 1, 1: 10 } for
 *   { 0: 1, 1: 9, 2: 1 }, 1 failure;
 * - before a stored NULL of type number decoded as NaN, the store-on arms could not answer
 *   `data__values` over `.nan` (INTERNAL_ERROR), and the run failed at partialEviction's origins,
 *   1 failure.
 */
const CLEAN: I0Seed = {
  name: 'cleanDataCorpus',
  needs: null,
  arms: ARMS,
  verbs: ['query'],
  expect: { agrees: { because: 'the clean data corpus, unplanted', storeDeclines: null } },
  consumed: {
    runs: measuredOf(ARMS),
    check: (runs) => {
      const census = expectCleanDataCensus(runs);
      expect(census['data__files'], 'one head row per routed pair').toHaveLength(TREE_PAIRS);
      const served = (arm: (typeof ARMS)[number]): Record<string, number> => {
        const run = runs[`${arm}:measured`]?.query;
        if (run === undefined) throw new Error(`no ${arm} dump`);
        const counters = recordedCounters(run);
        return { extracted: counters['rowSet.extracted'], served: counters['rowSet.storeServed'] };
      };
      expect(Object.fromEntries(ARMS.map((arm) => [arm, served(arm)]))).toEqual({
        storeOff: { extracted: TREE_PAIRS, served: 0 },
        cold: { extracted: TREE_PAIRS, served: 0 },
        warmSameHistory: { extracted: 0, served: TREE_PAIRS },
        partialEviction: { extracted: 0, served: TREE_PAIRS },
      });
    },
  },
};

/** Every other stored row set evicted after the warm prime, as the row-set budget would. */
const ROW_SET_EVICTION: I0Seed = rowSetEvictionSeed('rowSetEviction', TREE_PAIRS, (runs) => {
  expectCleanDataCensus(runs);
});

/** One routed file rewritten after the prime, uncommitted: the tree moves, so the warm run writes. */
const WARM_AFTER_EDIT: I0Seed = {
  name: 'warmAfterEdit',
  needs: null,
  arms: WARM_ARMS,
  verbs: ['query'],
  toB: (_arm, _dirs, corpus) => {
    writeFileSync(safePath.join(corpus, EDITED_PATH), EDITED_BYTES);
    return Promise.resolve();
  },
  expect: { agreesAndRepairs: { arm: 'warmSameHistory', because: 'the edit moves the tree, so the warm run derives it and extracts the edited pair' } },
  consumed: {
    runs: WARM_MEASURED,
    check: (runs) => {
      const { extracted, served } = warmRowSetSpendAfterCensus(runs);
      expect({ extracted, served }).toEqual({ extracted: 1, served: TREE_PAIRS - 1 });
    },
  },
};

/**
 * A stored `data__nodes` row rewritten by hand after the warm prime: served as stored.
 *
 * Red, seeded once and reverted: the plant skipped, so the arms agree and the expected divergence
 * names nothing ({ verbs: [], relations: [] }), 1 failure.
 */
const STORE_PLANT: I0Seed = {
  name: 'plantedDataNode',
  needs: null,
  arms: WARM_ARMS,
  verbs: ['query'],
  beforeRun: (arm, dirs) => {
    if (arm === 'warmSameHistory') plantWrongNode(dirs.store);
    return Promise.resolve();
  },
  expect: { diverges: { relations: ['data__nodes', 'data__values', 'workspace_packages'], verbs: ['query'] } },
  consumed: {
    runs: ['warmSameHistory:measured'],
    check: (runs) => {
      const run = runs['warmSameHistory:measured']?.query;
      if (run === undefined) throw new Error('no warm dump');
      // The divergence is the plant itself, served: the warm dump carries the planted value.
      expect(relationRows(run.document, 'data__nodes').filter((row) => row.includes(PLANTED_VALUE))).toHaveLength(1);
    },
  },
};

describe('the data instance answers alike in every arm', () => {
  const suite = treeSeedSuite(DATA_TREE, import.meta.url);
  beforeAll(suite.setup);
  afterAll(suite.cleanup);

  it(seedTitle(CLEAN), async () => {
    expect(await suite.run(CLEAN)).toEqual(ARMS);
  });

  for (const seed of [ROW_SET_EVICTION, WARM_AFTER_EDIT, STORE_PLANT]) {
    it(seedTitle(seed), async () => {
      expect(await suite.run(seed)).toEqual(seed.arms);
    });
  }
});
