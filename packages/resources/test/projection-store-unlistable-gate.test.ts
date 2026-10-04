/**
 * The driver's store-freshness gate for `EXTENT_DIRECTORY_UNLISTABLE` rows, at
 * unit tier.
 *
 * The real-`chmod` suite (`integration/projection-store-unlistable-freshness`)
 * pins the end-to-end hazard against a locked directory. What it leaves to this
 * file is the gate's MISS arm on its own: a stored extent carrying an
 * unlistable row for a directory that is gone — or that lists perfectly — must
 * not be served, so the contributor runs again. No permission bit is needed for
 * either, so the arm is covered on every platform and under uid 0.
 *
 * The row is injected through a store that serves what it was given plus one
 * condition row, because a tree-less unit fixture cannot make the contributor
 * write that row itself.
 */
import { mkdir, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ContributorRegistry } from '../src/projection/contributor.js';
import {
  EXTENT_DIRECTORY_UNLISTABLE,
  FilesystemExtentContributor,
} from '../src/projection/contributors/filesystem-extent.js';
import { DISCARD_BLOB_POPULATION, populate } from '../src/projection/merge.js';
import type { ExtentKey, ExtentScopedRows } from '../src/projection/store.js';
import { CONDITION_WITHOUT_REFERENCE } from '../src/schemas/projection-resources.js';

import { FakeProjectionStore } from './fake-projection-store.js';
import { setupSubdirTestSuite } from './test-helpers.js';

const suite = setupSubdirTestSuite('projection-store-unlistable-gate-');

/** Opaque to the store, and constant across runs — the gate is what has to tell. */
const TREE_HASH = 'tree-0000000000000000000000000000000000000000';

/** A directory the injected row claims could not be listed. */
const ROW_DIR = 'build/locked';

/**
 * A {@link FakeProjectionStore} whose reads carry one extra
 * `EXTENT_DIRECTORY_UNLISTABLE` row for {@link ROW_DIR} when `inject` is set —
 * the stored shape a run over a locked, gitignored directory leaves behind.
 */
class UnlistableRowStore extends FakeProjectionStore {
  inject = false;

  override async readExtent(key: ExtentKey): Promise<ExtentScopedRows | undefined> {
    const stored = await super.readExtent(key);
    if (stored === undefined || !this.inject) return stored;
    const anchor = stored.resourceRealizations[0];
    if (anchor === undefined) throw new Error('fixture produced no realization to anchor the injected row on');
    return {
      ...stored,
      realizationConditions: [
        ...stored.realizationConditions,
        {
          extentId: anchor.extentId,
          path: ROW_DIR,
          code: EXTENT_DIRECTORY_UNLISTABLE,
          severity: 'warning',
          message: `The gitignored directory '${ROW_DIR}' could not be listed (EACCES).`,
          resourceId: anchor.resourceId,
          ...CONDITION_WITHOUT_REFERENCE,
        },
      ],
    };
  }
}

/**
 * One tracker-less filesystem-extent population through `store`.
 *
 * @returns Whether any contributor ran — false is the signature of a store hit
 */
async function contributorRanThrough(store: FakeProjectionStore): Promise<boolean> {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());
  let ran = false;
  await populate({
    root: suite.tempDir,
    registry,
    onBlobPopulation: DISCARD_BLOB_POPULATION,
    onContributorTiming: () => {
      ran = true;
    },
    cache: { store, treeUnchanged: () => true, treeHash: TREE_HASH },
  });
  return ran;
}

describe('a stored EXTENT_DIRECTORY_UNLISTABLE row that no longer holds turns a hit into a miss', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(async () => {
    await suite.beforeEach();
    await writeFile(safePath.join(suite.tempDir, 'ok.md'), '# ok\n');
  });

  it('serves the stored extent when no unlistable row is stored (control)', async () => {
    const store = new UnlistableRowStore();
    expect(await contributorRanThrough(store)).toBe(true);

    expect(await contributorRanThrough(store)).toBe(false);
    expect(store.writeExtentCalls).toBe(1);
  });

  it('re-enumerates when the row names a directory that is gone', async () => {
    const store = new UnlistableRowStore();
    await contributorRanThrough(store);
    store.inject = true;

    expect(await contributorRanThrough(store)).toBe(true);
    expect(store.writeExtentCalls).toBe(2);
  });

  it('re-enumerates when the row names a directory that now lists', async () => {
    const store = new UnlistableRowStore();
    await contributorRanThrough(store);
    await mkdir(safePath.join(suite.tempDir, ROW_DIR), { recursive: true });
    store.inject = true;

    expect(await contributorRanThrough(store)).toBe(true);
    expect(store.writeExtentCalls).toBe(2);
  });
});
