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

import { appendFileSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';

import { createSymlink, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { runGit } from '../../src/harness/git-state.js';
import { type CopyMode, executeClonePlan, planTreeClone, readCloneSource } from '../../src/harness/tree-clone.js';
import { commitAll, initRepo, writeFixtureFile } from '../git-fixtures.js';

const roots: string[] = [];

afterEach(() => {
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

/** Plan and execute a clone of `source` into a new directory. */
async function cloneOf(source: string, mode: CopyMode): Promise<string> {
  const destination = safePath.join(scratch(), 'clone');
  const listed = readCloneSource(source, 'fixture');
  if (!listed.ok) throw new Error(listed.refusal);
  const refusal = await executeClonePlan({ ok: true, steps: planTreeClone(listed.source, destination, mode) });
  expect(refusal).toBeNull();
  return destination;
}

describe.each(['copy', 'portable'] as const)("a '%s' clone of a dirty subject", (mode) => {
  it.skipIf(mode === 'copy' && process.platform === 'win32')(
    'refreshes without refusing, and leaves the real dirt (an edit, a skipped tracked file) visible',
    async () => {
      const clone = await cloneOf(dirtySourceRepository(), mode);

      expect(differing(clone)).toEqual(['a.txt', 'coverage/report.md']);
    },
  );
});

describe.skipIf(process.platform === 'win32')("a 'copy' clone of a repository", () => {
  it('is stat-clean: git diff-files --quiet exits 0', async () => {
    const clone = await cloneOf(sourceRepository(false), 'copy');

    expect(runGit(['diff-files', '--quiet'], clone).status).toBe(0);
  });
});

describe("a 'portable' clone of a repository", () => {
  it('is stat-clean, and its index and file bytes equal a fresh checkout of the same commit', async () => {
    const source = sourceRepository(false);
    const clone = await cloneOf(source, 'portable');
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
    const clone = await cloneOf(sourceRepository(true), 'portable');
    const link = safePath.join(clone, 'link-to-a');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('a.txt'); // verbatim, not rewritten to an absolute path into the source
    expect(runGit(['diff-files', '--quiet'], clone).status).toBe(0);
  });
});
