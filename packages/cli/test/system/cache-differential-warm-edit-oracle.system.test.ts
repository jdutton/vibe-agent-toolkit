/**
 * The edit oracle's red proof (D20): a warm run made to key the pre-edit tree after an edit is
 * served the pre-edit extent, and the oracle alone must fail on it, naming the edited path.
 *
 * The stale key comes from the test seam on the store key (`VAT_TEST_TREE_HASH_FILE`, honoured
 * only in a test process): `runGit` scrubs an inherited `GIT_INDEX_FILE`, so the environment
 * cannot point the snapshot at the pre-edit index. The seam's file is written only after the
 * prime, so the prime keys the real tree, and the measured run keys the primed one.
 *
 * Nothing else is asserted of the warm arm: a write, origin or agreement assertion would trip
 * on the stale hit before the oracle did.
 */

import { appendFileSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_TREE_HASH_FILE_ENV } from '../../src/utils/projection-store.js';
import { heldSnapshotHashes, seedSuite, seedTitle, type ArmDirs, type I0Seed } from '../helpers/cache-differential.js';

/** The tracked file the seed edits after the prime. */
const EDITED = 'docs/two.md';

/** Where a cell's seam file goes: beside its directories, never in the corpus. */
function seamFile(dirs: ArmDirs): string {
  return safePath.join(dirs.root, 'test-tree-hash');
}

const staleKey: I0Seed = {
  name: 'a run keyed to the pre-edit tree',
  needs: null,
  arms: ['storeOff', 'warmSameHistory'],
  verbs: ['query'],
  env: (arm, dirs) => (arm === 'warmSameHistory' ? { [TEST_TREE_HASH_FILE_ENV]: seamFile(dirs) } : {}),
  toB: (arm, dirs, corpus) => {
    appendFileSync(safePath.join(corpus, EDITED), '\nEdited after the prime.\n');
    if (arm === 'warmSameHistory') {
      const held = heldSnapshotHashes(dirs);
      expect(held, 'the prime filed one tree').toHaveLength(1);
      writeFileSync(seamFile(dirs), held.join(''));
    }
    return Promise.resolve();
  },
  expect: { staleServed: { arm: 'warmSameHistory', editedPath: EDITED } },
  consumed: { runs: [], check: () => undefined },
};

const suite = seedSuite(import.meta.url);

describe('the edit oracle fails on a stale hit', () => {
  beforeAll(suite.setup);
  afterAll(suite.cleanup);

  it(seedTitle(staleKey), async () => {
    expect(await suite.run(staleKey)).toEqual(staleKey.arms);
  });
});
