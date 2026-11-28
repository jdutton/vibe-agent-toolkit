/**
 * I0 over `git_content` and the `tsconfig_*` relations (spec 3.9 I0, 7.6): the clean corpus
 * (`../helpers/tsconfig-rows.ts`) answers a census of every one of them identically store-off,
 * cold, warm, with half the blob tier evicted, with half the row-set tier evicted, and warm after an
 * edit; the census holds rows in every relation, then the corpus's own answer, before it is compared.
 * State A to B over the same corpus is `tsconfig-rows-state-b.system.test.ts`.
 *
 * Reds, each seeded once and reverted:
 * - `packages/b/tsconfig.json` without `paths`: the census failed on store-off, "relations with no
 *   row: tsconfig_paths", before any comparison, 1 failure;
 * - `gitContentListing` dropping `src/untracked.ts` when the run is served its extent: the clean
 *   seed diverged on the warm arm alone, in `git_content` and `tsconfig_files`, 1 failure.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { seedRunner, seedTitle, treeSeedSuite, type I0Seed } from '../helpers/cache-differential.js';
import { EVERY_ARM, rowSetEvictionSeed, WARM_ARMS, WARM_MEASURED } from '../helpers/data-rows.js';
import {
  EDITED_ANSWER,
  EDITED_CONFIG,
  EDITED_CONFIG_BYTES,
  expectTsconfigCensus,
  TSCONFIG_ROUTED_PAIRS,
  TSCONFIG_STATE_A,
  TSCONFIG_TREE,
} from '../helpers/tsconfig-rows.js';

const stateA = TSCONFIG_STATE_A;

/** No plant beyond state A: every arm over the clean corpus. */
const CLEAN: I0Seed = {
  name: 'cleanTsconfigCorpus',
  needs: null,
  arms: EVERY_ARM,
  verbs: ['query'],
  stateA,
  expect: { agrees: { because: 'the clean tsconfig corpus, unplanted', storeDeclines: null } },
  consumed: { runs: EVERY_ARM.map((arm) => `${arm}:measured` as const), check: (runs) => expectTsconfigCensus(runs) },
};

/** Every other stored row set evicted after the warm prime: the step's reads meet the gaps and the run re-extracts exactly them. */
const ROW_SET_EVICTION: I0Seed = {
  ...rowSetEvictionSeed('tsconfigRowSetEviction', TSCONFIG_ROUTED_PAIRS, (runs) => expectTsconfigCensus(runs)),
  stateA,
};

/** One config rewritten after the prime, uncommitted: the tree moves, so the warm run derives it. */
const WARM_AFTER_EDIT: I0Seed = {
  name: 'tsconfigWarmAfterEdit',
  needs: null,
  arms: WARM_ARMS,
  verbs: ['query'],
  stateA,
  toB: (_arm, _dirs, corpus) => {
    writeFileSync(safePath.join(corpus, EDITED_CONFIG), EDITED_CONFIG_BYTES);
    return Promise.resolve();
  },
  expect: { agreesAndRepairs: { arm: 'warmSameHistory', because: 'the edit moves the tree, so the warm run derives it' } },
  consumed: { runs: WARM_MEASURED, check: (runs) => expectTsconfigCensus(runs, EDITED_ANSWER) },
};

describe('git_content and the tsconfig_* relations answer alike in every arm', () => {
  const run = seedRunner(treeSeedSuite(TSCONFIG_TREE, import.meta.url));
  for (const seed of [CLEAN, ROW_SET_EVICTION, WARM_AFTER_EDIT]) {
    it(seedTitle(seed), async () => expect(await run(seed)).toEqual(seed.arms));
  }
});
