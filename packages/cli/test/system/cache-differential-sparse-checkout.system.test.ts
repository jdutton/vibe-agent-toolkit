/**
 * I0, sparse checkouts: skip-worktree set by a checkout's patterns, not by hand.
 *
 * - An entry with nothing on disk hides no bytes: a sparse checkout keys and keeps the store, and
 *   the same tree with the file back keys apart from it.
 * - A cone checkout that expects files outside its patterns leaves skip-worktree on an
 *   out-of-cone file written back to disk; the snapshot clears it on a present entry, so the edit
 *   moves the tree hash and the warm run misses.
 * - The one state the snapshot cannot see: a sparse INDEX holding a directory as one collapsed
 *   entry while a file inside it is on disk. The temp index never expands it, so the tree key
 *   declines (`GIT_SNAPSHOT_INDEX_HIDES`) on every store-on run, which answers as store-off does.
 *
 * Over the gate fixture: `vat resources check` and `vat validate`, whose checks phase is a child
 * process that keys the tree again.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Git, type I0Seed, type RecordedRuns, seedSuite, seedTitle } from '../helpers/cache-differential.js';

/** The gate fixture's file a cone checkout leaves out and a seed writes back: tracked, linking nowhere until edited. */
const FLAGGED = 'docs/two.md';

/** {@link FLAGGED}'s edit: a link to a file no fixture holds. */
const FLAGGED_EDIT = '# Two\n\nNow [gone](./gone.md).\n';

/** The gate fixture's file a sparse checkout leaves out: `docs/one.md` links to it. */
const SPARSE_OUT = 'docs/two.md';

/** Leave {@link SPARSE_OUT} out of the checkout: absent from disk, skip-worktree in the index. */
function sparseWithout(git: Git): Promise<void> {
  git(['sparse-checkout', 'set', '--no-cone', '/*', `!/${SPARSE_OUT}`]);
  expect(git(['ls-files', '-v', '--', SPARSE_OUT]).startsWith('S '), `${SPARSE_OUT} is skip-worktree`).toBe(true);
  return Promise.resolve();
}

/** The `vat validate` findings of a broken link, in one recorded run. */
function brokenLinks(runs: RecordedRuns, label: keyof RecordedRuns): Array<Record<string, unknown>> {
  const findings = (runs[label]?.vatValidate?.document['findings'] ?? []) as Array<Record<string, unknown>>;
  return findings.filter((finding) => finding['code'] === 'LINK_BROKEN_FILE');
}

/** The `vat validate` findings of a broken link to {@link SPARSE_OUT}, in one recorded run. */
function brokenLinksToSparseOut(runs: RecordedRuns, label: keyof RecordedRuns): unknown[] {
  return brokenLinks(runs, label).filter((finding) => String(finding['link']).includes('two.md'));
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

/** The gate fixture's directory a cone checkout keeps: {@link FLAGGED}'s `docs/` falls outside it. */
const CONE = '.claude';

/**
 * Cone-mode sparse checkout of {@link CONE} only, with files expected outside the patterns, so git
 * leaves skip-worktree on an out-of-cone file written back to disk.
 *
 * @param git - The cell's git
 * @param sparseIndex - Whether the index holds each out-of-cone directory as one collapsed entry
 */
function coneWithoutDocs(git: Git, sparseIndex: boolean): void {
  git(['config', 'sparse.expectFilesOutsideOfPatterns', 'true']);
  git(['sparse-checkout', 'init', '--cone', ...(sparseIndex ? ['--sparse-index'] : [])]);
  git(['sparse-checkout', 'set', CONE]);
  expect(git(['ls-files', '-v', '--', FLAGGED]).startsWith('S '), `${FLAGGED} is skip-worktree`).toBe(true);
}

/** Write {@link FLAGGED}'s edit back into the out-of-cone directory the checkout removed. */
function writeEditOutOfCone(corpus: string, git: Git): void {
  mkdirSyncReal(safePath.join(corpus, 'docs'), { recursive: true });
  writeFileSync(safePath.join(corpus, FLAGGED), FLAGGED_EDIT);
  expect(git(['status', '--porcelain', '--', FLAGGED]).trim(), 'git does not see the edit').toBe('');
}

/** The `vat validate` findings of the broken link {@link FLAGGED_EDIT} adds, in store-off's measured run. */
function editedLinkReported(runs: RecordedRuns): unknown[] {
  return brokenLinks(runs, 'storeOff:measured').filter((finding) => finding['location'] === FLAGGED && finding['link'] === './gone.md');
}

const coneSeeds: readonly I0Seed[] = [
  {
    name: 'an out-of-cone file written back after the prime, files expected outside the patterns',
    needs: null,
    arms: ['storeOff', 'cold', 'warmSameHistory'],
    verbs: ['check', 'vatValidate'],
    stateA: (_corpus, git) => {
      coneWithoutDocs(git, false);
      return Promise.resolve();
    },
    toB: (_arm, _dirs, corpus, git) => {
      writeEditOutOfCone(corpus, git);
      return Promise.resolve();
    },
    expect: { agreesAndMisses: { arm: 'warmSameHistory' } },
    consumed: {
      runs: ['storeOff:measured'],
      check: (runs) => {
        expect(editedLinkReported(runs), 'store-off reads the edit').toHaveLength(1);
      },
    },
  },
  {
    name: 'an edit inside a directory a sparse index holds collapsed',
    needs: null,
    arms: ['storeOff', 'cold', 'warmSameHistory'],
    verbs: ['check', 'vatValidate'],
    stateA: (corpus, git) => {
      coneWithoutDocs(git, true);
      writeEditOutOfCone(corpus, git);
      // The index's real state: `docs/` is one collapsed entry, so no temp index sees the file.
      expect(git(['ls-files', '--sparse', '-s', '--', 'docs']).split('\n').some((line) => line.startsWith('040000 ')), 'docs/ is collapsed').toBe(true);
      return Promise.resolve();
    },
    expect: {
      agrees: {
        because: 'the snapshot cannot see a file inside a collapsed sparse-index directory, so the tree key declines',
        storeDeclines: { prime: true, measured: true },
      },
    },
    consumed: {
      runs: ['storeOff:measured'],
      check: (runs) => {
        expect(editedLinkReported(runs), 'store-off reads the edit').toHaveLength(1);
      },
    },
  },
];

const suite = seedSuite(import.meta.url);

describe('a sparse checkout, on either side of the prime', () => {
  beforeAll(suite.setup);
  afterAll(suite.cleanup);

  for (const seed of [...sparseSeeds, ...coneSeeds]) {
    it(seedTitle(seed), async () => {
      expect(await suite.run(seed)).toEqual(seed.arms);
    });
  }
});
