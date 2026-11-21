/**
 * I0, git's index flags: a tracked file flagged `--assume-unchanged` or `--skip-worktree`
 * is one git does not read, so an edit to it leaves `git status` clean and the tree hash
 * where it was. The tree key declines while any file is flagged
 * (`GIT_SNAPSHOT_INDEX_HIDES`), on the run that would write and the run that would read,
 * so each seed's store-on runs over a flagged tree are held to the declined tell and must
 * answer as store-off does (`indexFlagSeeds` states both directions).
 *
 * The one flagged entry that hides no bytes is skip-worktree with nothing on disk: a sparse
 * checkout keys and keeps the store, and the same tree with the file back keys apart from it.
 *
 * Over the gate fixture, whose custom SQL checks read edges: `vat resources check` and
 * `vat validate`, whose checks phase is a child process that keys the tree again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Git, type I0Seed, indexFlagSeeds, type RecordedRuns, seedSuite, seedTitle } from '../helpers/cache-differential.js';

/** The gate fixture's file every seed edits: tracked, with no links until the edit adds a broken one. */
const FLAGGED = 'docs/two.md';

const seeds = (['assume-unchanged', 'skip-worktree'] as const).flatMap((flag) => indexFlagSeeds(flag, {
  path: FLAGGED,
  edited: '# Two\n\nNow [gone](./gone.md).\n',
  arms: ['storeOff', 'cold', 'warmSameHistory'],
  verbs: ['check', 'vatValidate'],
}));

/** The gate fixture's file a sparse checkout leaves out: `docs/one.md` links to it. */
const SPARSE_OUT = 'docs/two.md';

/** Leave {@link SPARSE_OUT} out of the checkout: absent from disk, skip-worktree in the index. */
function sparseWithout(git: Git): Promise<void> {
  git(['sparse-checkout', 'set', '--no-cone', '/*', `!/${SPARSE_OUT}`]);
  expect(git(['ls-files', '-v', '--', SPARSE_OUT]).startsWith('S '), `${SPARSE_OUT} is skip-worktree`).toBe(true);
  return Promise.resolve();
}

/** The `vat validate` findings of a broken link to {@link SPARSE_OUT}, in one recorded run. */
function brokenLinksToSparseOut(runs: RecordedRuns, label: keyof RecordedRuns): unknown[] {
  const findings = (runs[label]?.vatValidate?.document['findings'] ?? []) as Array<Record<string, unknown>>;
  return findings.filter((finding) => finding['code'] === 'LINK_BROKEN_FILE' && String(finding['link']).includes('two.md'));
}

const sparseSeeds: readonly I0Seed[] = [
  {
    name: 'a sparse checkout',
    needs: null,
    arms: ['storeOff', 'cold', 'warmSameHistory'],
    verbs: ['check', 'vatValidate'],
    stateA: (_corpus, git) => sparseWithout(git),
    // `null`: no run declines, so the warm arm is held to its own tell, served by the store.
    expect: { agrees: { because: 'an absent skip-worktree file hides no bytes, so the tree keys and the store serves it', storeDeclines: null } },
    consumed: {
      runs: ['storeOff:measured'],
      check: (runs) => {
        expect(brokenLinksToSparseOut(runs, 'storeOff:measured'), 'the file is absent').toHaveLength(1);
      },
    },
  },
  {
    name: 'a sparse checkout disabled after the prime',
    needs: null,
    arms: ['storeOff', 'warmSameHistory'],
    verbs: ['check', 'vatValidate'],
    stateA: (_corpus, git) => sparseWithout(git),
    toB: (_arm, _dirs, _corpus, git) => {
      git(['sparse-checkout', 'disable']);
      return Promise.resolve();
    },
    // One tree hash either way: the index holds the file's bytes. The key tells the absence apart.
    expect: { agreesAndMisses: { arm: 'warmSameHistory' } },
    consumed: {
      runs: ['storeOff:measured'],
      check: (runs) => {
        expect(brokenLinksToSparseOut(runs, 'storeOff:measured'), 'the file is back').toEqual([]);
      },
    },
  },
];

const suite = seedSuite(import.meta.url);

describe('a file git is told not to look at, edited on either side of the prime', () => {
  beforeAll(suite.setup);
  afterAll(suite.cleanup);

  for (const seed of [...seeds, ...sparseSeeds]) {
    it(seedTitle(seed), async () => {
      expect(await suite.run(seed)).toEqual(seed.arms);
    });
  }
});
