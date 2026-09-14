/**
 * `isUnderRoot(root, candidate)` — the containment question a delete, copy or
 * uninstall sink asks, answered by the filesystem rather than by the spelling.
 *
 * Integration tier because every case is a real tree: the point of the helper
 * is what `realpath` says about a symlink, and no string fixture can stand in
 * for that. The hostile shapes come from {@link buildHostileTree}, so the
 * sinks' own suites and this one are refusing the same fixture.
 */

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isUnderRoot } from '../../src/path-containment.js';
import { safePath } from '../../src/path-utils.js';
import { HOSTILE_NAMES, type HostileTree, hostileTreePerTest } from '../../src/testing/hostile-tree.js';

describe('isUnderRoot', () => {
  const hostile = hostileTreePerTest('path-containment-');
  beforeEach(hostile.plant);
  afterEach(hostile.clear);
  const tree = (): HostileTree => hostile.tree();

  describe('a path that exists', () => {
    it('is inside when it is a strict descendant', () => {
      expect(isUnderRoot(tree().root, tree().member)).toBe('inside');
      expect(isUnderRoot(tree().root, safePath.join(tree().root, 'nested', 'deep'))).toBe('inside');
    });

    it('is outside when it is a sibling, an ancestor, or the victim a traversal reaches', () => {
      expect(isUnderRoot(tree().root, tree().outside)).toBe('outside');
      expect(isUnderRoot(tree().root, tree().victim)).toBe('outside');
      expect(isUnderRoot(tree().root, safePath.join(tree().root, '..'))).toBe('outside');
      expect(isUnderRoot(tree().root, safePath.join(tree().root, '..', 'victim'))).toBe('outside');
    });

    it('is outside for the root itself — "under" is strict, so a sink cannot delete its own root', () => {
      expect(isUnderRoot(tree().root, tree().root)).toBe('outside');
      expect(isUnderRoot(tree().root, `${tree().root}/`)).toBe('outside');
      expect(isUnderRoot(tree().root, safePath.join(tree().root, 'member', '..'))).toBe('outside');
    });

    it('is inside for a member whose name merely begins with two dots', () => {
      expect(isUnderRoot(tree().root, tree().dotdotNamed)).toBe('inside');
    });

    it('is not fooled by a sibling whose name extends the root\'s', () => {
      const sibling = `${tree().root}-evil`;
      mkdirSyncReal(sibling);
      expect(isUnderRoot(tree().root, sibling)).toBe('outside');
    });

    it('resolves a relative spelling from cwd, like every path API', () => {
      expect(isUnderRoot(tree().root, safePath.relative(process.cwd(), tree().member))).toBe('inside');
    });
  });

  describe('a symlink', () => {
    it('inside the root that points OUTSIDE is outside — the spelling lies, the filesystem does not', ({ skip }) => {
      if (tree().linkOut === null) skip('host cannot create symlinks');
      expect(isUnderRoot(tree().root, tree().linkOut)).toBe('outside');
      // …and so is anything reached through it, present or not.
      expect(isUnderRoot(tree().root, safePath.join(tree().linkOut, 'secret.txt'))).toBe('outside');
      expect(isUnderRoot(tree().root, safePath.join(tree().linkOut, 'not-there'))).toBe('outside');
    });

    it('inside the root that points inside is inside', ({ skip }) => {
      if (tree().linkIn === null) skip('host cannot create symlinks');
      expect(isUnderRoot(tree().root, tree().linkIn)).toBe('inside');
    });

    it('is judged against the root\'s OWN realpath, so a root reached through a link still contains its members', ({ skip }) => {
      if (tree().rootAlias === null) skip('host cannot create symlinks');
      // The alias is a link OUTSIDE the tree pointing at the root; a member
      // spelled through the alias and one spelled directly are the same file.
      expect(isUnderRoot(tree().rootAlias, tree().member)).toBe('inside');
      expect(isUnderRoot(tree().root, safePath.join(tree().rootAlias, 'member'))).toBe('inside');
    });

    it('that dangles is inside by its own entry — a delete removes the link, not a target', ({ skip }) => {
      if (tree().dangling === null) skip('host cannot create symlinks');
      expect(isUnderRoot(tree().root, tree().dangling)).toBe('inside');
    });
  });

  describe('a path that does not exist', () => {
    it('is absent when creating it would land inside the root', () => {
      expect(isUnderRoot(tree().root, safePath.join(tree().root, 'new-skill'))).toBe('absent');
      expect(isUnderRoot(tree().root, safePath.join(tree().root, 'nested', 'a', 'b', 'c'))).toBe('absent');
    });

    it('is outside, not absent, when creating it would land outside — absence is never a licence', () => {
      expect(isUnderRoot(tree().root, safePath.join(tree().root, '..', 'new-victim'))).toBe('outside');
      expect(isUnderRoot(tree().root, safePath.join(tree().outside, 'not-there'))).toBe('outside');
    });

    it('is absent, not outside, when the ROOT is what does not exist yet and the candidate sits under it', () => {
      const futureRoot = safePath.join(tree().root, 'future');
      expect(isUnderRoot(futureRoot, safePath.join(futureRoot, 'child'))).toBe('absent');
    });
  });

  describe('the hostile name table', () => {
    it.each(HOSTILE_NAMES)('%j joined under the root is never inside', (name) => {
      // A name that cannot be a single segment either escapes, lands on the
      // root itself, or is refused by the OS before it becomes a path; none of
      // those is "inside". The NUL byte is the OS refusal: lstat throws
      // ERR_INVALID_ARG_VALUE, which is not an absence and stays loud.
      if (name.includes('\0')) {
        expect(() => isUnderRoot(tree().root, safePath.join(tree().root, name))).toThrow();
        return;
      }
      expect(isUnderRoot(tree().root, safePath.join(tree().root, name))).not.toBe('inside');
    });
  });

  it('refuses to answer for a path the OS refuses to examine, rather than reading it as absent', ({ skip }) => {
    if (tree().unreadable === null) skip('host cannot deny reads');
    // The unreadable directory itself has a realpath (its parent can be read);
    // a child of it cannot be examined at all.
    expect(() => isUnderRoot(tree().root, safePath.join(tree().unreadable, 'child'))).toThrow(/EACCES/);
  });
});
