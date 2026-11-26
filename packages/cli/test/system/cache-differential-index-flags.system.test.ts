/**
 * I0, git's index flags: a tracked file flagged `--assume-unchanged` or `--skip-worktree`, or
 * written under `core.ignoreStat`, is one `git status` does not read, so an edit to it leaves the
 * status clean. The snapshot sees it anyway: its temp index clears assume-unchanged, and
 * skip-worktree on an entry present on disk, so the edit moves the tree hash and each store-on
 * run keys, misses where the bytes moved, and answers as store-off does (`indexFlagSeeds` states
 * both directions). Sparse checkouts, where skip-worktree comes from the checkout's patterns, are
 * `cache-differential-sparse-checkout`.
 *
 * Over the gate fixture, whose custom SQL checks read edges: `vat resources check` and
 * `vat validate`, whose checks phase is a child process that keys the tree again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { indexFlagSeeds, seedSuite, seedTitle } from '../helpers/cache-differential.js';

/** The gate fixture's file every seed edits: tracked, with no links until the edit adds a broken one. */
const FLAGGED = 'docs/two.md';

const seeds = (['assume-unchanged', 'skip-worktree', 'core.ignoreStat'] as const).flatMap((flag) => indexFlagSeeds(flag, {
  path: FLAGGED,
  edited: '# Two\n\nNow [gone](./gone.md).\n',
  arms: ['storeOff', 'cold', 'warmSameHistory'],
  verbs: ['check', 'vatValidate'],
}));

const suite = seedSuite(import.meta.url);

describe('a file git is told not to look at, edited on either side of the prime', () => {
  beforeAll(suite.setup);
  afterAll(suite.cleanup);

  for (const seed of seeds) {
    it(seedTitle(seed), async () => {
      expect(await suite.run(seed)).toEqual(seed.arms);
    });
  }
});
