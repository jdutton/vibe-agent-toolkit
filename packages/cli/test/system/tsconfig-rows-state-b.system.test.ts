/**
 * State A to B over the `git_content` and `tsconfig_*` I0 corpus (`../helpers/tsconfig-rows.ts`;
 * spec 7.6): each change made after the warm prime, store-off, cold and warm alike.
 * - Ignored entries added (an ignored directory, an ignored dot directory, and the file a config's
 *   ignored `files` entry names): never git content, so every answer is the clean corpus's.
 * - An untracked, unignored `src/gen.test.ts` written by a "build": `git_content` and
 *   `tsconfig_files` change by exactly that file (a root file of the root config and of the config
 *   extending it), and no other relation moves.
 */

import { describe, expect, it } from 'vitest';

import { seedRunner, seedTitle, treeSeedSuite, type I0Seed } from '../helpers/cache-differential.js';
import {
  answerWith,
  BUILD_OUTPUT,
  BUILD_OUTPUT_CONFIGS,
  CLEAN_ANSWER,
  expectTsconfigCensus,
  IGNORED_FILES,
  TSCONFIG_STATE_A,
  TSCONFIG_TREE,
} from '../helpers/tsconfig-rows.js';
import { writeCorpus } from '../test-helpers.js';

const stateA = TSCONFIG_STATE_A;

/** The arms a state-B seed runs: the reference, a cold store and a warm one primed over state A. */
const STATE_B_ARMS = ['storeOff', 'cold', 'warmSameHistory'] as const;

/** State B: the ignored entries added after the prime. Nothing git content holds moves, so every answer is the clean one. */
const IGNORED_ADDED: I0Seed = {
  name: 'ignoredEntriesAdded',
  needs: null,
  arms: STATE_B_ARMS,
  verbs: ['query'],
  stateA,
  toB: (_arm, _dirs, corpus) => {
    writeCorpus(corpus, IGNORED_FILES);
    return Promise.resolve();
  },
  expect: { agrees: { because: 'ignored entries are never git content, so the warm run is served and answers the same', storeDeclines: null } },
  consumed: { runs: STATE_B_ARMS.map((arm) => `${arm}:measured` as const), check: (runs) => expectTsconfigCensus(runs, CLEAN_ANSWER) },
};

/** State B: an untracked, unignored file a "build" writes after the prime, under the root config's `include`. */
const BUILD_WRITES_UNTRACKED: I0Seed = {
  name: 'buildWritesUntrackedTest',
  needs: null,
  arms: STATE_B_ARMS,
  verbs: ['query'],
  stateA,
  toB: (_arm, _dirs, corpus) => {
    writeCorpus(corpus, { [BUILD_OUTPUT]: 'export {};\n' });
    return Promise.resolve();
  },
  expect: { agreesAndRepairs: { arm: 'warmSameHistory', because: 'an untracked, unignored file moves the tree, so the warm run derives it' } },
  consumed: {
    runs: STATE_B_ARMS.map((arm) => `${arm}:measured` as const),
    check: (runs) => expectTsconfigCensus(runs, answerWith(BUILD_OUTPUT, BUILD_OUTPUT_CONFIGS)),
  },
};

describe('git_content and the tsconfig_* relations from state A to B', () => {
  const run = seedRunner(treeSeedSuite(TSCONFIG_TREE, import.meta.url));
  for (const seed of [IGNORED_ADDED, BUILD_WRITES_UNTRACKED]) {
    it(seedTitle(seed), async () => expect(await run(seed)).toEqual(seed.arms));
  }
});
