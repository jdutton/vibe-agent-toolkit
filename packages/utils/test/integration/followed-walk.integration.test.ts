/**
 * A walk that FOLLOWS links has no cycle guard by construction, and no
 * containment: `loop -> .` made the copy create `dest/loop/loop/…`
 * until `ENAMETOOLONG` (writing every file at every level first), and
 * `etc -> /etc` copied `/etc` into `dist`. `FollowedWalk` is the guard every
 * following walk holds; `copyTree` (`links: 'follow-contained'`) is the one in this package and is
 * tested against the shared hostile tree here. The three walks in
 * `agent-skills` are tested against the same tree in that package.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFsFaultError } from '../../src/errors/fs-fault.js';
import { safePath } from '../../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../../src/test-helpers.js';
import { installFaultFs, type FaultFsSession } from '../../src/testing/fault-fs.js';
import { type HostileTree, hostileTreePerTest } from '../../src/testing/hostile-tree.js';
import { copyTree } from '../../src/tree-change/copy-tree.js';
import { CopyLinkEscapesSourceError, DirectoryWalkRevisitedError, FollowedWalk } from '../../src/tree-change/followed-walk.js';

const FOLLOW = { links: 'follow-contained', side: 'source' } as const;

let session: FaultFsSession | undefined;
afterEach(() => {
  session?.restore();
  session = undefined;
});

describe('FollowedWalk', () => {
  const hostile = hostileTreePerTest('followed-walk-');
  beforeEach(hostile.plant);
  afterEach(hostile.clear);
  const tree = (): HostileTree => hostile.tree();

  it('admits each directory once and refuses the same directory under a second spelling', ({ skip }) => {
    if (tree().linkIn === null) skip('host cannot create symlinks');
    const walk = new FollowedWalk('source');
    walk.enter(tree().root);
    walk.enter(tree().member);
    expect(() => walk.enter(tree().linkIn ?? '')).toThrow(DirectoryWalkRevisitedError);
  });

  it('refuses the loop back to the root by its realpath, not its spelling', ({ skip }) => {
    if (tree().linkLoop === null) skip('host cannot create symlinks');
    const walk = new FollowedWalk('source');
    walk.enter(tree().root);
    expect(() => walk.enter(tree().linkLoop ?? '')).toThrow(/already walked/);
  });

  // `enter` resolves the directory's realpath: a refusal there is a fault on the walk's side, never a raw errno.
  it.each(['source', 'destination'] as const)('raises a refused realpath as a classified fault on the walk\'s side (%s)', (side) => {
    const member = tree().member;
    session = installFaultFs({ within: tree().root, faults: [{ family: 'meta', op: 'realpath', path: (p) => p === member, errno: 'EACCES' }] });
    const failure = (() => {
      try {
        new FollowedWalk(side).enter(member);
        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();
    expect(isFsFaultError(failure)).toBe(true);
    expect(failure).toMatchObject({ side, faultClass: 'refused', path: member });
  });
});

describe('copyTree (follow-contained) on the hostile tree', () => {
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

    await copyTree(src, dest(), FOLLOW);

    expect(readFileSync(safePath.join(dest(), 'deep', 'file.txt'), 'utf8')).toBe('deep\n');
    expect(readFileSync(safePath.join(dest(), 'alias.txt'), 'utf8')).toBe('deep\n');
  });

  it('refuses a link that points outside the source, before copying anything through it', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip('host cannot create symlinks');
    // A source holding only the escaping link, so the refusal is the whole story.
    const src = safePath.join(tree().root, 'nested');
    createSymlink(cap, tree().victim, safePath.join(src, 'escape'), 'dir');

    await expect(copyTree(src, dest(), FOLLOW)).rejects.toThrow(CopyLinkEscapesSourceError);
    expect(existsSync(safePath.join(dest(), 'escape', 'secret.txt'))).toBe(false);
  });

  it('refuses a link back into the tree instead of recursing until the path length runs out', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip('host cannot create symlinks');
    // The tree's own `loop` sits beside a dangling link the copy fails on
    // first (loudly, by design), so the loop is planted in a clean subtree.
    const src = safePath.join(tree().root, 'nested');
    createSymlink(cap, src, safePath.join(src, 'deep', 'back'), 'dir');

    await expect(copyTree(src, dest(), FOLLOW)).rejects.toThrow(DirectoryWalkRevisitedError);
    expect(existsSync(safePath.join(dest(), 'deep', 'back', 'deep'))).toBe(false);
  });
});
