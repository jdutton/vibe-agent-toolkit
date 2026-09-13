/**
 * The two Dirent classifiers: one that refuses to follow a link and says so,
 * one that follows it with a single `stat` and reports a missing target as
 * `dangling` rather than as nothing. Real tree, because the subject is what
 * `readdir` hands back for a symlink.
 */
import { readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { direntKind, direntKindFollowing, direntKindFollowingSync } from '../../src/dirent-kind.js';
import { type HostileTree, hostileTreePerTest } from '../../src/testing/hostile-tree.js';

describe('dirent-kind', () => {
  const hostile = hostileTreePerTest('dirent-kind-');
  beforeEach(hostile.plant);
  afterEach(hostile.clear);
  const tree = (): HostileTree => hostile.tree();

  const entryIn = (dir: string, name: string) => {
    const found = readdirSync(dir, { withFileTypes: true }).find((e) => e.name === name);
    if (found === undefined) throw new Error(`fixture has no entry ${name}`);
    return found;
  };
  const entry = (name: string) => entryIn(tree().root, name);

  it('direntKind reports a directory and a file as themselves', () => {
    expect(direntKind(entry('member'))).toBe('directory');
    expect(direntKind(entryIn(tree().member, 'file.txt'))).toBe('file');
  });

  it('direntKind reports every link as a symlink, whatever it points at', ({ skip }) => {
    if (tree().linkOut === null) skip('host cannot create symlinks');
    expect(direntKind(entry('link-out'))).toBe('symlink');
    expect(direntKind(entry('link-in'))).toBe('symlink');
    expect(direntKind(entry('dangling'))).toBe('symlink');
  });

  it('direntKindFollowing answers a link by its target, and a missing target as dangling', async ({ skip }) => {
    if (tree().linkOut === null) skip('host cannot create symlinks');
    expect(direntKindFollowingSync(tree().root, entry('link-out'))).toBe('directory');
    expect(direntKindFollowingSync(tree().root, entry('link-in'))).toBe('directory');
    expect(direntKindFollowingSync(tree().root, entry('dangling'))).toBe('dangling');
    const listed = await readdir(tree().root, { withFileTypes: true });
    const byName = (name: string) => {
      const found = listed.find((e) => e.name === name);
      if (found === undefined) throw new Error(`fixture has no entry ${name}`);
      return found;
    };
    expect(await direntKindFollowing(tree().root, byName('dangling'))).toBe('dangling');
    expect(await direntKindFollowing(tree().root, byName('member'))).toBe('directory');
  });

  it('direntKindFollowing spends no syscall on a non-link (a refused stat would otherwise surface)', () => {
    // The unreadable directory can be classified from its own Dirent; only a
    // link INTO it would need a stat the OS refuses.
    expect(direntKindFollowingSync(tree().root, entry('member'))).toBe('directory');
    if (tree().unreadable !== null) {
      expect(direntKindFollowingSync(tree().root, entry('unreadable'))).toBe('directory');
    }
  });
});
