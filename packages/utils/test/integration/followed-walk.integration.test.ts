/**
 * A walk that FOLLOWS links has no cycle guard by construction, and no
 * containment: `loop -> .` made `copyDirectory` create `dest/loop/loop/…`
 * until `ENAMETOOLONG` (writing every file at every level first), and
 * `etc -> /etc` copied `/etc` into `dist`. `FollowedWalk` is the guard every
 * following walk holds; `copyDirectory` is the one in this package and is
 * tested against the shared hostile tree here. The three walks in
 * `agent-skills` are tested against the same tree in that package.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DirectoryWalkRevisitedError, FollowedWalk } from '../../src/dirent-kind.js';
import { CopyLinkEscapesSourceError, copyDirectory } from '../../src/fs-utils.js';
import { safePath } from '../../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../../src/test-helpers.js';
import { type HostileTree, hostileTreePerTest } from '../../src/testing/hostile-tree.js';

describe('FollowedWalk', () => {
  const hostile = hostileTreePerTest('followed-walk-');
  beforeEach(hostile.plant);
  afterEach(hostile.clear);
  const tree = (): HostileTree => hostile.tree();

  it('admits each directory once and refuses the same directory under a second spelling', ({ skip }) => {
    if (tree().linkIn === null) skip('host cannot create symlinks');
    const walk = new FollowedWalk();
    walk.enter(tree().root);
    walk.enter(tree().member);
    expect(() => walk.enter(tree().linkIn ?? '')).toThrow(DirectoryWalkRevisitedError);
  });

  it('refuses the loop back to the root by its realpath, not its spelling', ({ skip }) => {
    if (tree().linkLoop === null) skip('host cannot create symlinks');
    const walk = new FollowedWalk();
    walk.enter(tree().root);
    expect(() => walk.enter(tree().linkLoop ?? '')).toThrow(/already walked/);
  });
});

describe('copyDirectory on the hostile tree', () => {
  const hostile = hostileTreePerTest('copy-directory-hostile-');
  beforeEach(hostile.plant);
  afterEach(hostile.clear);
  const tree = (): HostileTree => hostile.tree();
  const dest = (): string => safePath.join(path.dirname(tree().root), 'dest');

  it('copies a tree with a link to a file inside it, following the link to its bytes', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip('host cannot create symlinks');
    const src = safePath.join(tree().root, 'nested');
    writeFileSync(safePath.join(src, 'deep', 'file.txt'), 'deep\n');
    createSymlink(cap, safePath.join(src, 'deep', 'file.txt'), safePath.join(src, 'alias.txt'), 'file');

    await copyDirectory(src, dest());

    expect(readFileSync(safePath.join(dest(), 'deep', 'file.txt'), 'utf8')).toBe('deep\n');
    expect(readFileSync(safePath.join(dest(), 'alias.txt'), 'utf8')).toBe('deep\n');
  });

  it('refuses a link that points outside the source, before copying anything through it', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip('host cannot create symlinks');
    // A source holding only the escaping link, so the refusal is the whole story.
    const src = safePath.join(tree().root, 'nested');
    createSymlink(cap, tree().victim, safePath.join(src, 'escape'), 'dir');

    await expect(copyDirectory(src, dest())).rejects.toThrow(CopyLinkEscapesSourceError);
    expect(existsSync(safePath.join(dest(), 'escape', 'secret.txt'))).toBe(false);
  });

  it('refuses a link back into the tree instead of recursing until the path length runs out', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip('host cannot create symlinks');
    // The tree's own `loop` sits beside a dangling link the copy fails on
    // first (loudly, by design), so the loop is planted in a clean subtree.
    const src = safePath.join(tree().root, 'nested');
    createSymlink(cap, src, safePath.join(src, 'deep', 'back'), 'dir');

    await expect(copyDirectory(src, dest())).rejects.toThrow(DirectoryWalkRevisitedError);
    expect(existsSync(safePath.join(dest(), 'deep', 'back', 'deep'))).toBe(false);
  });
});
