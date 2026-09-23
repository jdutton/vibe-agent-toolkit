/**
 * A cached declined-link row must still carry the code the HOST gives it now.
 *
 * A declined symbolic link's code (`EXTENT_SYMLINK_NOT_REALIZED` /
 * `_TARGET_OUTSIDE_ROOT` / `_TARGET_UNRESOLVED`) is decided by
 * `realpathSync.native` — and where a link resolves depends on files the tree
 * hash does not cover: a gitignored target, or anything outside the root. So a
 * run that met `.claude/rules/gen.md -> ../../build/gen.md` before `build/gen.md`
 * existed wrote `TARGET_UNRESOLVED`, and every later run over the same tree hash
 * was served it after the build produced the file — reporting a rule Claude
 * Code now loads as one it loads nothing through.
 *
 * Fix: a hit whose declined-link rows no longer resolve to the stored code is
 * not a hit. One `realpath` per stored link row, never per path.
 *
 * Real symbolic links, so this is the integration tier.
 */
import { rmSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXTENT_SYMLINK_NOT_REALIZED,
  EXTENT_SYMLINK_TARGET_UNRESOLVED,
  isDeclinedSymlinkCode,
} from '../../src/projection/contributors/filesystem-extent.js';
import type { Projection } from '../../src/projection/projection.js';
import { FakeProjectionStore, populateExtentThrough } from '../fake-projection-store.js';
import { createCommittedRepo } from '../test-helpers.js';

const LINK = '.claude/rules/gen.md';
const IGNORED_TARGET = 'build/gen.md';
/** Opaque to the store, and deliberately CONSTANT across the build — that is the hazard. */
const TREE_HASH = 'tree-1111111111111111111111111111111111111111';
const CAPABILITY = symlinkCapability();

let root: string;

/** One population of `root` through `store`, reporting whether a contributor ran. */
async function populateThrough(store: FakeProjectionStore): Promise<{ projection: Projection; contributorRan: boolean }> {
  return populateExtentThrough(root, store, TREE_HASH);
}

/** The code of the one declined-link row at {@link LINK}. */
function linkCode(projection: Projection): string | undefined {
  return projection.realizationConditions.find((row) => row.path === LINK && isDeclinedSymlinkCode(row.code))?.code;
}

describe.skipIf(CAPABILITY === null)('a cached declined-link row is re-resolved on a hit', () => {
  beforeEach(() => {
    if (CAPABILITY === null) return;
    root = createCommittedRepo('vat-store-symlink-', { files: { 'CLAUDE.md': '# c\n' }, gitignore: 'build/\n' });
    mkdirSyncReal(safePath.join(root, '.claude/rules'), { recursive: true });
    createSymlink(CAPABILITY, '../../build/gen.md', safePath.join(root, LINK), 'file');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('replays the row while the link still resolves the same way (control)', async () => {
    const store = new FakeProjectionStore();

    const first = await populateThrough(store);
    const second = await populateThrough(store);

    expect(linkCode(first.projection)).toBe(EXTENT_SYMLINK_TARGET_UNRESOLVED);
    expect(second.contributorRan).toBe(false);
    expect(linkCode(second.projection)).toBe(EXTENT_SYMLINK_TARGET_UNRESOLVED);
    expect(store.writeExtentCalls).toBe(1);
  });

  it('re-enumerates once a gitignored target appears under the same tree hash', async () => {
    const store = new FakeProjectionStore();
    await populateThrough(store);

    mkdirSyncReal(safePath.join(root, 'build'), { recursive: true });
    writeFileSync(safePath.join(root, IGNORED_TARGET), '# generated\n');
    const after = await populateThrough(store);

    expect(after.contributorRan).toBe(true);
    expect(linkCode(after.projection)).toBe(EXTENT_SYMLINK_NOT_REALIZED);
    expect(store.writeExtentCalls).toBe(2);
  });

  it('re-enumerates once the target disappears again', async () => {
    mkdirSyncReal(safePath.join(root, 'build'), { recursive: true });
    writeFileSync(safePath.join(root, IGNORED_TARGET), '# generated\n');
    const store = new FakeProjectionStore();
    const first = await populateThrough(store);
    expect(linkCode(first.projection)).toBe(EXTENT_SYMLINK_NOT_REALIZED);

    rmSync(safePath.join(root, 'build'), { recursive: true, force: true });
    const after = await populateThrough(store);

    expect(after.contributorRan).toBe(true);
    expect(linkCode(after.projection)).toBe(EXTENT_SYMLINK_TARGET_UNRESOLVED);
  });
});
