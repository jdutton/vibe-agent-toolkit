/**
 * Git helpers the git integration tests share: a git call that fails the test on a refusal, and
 * a tree key that fails it on a decline.
 */

import { expect } from 'vitest';

import { gitSnapshotFailureOf } from '../../src/git-no-answer.js';
import { runGit } from '../../src/git-run.js';
import { type GitTreeKey } from '../../src/git-snapshot.js';
import { gitTreeKey } from '../../src/git-tree-key.js';

/**
 * Run git in `cwd` with a throwaway identity, failing the test on a refusal.
 *
 * @param cwd - Where git runs
 * @param args - Its arguments
 * @returns Its stdout
 */
export function git(cwd: string, ...args: string[]): string {
  const result = runGit(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
  expect(result.ok, `git ${args.join(' ')}: ${result.stderr}`).toBe(true);
  return result.stdout;
}

/**
 * The tree key at `cwd`, or a failed test naming why it declined.
 *
 * @param cwd - The repository
 * @returns The key
 */
export function keyed(cwd: string): GitTreeKey {
  const key = gitTreeKey({ cwd });
  if (!key.ok) throw new Error(`declined: ${gitSnapshotFailureOf(key).reason}`);
  return key;
}
