/**
 * Arm trees for lab tests: the arm's own git, a tree shaped as the lab's
 * prepared clone (`<arms root>/clone` under a marked arms root, the only tree
 * an edit arm may edit), a developer's global git config for the test
 * process, which an arm's git must never read, and the trees whose copy
 * refreshes clean only under the git of the config they were checked out with.
 */

import { utimesSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { expect, vi } from 'vitest';

import { armDirectoriesAt, openArmsRoot, PREPARED_CLONE_NAME } from '../src/harness/arm-dirs.js';
import { type PreparationGit, preparationGit } from '../src/harness/arm-git.js';
import { runGit } from '../src/harness/git-state.js';

import { commitAll, git, initRepo, writeFixtureFile } from './git-fixtures.js';

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
 * Mark `armsRoot` as the lab's and `git clone --local` the subject into its
 * prepared-clone directory, as `prepareClone` (`clone.ts`) does: under the
 * arm's git, so the checkout writes each blob's bytes as the arms' git and VAT
 * will read them. Under the developer's git a system `core.autocrlf=true`
 * (Windows CI) checks out CRLF, and every text file reads modified to the arms.
 *
 * @param subject - A committed repository
 * @param armsRoot - A fresh or empty absolute directory
 * @param scratch - A directory the test owns, outside `armsRoot`, for the arm git's home
 * @returns The clone, `<armsRoot>/clone`
 */
export function cloneAsPrepared(subject: string, armsRoot: string, scratch: string): string {
  const clone = preparedCloneDirectory(armsRoot);
  const cloned = fixtureArmGit(scratch)(['clone', '--quiet', '--local', subject, clone], armsRoot);
  if (cloned.status !== 0) throw new Error(`git clone --local of '${subject}' exited ${String(cloned.status)}: ${cloned.stderr}`);
  return clone;
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

/**
 * Give the test process a developer's global attributes file that runs every
 * file through a required clean filter that always fails: any git under the
 * developer's config that re-hashes a stat-dirty file exits non-zero, and the
 * arm's git never sees it. Call it AFTER committing a fixture, whose `git add`
 * would otherwise fail too.
 *
 * @param home - A fresh directory the test owns
 */
export function stubBrokenDeveloperFilter(home: string): void {
  const attributes = safePath.join(home, 'attributes');
  writeFileSync(attributes, '* filter=lab-broken\n');
  stubDeveloperGitConfig(home, `[core]\n\tattributesFile = ${attributes}\n[filter "lab-broken"]\n\tclean = false\n\trequired = true\n`);
}

/**
 * Commit one file into `root`, its mtime a minute old so the commit's index
 * cannot hold it racily clean: a later `git status` there trusts the stat and
 * re-hashes nothing, under any config.
 *
 * @param root - An empty directory
 * @returns It, as a committed tree
 */
export function committedSettledTree(root: string): string {
  writeFixtureFile(root, 'a.txt', 'alpha\n');
  const settled = new Date(Date.now() - 60_000);
  utimesSync(safePath.join(root, 'a.txt'), settled, settled);
  initRepo(root);
  commitAll(root, 'fixture');
  return root;
}

/**
 * An operator's checkout, made under the developer's config as an LFS checkout
 * is: its `.gitattributes` passes `.txt` files through a clean filter only the
 * developer's GLOBAL config (stubbed here) defines. Re-hashed under the arm's
 * git, which lacks that filter, the file reads modified, and `update-index -q`
 * hides it.
 *
 * @param root - An empty directory for the checkout
 * @param home - A fresh directory for the developer's home
 * @param required - Whether the checkout's own config marks the filter required:
 *   then the arm's git, holding no command for it, refuses to re-hash the file at all
 * @returns The checkout, clean under the config it was made with
 */
export function filteredOperatorCheckout(root: string, home: string, required: boolean): string {
  stubDeveloperGitConfig(home, '[filter "lab-upper"]\n\tclean = tr a-z A-Z\n\tsmudge = cat\n');
  writeFixtureFile(root, '.gitattributes', '*.txt filter=lab-upper\n');
  writeFixtureFile(root, 'a.txt', 'alpha\n');
  initRepo(root);
  commitAll(root, 'fixture');
  if (required) git(['config', 'filter.lab-upper.required', 'true'], root);
  expect(runGit(['diff-files', '--quiet'], root).status).toBe(0);
  return root;
}
