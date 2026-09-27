/**
 * A cached `EXTENT_DIRECTORY_UNLISTABLE` row must still be TRUE when it is
 * replayed.
 *
 * The store key is the tree hash plus the ambient inputs, and the tree hash is
 * `git add --all` over non-ignored content: the permission bit on a gitignored
 * directory is not in it. So a run that met a locked `build/locked` wrote a
 * warning row, and every later run over the same tree hash was served that row
 * — after `chmod 755`, with the directory perfectly listable and its rows
 * missing from the served population, the report still said it could not be
 * listed. The reverse (locked after caching) is the pre-existing staleness of
 * every ignored row and is not what this suite pins.
 *
 * Fix: a hit whose unlistable rows no longer hold is not a hit. The driver
 * re-probes each such directory (rare by nature — one `readdir` attempt per
 * row, never per path) and, if any now lists or is gone, re-enumerates.
 *
 * A real repository and a real `chmod 000`: the git arm's refusal comes from
 * git's own walk, which no `readdir` spy reaches. POSIX-only, not as root.
 */
import { chmodSync, existsSync, rmSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXTENT_DIRECTORY_UNLISTABLE,
} from '../src/projection/contributors/filesystem-extent.js';
import type { Projection } from '../src/projection/projection.js';

import { FakeProjectionStore, populateExtentThrough } from './fake-projection-store.js';
import { createCommittedRepo, writeFileIn } from './test-helpers.js';

/** `chmod 000` denies nothing to uid 0 and binds nothing on Windows. */

const OPEN_FILE = 'docs/ok.md';
const IGNORED_LOCKED_DIR = 'build/locked';
const IGNORED_LOCKED_FILE = `${IGNORED_LOCKED_DIR}/b.md`;
/** Opaque to the store, and deliberately CONSTANT across a lock change — that is the hazard. */
const TREE_HASH = 'tree-0000000000000000000000000000000000000000';

let root: string;
let locked: string;

/** One population of `root` through `store`, reporting whether a contributor ran. */
async function populateThrough(store: FakeProjectionStore): Promise<{ projection: Projection; contributorRan: boolean }> {
  return populateExtentThrough(root, store, TREE_HASH);
}

/** The root-relative paths of every unlistable-directory row. */
function unlistableRows(projection: Projection): string[] {
  return projection.realizationConditions
    .filter((row) => row.code === EXTENT_DIRECTORY_UNLISTABLE)
    .map((row) => row.path);
}

describe.skipIf(CANNOT_DENY_READS)('a cached EXTENT_DIRECTORY_UNLISTABLE row is re-verified on a hit', () => {
  beforeEach(() => {
    root = createCommittedRepo('vat-store-unlistable-', { files: { [OPEN_FILE]: '# ok\n' }, gitignore: 'build/\n' });
    writeFileIn(root, IGNORED_LOCKED_FILE, '# b\n');
    locked = safePath.join(root, IGNORED_LOCKED_DIR);
    chmodSync(locked, 0o000);
  });

  afterEach(() => {
    // One test removes the directory outright; the sweep must not trip on it.
    if (existsSync(locked)) chmodSync(locked, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the row on the first run and replays it while the directory is still locked (control)', async () => {
    const store = new FakeProjectionStore();

    const first = await populateThrough(store);
    const second = await populateThrough(store);

    expect(first.contributorRan).toBe(true);
    expect(unlistableRows(first.projection)).toEqual([IGNORED_LOCKED_DIR]);
    // A genuine hit: nothing ran, and the row — still true — is served.
    expect(second.contributorRan).toBe(false);
    expect(unlistableRows(second.projection)).toEqual([IGNORED_LOCKED_DIR]);
    expect(store.writeExtentCalls).toBe(1);
  });

  it('re-enumerates instead of replaying the row once the directory can be listed again', async () => {
    const store = new FakeProjectionStore();
    await populateThrough(store);

    chmodSync(locked, 0o755);
    const after = await populateThrough(store);

    // Not a hit: the cached population was enumerated around a gap that has
    // since closed, so the row would be stale and the rows beneath it missing.
    expect(after.contributorRan).toBe(true);
    expect(unlistableRows(after.projection)).toEqual([]);
    expect(after.projection.resourceRealizations.map((row) => row.path)).toContain(IGNORED_LOCKED_FILE);
    expect(store.writeExtentCalls).toBe(2);
  });

  it('re-enumerates when the directory is gone, not only when it is readable', async () => {
    const store = new FakeProjectionStore();
    await populateThrough(store);

    chmodSync(locked, 0o755);
    rmSync(locked, { recursive: true, force: true });
    const after = await populateThrough(store);

    expect(after.contributorRan).toBe(true);
    expect(unlistableRows(after.projection)).toEqual([]);
  });
});
