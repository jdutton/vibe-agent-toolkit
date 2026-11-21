/**
 * `gitTreeKey` against a real repository: the snapshot's hash, unless git's index hides
 * working-tree bytes from the snapshot, in which case git cannot key the tree.
 *
 * The snapshot stages the working tree through a copy of the real index, so a file flagged
 * assume-unchanged or skip-worktree keeps its staged bytes in the hash whatever is on disk. A key
 * over such a tree describes bytes that may not exist, on the run that writes a store and on the run
 * that reads it, so the key declines. Detected from the index flags alone: no file is read, hashed
 * or stat'd for it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GIT_SNAPSHOT_INDEX_HIDES_CODE, gitSnapshotFailureOf } from '../../src/git-no-answer.js';
import { runGit } from '../../src/git-run.js';
import { gitTreeSnapshot, withGitSnapshotCache } from '../../src/git-snapshot.js';
import { gitTreeKey } from '../../src/git-tree-key.js';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '../../src/path-utils.js';
import { readWorkCounters } from '../../src/work-counters.js';

/** Run git in `cwd`, failing the test on a refusal. */
function git(cwd: string, ...args: string[]): void {
  const result = runGit(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
  expect(result.ok, `git ${args.join(' ')}: ${result.stderr}`).toBe(true);
}

/**
 * @param root - The directory to write under
 * @param files - Root-relative path to contents
 */
function plant(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const path = safePath.join(root, relative);
    mkdirSyncReal(safePath.join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
}

/** The declined key's cause, as the one classifier states it. */
function declined(cwd: string): { code: string; reason: string } {
  const key = gitTreeKey({ cwd });
  if (key.ok) throw new Error('the key was taken');
  return gitSnapshotFailureOf(key);
}

describe('gitTreeKey over a real repository', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-tree-key-'));
    git(dir, 'init', '-q');
    plant(dir, { 'docs/a.md': 'a', 'docs/b.md': 'b', 'other/c.md': 'c' });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is the snapshot\'s hash when the index hides nothing', () => {
    const key = gitTreeKey({ cwd: dir });
    const snapshot = gitTreeSnapshot({ cwd: dir });
    expect(key.ok && snapshot.ok && key.hash === snapshot.hash).toBe(true);
  });

  it('declines a tree with a file flagged assume-unchanged, naming the flag and the file', () => {
    git(dir, 'update-index', '--assume-unchanged', 'docs/a.md');
    const cause = declined(dir);
    expect(cause.code).toBe(GIT_SNAPSHOT_INDEX_HIDES_CODE);
    expect(cause.reason).toContain('assume-unchanged');
    expect(cause.reason).toContain('docs/a.md');
  });

  it('declines a tree with a file flagged skip-worktree, naming the flag and the file', () => {
    git(dir, 'update-index', '--skip-worktree', 'docs/b.md');
    const cause = declined(dir);
    expect(cause.code).toBe(GIT_SNAPSHOT_INDEX_HIDES_CODE);
    expect(cause.reason).toContain('skip-worktree');
    expect(cause.reason).toContain('docs/b.md');
  });

  it('declines a file carrying both flags, naming both', () => {
    git(dir, 'update-index', '--assume-unchanged', 'docs/a.md');
    git(dir, 'update-index', '--skip-worktree', 'docs/a.md');
    expect(declined(dir).reason).toContain('"docs/a.md" (assume-unchanged and skip-worktree)');
  });

  it('declines a sparse checkout too: its absent entries carry skip-worktree, and the flags alone decide (no file is stat\'d)', () => {
    // The trade-off, visible: a sparse checkout hides nothing on disk, but telling it apart from a
    // flagged file would take a stat of every flagged path. Such a tree loses the store.
    git(dir, 'sparse-checkout', 'set', '--no-cone', '/docs/');
    expect(declined(dir).reason).toContain('other/c.md');
  });

  it('declines a key asked from a subdirectory for a flag anywhere in the repository: the hash covers it all', () => {
    git(dir, 'update-index', '--assume-unchanged', 'other/c.md');
    expect(declined(safePath.join(dir, 'docs')).reason).toContain('other/c.md');
  });

  it('asks git for the flags once per snapshot inside a bracket', () => {
    // Outside any bracket, so the repository root is resolved (and memoized) before counting.
    gitTreeSnapshot({ cwd: dir });
    withGitSnapshotCache(() => {
      const before = readWorkCounters()['git.calls'];
      gitTreeKey({ cwd: dir });
      const first = readWorkCounters()['git.calls'] - before;
      gitTreeKey({ cwd: dir });
      expect(first, 'the snapshot and the one flag listing').toBe(2);
      expect(readWorkCounters()['git.calls'] - before).toBe(first);
    });
  });
});
