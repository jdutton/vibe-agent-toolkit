/**
 * I0, git's index flags: a tracked file flagged `--assume-unchanged` or `--skip-worktree`
 * is one git does not read, so an edit to it leaves `git status` clean and the tree hash
 * where it was. The tree key declines while any file is flagged
 * (`GIT_SNAPSHOT_INDEX_HIDES`), on the run that would write and the run that would read,
 * so each seed's store-on runs over a flagged tree are held to the declined tell and must
 * answer as store-off does (`indexFlagSeeds` states both directions).
 *
 * Over the gate fixture, whose custom SQL checks read edges: `vat resources check` and
 * `vat validate`, whose checks phase is a child process that keys the tree again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { indexFlagSeeds, seedSuite, seedTitle } from '../helpers/cache-differential.js';

/** The gate fixture's file every seed edits: tracked, with no links until the edit adds a broken one. */
const FLAGGED = 'docs/two.md';

const seeds = (['assume-unchanged', 'skip-worktree'] as const).flatMap((flag) => indexFlagSeeds(flag, {
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
