/**
 * A cloned tree must be stat-clean: the clone's index records the SOURCE's
 * mtime, ctime and inode for every file, so after a copy each one reads as
 * possibly modified until `git update-index --refresh` re-stats it. A warm run
 * measured in a stat-dirty clone would time git re-hashing the tree, not the
 * product.
 *
 * `'copy'` spawns `cp`, so it runs on POSIX only. `'portable'` copies through
 * `copyTree` and runs on every host.
 *
 * Integration-tier: real files, real git.
 */

import { appendFileSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';

import { createSymlink, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TreeOrigin } from '../../src/harness/arm-git.js';
import { runGit } from '../../src/harness/git-state.js';
import { type CopyMode, executeClonePlan, planTreeClone, readCloneSource } from '../../src/harness/tree-clone.js';
import { fixtureArmGit, stubDeveloperGitConfig } from '../arm-tree-fixtures.js';
import { commitAll, initRepo, writeFixtureFile } from '../git-fixtures.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fresh directory under the temp root, removed after the test. */
function scratch(): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-tree-clone-refresh-'));
  roots.push(root);
  return root;
}

/** A committed repository of three files, plus a link to `a.txt` when asked (the caller holds the capability). */
function sourceRepository(withLink: boolean): string {
  const source = safePath.join(scratch(), 'source');
  writeFixtureFile(source, 'a.txt', 'alpha\n');
  writeFixtureFile(source, 'docs/b.md', '# bravo\n');
  writeFixtureFile(source, 'docs/c.md', '# charlie\n');
  const capability = withLink ? symlinkCapability() : null;
  if (capability !== null) createSymlink(capability, 'a.txt', safePath.join(source, 'link-to-a'), 'file');
  initRepo(source);
  commitAll(source, 'fixture');
  return source;
}

/**
 * A subject as an adopter's checkout really is: one tracked file edited since the
 * commit, and one tracked file under a directory the clone skips (`coverage/`).
 */
function dirtySourceRepository(): string {
  const source = safePath.join(scratch(), 'source');
  writeFixtureFile(source, 'a.txt', 'alpha\n');
  writeFixtureFile(source, 'docs/b.md', '# bravo\n');
  writeFixtureFile(source, 'coverage/report.md', '# authored under a skipped name\n');
  initRepo(source);
  commitAll(source, 'fixture');
  appendFileSync(safePath.join(source, 'a.txt'), 'edited\n');
  return source;
}

/** What `git diff-files` names in `clone`: the paths still differing from the index, sorted. */
function differing(clone: string): string[] {
  return runGit(['diff-files', '--name-only'], clone).stdout.split('\n').filter((line) => line !== '').sort((a, b) => a.localeCompare(b));
}

/**
 * Plan and execute a clone of `source` into a new directory.
 *
 * @param origin - Whose config `source` was checked out under: a fixture made by
 *   the test's own git is an `'operator'` checkout
 */
async function cloneOf(source: string, mode: CopyMode, origin: TreeOrigin): Promise<string> {
  const destination = safePath.join(scratch(), 'clone');
  const listed = readCloneSource(source, 'fixture');
  if (!listed.ok) throw new Error(listed.refusal);
  const refusal = await executeClonePlan(
    { ok: true, steps: planTreeClone(listed.source, destination, mode) },
    fixtureArmGit(scratch()),
    origin,
  );
  expect(refusal).toBeNull();
  return destination;
}

describe.each(['copy', 'portable'] as const)("a '%s' clone of a dirty subject", (mode) => {
  it.skipIf(mode === 'copy' && process.platform === 'win32')(
    'refreshes without refusing, and leaves the real dirt (an edit, a skipped tracked file) visible',
    async () => {
      const clone = await cloneOf(dirtySourceRepository(), mode, 'operator');

      expect(differing(clone)).toEqual(['a.txt', 'coverage/report.md']);
    },
  );
});

describe.skipIf(process.platform === 'win32')("a 'copy' clone of a repository", () => {
  it('is stat-clean: git diff-files --quiet exits 0', async () => {
    const clone = await cloneOf(sourceRepository(false), 'copy', 'operator');

    expect(runGit(['diff-files', '--quiet'], clone).status).toBe(0);
  });
});

describe("a 'portable' clone of a repository", () => {
  it('is stat-clean, and its index and file bytes equal a fresh checkout of the same commit', async () => {
    const source = sourceRepository(false);
    const clone = await cloneOf(source, 'portable', 'operator');
    const fresh = safePath.join(scratch(), 'fresh');
    expect(runGit(['clone', '--quiet', '--local', source, fresh], source).status).toBe(0);

    expect(runGit(['diff-files', '--quiet'], clone).status).toBe(0);
    const staged = runGit(['ls-files', '-s'], clone);
    expect(staged.stdout.split('\n').filter((line) => line !== '')).toHaveLength(3); // positive control: three files
    expect(staged.stdout).toBe(runGit(['ls-files', '-s'], fresh).stdout);
    for (const file of ['a.txt', 'docs/b.md', 'docs/c.md']) {
      expect(readFileSync(safePath.join(clone, file))).toEqual(readFileSync(safePath.join(fresh, file)));
    }
  });

  it('keeps a symlink a link, pointing where it pointed', async (context) => {
    if (symlinkCapability() === null) context.skip();
    const clone = await cloneOf(sourceRepository(true), 'portable', 'operator');
    const link = safePath.join(clone, 'link-to-a');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('a.txt'); // verbatim, not rewritten to an absolute path into the source
    expect(runGit(['diff-files', '--quiet'], clone).status).toBe(0);
  });
});

describe("a lab-made clone's index refresh runs under the arm's git", () => {
  it("refreshes past a developer's global attributes file whose required clean filter always fails", async () => {
    const source = sourceRepository(false);
    const home = scratch();
    const attributes = safePath.join(home, 'attributes');
    writeFileSync(attributes, '* filter=lab-broken\n');
    // Under the developer's config every stat-dirty file the refresh re-hashes runs this filter and fails.
    stubDeveloperGitConfig(
      home,
      `[core]\n\tattributesFile = ${attributes}\n[filter "lab-broken"]\n\tclean = false\n\trequired = true\n`,
    );

    await cloneOf(source, 'portable', 'lab-clone');
  });
});

/** A committed repository whose `.txt` files pass a clean filter defined only in the stubbed global config. */
function filteredOperatorCheckout(): string {
  stubDeveloperGitConfig(scratch(), '[filter "lab-upper"]\n\tclean = tr a-z A-Z\n\tsmudge = cat\n');
  const source = safePath.join(scratch(), 'source');
  writeFixtureFile(source, '.gitattributes', '*.txt filter=lab-upper\n');
  writeFixtureFile(source, 'a.txt', 'alpha\n');
  initRepo(source);
  commitAll(source, 'fixture');
  // The operator's own checkout is clean under the config it was made with.
  expect(runGit(['diff-files', '--quiet'], source).status).toBe(0);
  return source;
}

/**
 * An operator's checkout was made under the developer's config, as an LFS
 * checkout is: the repository's `.gitattributes` names a filter only the
 * developer's GLOBAL config defines. Re-hashed without that filter every such
 * file reads modified, and `update-index -q` hides it.
 */
describe("an operator subject's copy refreshes under the developer's config", () => {
  it("is stat-clean under the developer's config, whose global clean filter the arm's git does not carry", async () => {
    const copy = await cloneOf(filteredOperatorCheckout(), 'portable', 'operator');

    expect(runGit(['diff-files', '--quiet'], copy).status).toBe(0);
  });

  it("control: the same checkout refreshed as a lab clone reads its filtered file modified under the arm's git", async () => {
    const copy = await cloneOf(filteredOperatorCheckout(), 'portable', 'lab-clone');

    expect(fixtureArmGit(scratch())(['diff-files', '--name-only'], copy).stdout).toBe('a.txt');
  });
});
