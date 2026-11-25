/**
 * Arm trees for lab tests: the arm's own git, a tree shaped as the lab's
 * prepared clone (`<arms root>/clone` under a marked arms root, the only tree
 * an edit arm may edit), and a developer's global git config for the test
 * process, which an arm's git must never read.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { vi } from 'vitest';

import { armDirectoriesAt, openArmsRoot, PREPARED_CLONE_NAME } from '../src/harness/arm-dirs.js';
import { type PreparationGit, preparationGit } from '../src/harness/arm-git.js';

/**
 * @param scratch - A directory the test owns; the arm's home is laid out under it (git needs none to exist)
 * @returns Git under that arm's environment, as an arm runs it
 */
export function fixtureArmGit(scratch: string): PreparationGit {
  return preparationGit(armDirectoriesAt(safePath.join(scratch, 'arm-git')), undefined);
}

/**
 * Mark `armsRoot` as the lab's and make its prepared-clone directory, empty.
 *
 * @param armsRoot - A fresh or empty absolute directory
 * @returns The clone directory, `<armsRoot>/clone`
 */
export function preparedCloneDirectory(armsRoot: string): string {
  openArmsRoot({ override: armsRoot, subjects: [] });
  return mkdirSyncReal(safePath.join(armsRoot, PREPARED_CLONE_NAME));
}

/**
 * Give the test process a developer's global git config: written to a fresh
 * HOME's `.gitconfig`, which HOME and `GIT_CONFIG_GLOBAL` both name, so the
 * lab's `runGit` (which inherits the process environment) reads it and an arm's
 * git does not. The caller restores the environment (`vi.unstubAllEnvs`).
 *
 * @param home - A fresh directory the test owns
 * @param config - The `.gitconfig` text
 */
export function stubDeveloperGitConfig(home: string, config: string): void {
  const file = safePath.join(home, '.gitconfig');
  writeFileSync(file, config);
  vi.stubEnv('HOME', home);
  vi.stubEnv('GIT_CONFIG_GLOBAL', file);
  vi.stubEnv('XDG_CONFIG_HOME', safePath.join(home, '.config'));
}
