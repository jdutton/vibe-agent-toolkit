/**
 * `gitTreeKey` against a real repository: the snapshot's hash, unless git's index hides
 * working-tree bytes from the snapshot, in which case git cannot key the tree.
 *
 * The snapshot stages the working tree through a copy of the real index and clears, in that copy
 * only, assume-unchanged on every entry and skip-worktree on every entry present on disk, so an
 * edit to a flagged file is in the hash. One index hides bytes all the same: a SPARSE INDEX that
 * holds a directory as one collapsed entry, where a file edited inside it keeps its committed bytes
 * in the snapshot. The key declines that tree. A skip-worktree entry with nothing on disk (a sparse
 * checkout's) hides no bytes; it keys under a hash of its own.
 */

import { lstatSync, rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GIT_SNAPSHOT_INDEX_HIDES_CODE, gitSnapshotFailureOf } from '../../src/git-no-answer.js';
import { type GitTreeKey, gitTreeSnapshot, withGitSnapshotCache } from '../../src/git-snapshot.js';
import { gitTreeKey } from '../../src/git-tree-key.js';
import { safePath } from '../../src/path-utils.js';
import { plantFiles } from '../../src/testing/plant-files.js';
import { createTempDir, removeTempDir } from '../../src/testing/temp-dir.js';
import { readWorkCounters } from '../../src/work-counters.js';

import { git, keyed } from './git-test-kit.js';

/** The declined key's cause, as the one classifier states it. */
function declined(cwd: string): { code: string; reason: string } {
  const key = gitTreeKey({ cwd });
  if (key.ok) throw new Error('the key was taken');
  return gitSnapshotFailureOf(key);
}

/** The OID the key's snapshot holds for `relative`. */
function oidIn(key: GitTreeKey, relative: string): string | undefined {
  return key.entries.find((entry) => entry.gitPath === relative)?.oid;
}

describe('gitTreeKey over a real repository', () => {
  let dir: string;

  beforeEach(() => {
    dir = createTempDir('vat-tree-key-');
    git(dir, 'init', '-q');
    plantFiles(dir, { 'docs/a.md': 'a', 'docs/b.md': 'b', 'other/c.md': 'c' });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it('is the snapshot\'s hash when the index hides nothing', () => {
    const key = gitTreeKey({ cwd: dir });
    const snapshot = gitTreeSnapshot({ cwd: dir });
    expect(key.ok && snapshot.ok && key.hash === snapshot.hash).toBe(true);
  });

  it.for([
    ['assume-unchanged', ['--assume-unchanged']],
    ['skip-worktree', ['--skip-worktree']],
    ['assume-unchanged and skip-worktree', ['--assume-unchanged', '--skip-worktree']],
  ] as const)('keys a file flagged %s and edited on disk to the edited bytes\' OID', ([, flags]) => {
    // One `update-index` given both mark options applies only the last, so one call per flag.
    for (const flag of flags) git(dir, 'update-index', flag, 'docs/a.md');
    plantFiles(dir, { 'docs/a.md': 'edited under the flag\n' });
    const key = keyed(dir);
    expect(oidIn(key, 'docs/a.md')).toBe(git(dir, 'hash-object', 'docs/a.md'));
  });

  it('keys an absent assume-unchanged entry: the snapshot stages its deletion', () => {
    git(dir, 'update-index', '--assume-unchanged', 'other/c.md');
    rmSync(safePath.join(dir, 'other/c.md'));
    const key = keyed(dir);
    expect(oidIn(key, 'other/c.md')).toBeUndefined();
    expect(key.absent.size).toBe(0);
  });

  it('keys a sparse checkout: an entry skip-worktree hides is absent from disk, so it hides no bytes', () => {
    git(dir, 'sparse-checkout', 'set', '--no-cone', '/docs/');
    expect(keyed(dir).absent, 'other/c.md is absent and skip-worktree').toStrictEqual(new Set([safePath.join(dir, 'other/c.md')]));
  });

  it('keys a tree with an absent skip-worktree entry apart from the same tree with the file back', () => {
    // Both states write one tree: the index still holds other/c.md's bytes. The store filed while it
    // was absent must never serve the tree where it is back, so the absence is part of the key.
    git(dir, 'sparse-checkout', 'set', '--no-cone', '/docs/');
    const sparse = keyed(dir);
    git(dir, 'sparse-checkout', 'disable');
    const whole = keyed(dir);
    const snapshot = gitTreeSnapshot({ cwd: dir });
    if (!snapshot.ok) throw new Error('the snapshot was not taken');
    expect(whole.hash, 'nothing flagged: the snapshot\'s own hash').toBe(snapshot.hash);
    expect(sparse.hash).not.toBe(whole.hash);
  });

  it('keys an out-of-cone file edited on disk when files are expected outside the patterns and the index is whole', () => {
    git(dir, 'config', 'sparse.expectFilesOutsideOfPatterns', 'true');
    git(dir, 'sparse-checkout', 'set', '--cone', '--no-sparse-index', 'docs');
    plantFiles(dir, { 'other/c.md': 'edited out of the cone\n' });
    expect(git(dir, 'ls-files', '-v', '--', 'other/c.md')).toBe('S other/c.md');
    const key = keyed(dir);
    expect(oidIn(key, 'other/c.md')).toBe(git(dir, 'hash-object', 'other/c.md'));
  });

  it('keys an untracked file outside a sparse checkout\'s definition: the snapshot stages it', () => {
    git(dir, 'sparse-checkout', 'set', '--no-cone', '/docs/');
    plantFiles(dir, { 'stray.md': 'outside the sparse definition\n' });
    const key = keyed(dir);
    expect(oidIn(key, 'stray.md')).toBe(git(dir, 'hash-object', 'stray.md'));
  });

  it('keys an edit inside a collapsed directory when git clears the flag itself (files not expected outside the patterns)', () => {
    git(dir, 'sparse-checkout', 'set', '--cone', '--sparse-index', 'docs');
    plantFiles(dir, { 'other/c.md': 'edited in a collapsed directory\n' });
    const key = keyed(dir);
    expect(oidIn(key, 'other/c.md')).toBe(git(dir, 'hash-object', 'other/c.md'));
  });

  it('declines an edit inside a directory a sparse index holds collapsed, files expected outside the patterns', () => {
    git(dir, 'config', 'sparse.expectFilesOutsideOfPatterns', 'true');
    git(dir, 'sparse-checkout', 'set', '--cone', '--sparse-index', 'docs');
    plantFiles(dir, { 'other/c.md': 'edited in a collapsed directory\n' });
    expect(git(dir, 'ls-files', '--sparse', '-s', '--', 'other')).toMatch(/^040000 /);
    // Asked from a subdirectory too: the hash covers the whole repository.
    const [cause = { reason: '' }] = [dir, safePath.join(dir, 'docs')].map((cwd) => {
      const declinedFrom = declined(cwd);
      expect(declinedFrom.code).toBe(GIT_SNAPSHOT_INDEX_HIDES_CODE);
      expect(declinedFrom.reason).toContain('"other/c.md" (skip-worktree)');
      expect(declinedFrom.reason).toContain('sparse index');
      return declinedFrom;
    });
    // The remedy the reason names keys the tree, to the edited bytes, which it leaves on disk.
    expect(cause.reason).toContain('git config --unset sparse.expectFilesOutsideOfPatterns');
    git(dir, 'config', '--unset', 'sparse.expectFilesOutsideOfPatterns');
    expect(oidIn(keyed(dir), 'other/c.md')).toBe(git(dir, 'hash-object', 'other/c.md'));
  });

  it('declines two index paths the volume holds as one file, and keys them where it holds two', () => {
    // `A.md` beside `a.md`: added by object, so the index holds both whatever the volume does.
    const oid = git(dir, 'hash-object', '-w', 'docs/a.md');
    git(dir, 'update-index', '--add', '--cacheinfo', `100644,${oid},docs/A.md`);
    plantFiles(dir, { 'docs/A.md': 'a' });
    const folds = lstatSync(safePath.join(dir, 'docs/A.md')).ino === lstatSync(safePath.join(dir, 'docs/a.md')).ino;
    const key = gitTreeKey({ cwd: dir });
    if (folds) {
      if (key.ok) throw new Error('a volume that folds case keyed two paths it holds as one file');
      const cause = gitSnapshotFailureOf(key);
      expect(cause.code).toBe(GIT_SNAPSHOT_INDEX_HIDES_CODE);
      expect(cause.reason).toContain('"docs/A.md" and "docs/a.md"');
    } else {
      expect(key.ok, 'a case-sensitive volume holds two files').toBe(true);
    }
  });

  it('asks git for the flags once per snapshot inside a bracket', () => {
    // Outside any bracket, so the repository root is resolved (and memoized) before counting.
    gitTreeSnapshot({ cwd: dir });
    withGitSnapshotCache(() => {
      const before = readWorkCounters()['git.calls'];
      gitTreeKey({ cwd: dir });
      const first = readWorkCounters()['git.calls'] - before;
      gitTreeKey({ cwd: dir });
      expect(first, 'the snapshot, the one flag listing and the one attribute pass (no path is filter=lfs)').toBe(3);
      expect(readWorkCounters()['git.calls'] - before).toBe(first);
    });
  });
});
