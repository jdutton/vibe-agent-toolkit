/**
 * **Git content has one definition, and the git crawl is built on it.**
 *
 * `gitContentMembers` is the membership the git crawl derives from the run's
 * snapshot: entries under the root, admitted by `NEVER_CONTENT_GLOBS`, minus
 * skip-worktree entries absent from disk, with gitlinks set aside as
 * submodules. The crawl calls it and keeps its own extent rules on the result,
 * so the parity below holds by construction today; it is asserted so that a
 * second membership rule cannot creep into either consumer later. Each listed
 * file is also checked against the disk, because two consumers of one wrong
 * function would still agree with each other.
 *
 * The refusal side: one predicate (under the root, admitted by
 * `NEVER_CONTENT_GLOBS`) decides both membership and whether an unlistable
 * directory refuses the run, so a locked directory that can hold a member,
 * `coverage/` included, refuses instead of running short.
 * `GitCrawlSource.assertListable` runs the same ignored-side listing for its
 * stderr alone, for a warm run that never enumerates.
 *
 * Real repositories and, for the refusals, a real `chmod 000` (git's own walk
 * is the witness), so those suites are POSIX-only and not as root.
 */
import { chmodSync, lstatSync, rmSync, writeFileSync } from 'node:fs';

import {
  createSymlink,
  FS_FAULT_CODE,
  mkdirSyncReal,
  readWorkCounters,
  safePath,
  symlinkCapability,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { DirectoryListingRefusedError } from '@vibe-agent-toolkit/utils/crawl';
import {
  gitSnapshotAbsentEntries,
  gitTreeSnapshot,
  runGitOrThrow,
} from '@vibe-agent-toolkit/utils/git';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { GitCrawlSource, gitContentMembers, type GitContentMembers } from '../../src/projection/crawl-source.js';
import { createCommittedRepo, writeFileIn } from '../test-helpers.js';

const COMMIT = ['-c', 'user.name=VAT Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm'];

const roots: string[] = [];
const locked: string[] = [];

afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A committed repository, removed after the test. */
function repo(prefix: string, files: Record<string, string>, gitignore: string): string {
  const root = createCommittedRepo(prefix, { files, gitignore });
  roots.push(root);
  return root;
}

/** `gitContentMembers` over the run's snapshot of `root`, as a consumer would call it. */
function membersOf(root: string): GitContentMembers {
  const snapshot = gitTreeSnapshot({ cwd: root });
  if (!snapshot.ok) throw new Error('no snapshot');
  const absent = gitSnapshotAbsentEntries({ cwd: root, snapshot });
  if ('ok' in absent) throw new Error('no absent-entry listing');
  return gitContentMembers(snapshot, absent, root);
}

function relativeSorted(base: string, paths: readonly string[]): string[] {
  return paths.map((absolutePath) => toForwardSlash(safePath.relative(base, absolutePath))).sort((a, b) => a.localeCompare(b));
}

function under(absolutePath: string, directories: readonly string[]): boolean {
  return directories.some((directory) => toForwardSlash(absolutePath).startsWith(`${toForwardSlash(directory)}/`));
}

/**
 * The parity, both halves and the disk: the crawl's snapshot-derived file members (the
 * members carrying `shape: 'file'`, which only the snapshot supplies) plus its recorded
 * symlinks, outside submodules, equal `gitContentMembers`' files plus symlinks.
 */
async function expectParity(root: string, base: string = root): Promise<GitContentMembers> {
  const members = membersOf(root);
  const source = new GitCrawlSource(root, []);
  const enumerated = await source.enumerate();
  const crawlFiles = enumerated
    .filter((entry) => entry.shape === 'file' && !under(entry.absolutePath, members.submodules))
    .map((entry) => entry.absolutePath);
  const crawlLinks = source.symlinks.filter((link) => !under(link, members.submodules));

  expect(relativeSorted(base, members.files)).toEqual(relativeSorted(base, crawlFiles));
  expect(relativeSorted(base, members.symlinks)).toEqual(relativeSorted(base, crawlLinks));
  expect(relativeSorted(base, [...members.files, ...members.symlinks])).toEqual(relativeSorted(base, [...crawlFiles, ...crawlLinks]));
  // Ground truth no shared function can fake: every member is on disk.
  for (const absolutePath of [...members.files, ...members.symlinks]) {
    expect(() => lstatSync(absolutePath), absolutePath).not.toThrow();
  }
  return members;
}

describe('gitContentMembers: one membership, the crawl built on it', () => {
  it('matches the crawl over tracked, untracked, ignored, never-content, coverage and submodule entries', async () => {
    const root = repo('vat-git-content-', {
      'src/a.ts': 'export const a = 1;\n',
      'packages/a/coverage/kept.test.ts': 'it("kept", () => {});\n',
      'deleted.ts': 'export {};\n',
    }, 'ignored/\n*.log\n');
    writeFileIn(root, 'untracked.ts', 'export {};\n');
    writeFileIn(root, 'fresh/new.ts', 'export {};\n');
    writeFileIn(root, 'ignored/x.ts', 'export {};\n');
    writeFileIn(root, 'debug.log', 'log\n');
    writeFileIn(root, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
    rmSync(safePath.join(root, 'deleted.ts'));

    // An embedded repository: `git add` records it as a gitlink, as a submodule would be.
    const embedded = safePath.join(root, 'embedded');
    mkdirSyncReal(embedded, { recursive: true });
    runGitOrThrow(['init', '-q', '-b', 'main'], { cwd: embedded });
    writeFileSync(safePath.join(embedded, 'inner.ts'), 'export {};\n', 'utf-8');
    runGitOrThrow(['add', '-A'], { cwd: embedded });
    runGitOrThrow([...COMMIT, 'inner'], { cwd: embedded });

    const cap = symlinkCapability();
    if (cap) createSymlink(cap, 'src/a.ts', safePath.join(root, 'link.ts'));
    runGitOrThrow(['add', '-A'], { cwd: root });
    runGitOrThrow([...COMMIT, 'more'], { cwd: root });

    const members = await expectParity(root);
    const files = relativeSorted(root, members.files);
    expect(files).toEqual(['.gitignore', 'fresh/new.ts', 'packages/a/coverage/kept.test.ts', 'src/a.ts', 'untracked.ts']);
    expect(relativeSorted(root, members.submodules)).toEqual(['embedded']);
    expect(relativeSorted(root, members.symlinks)).toEqual(cap ? ['link.ts'] : []);
  });

  it('narrows a repository-wide snapshot to a subdirectory root', async () => {
    const top = repo('vat-git-content-sub-', { 'outside.ts': 'export {};\n', 'pkg/inside.ts': 'export {};\n' }, '');
    const root = safePath.join(top, 'pkg');
    const members = await expectParity(root, top);
    expect(relativeSorted(top, members.files)).toEqual(['pkg/inside.ts']);
  });

  it('drops a sparse checkout\'s skip-worktree file absent from disk', async () => {
    const root = repo('vat-git-content-sparse-', { 'kept.ts': 'export {};\n', 'out/left.ts': 'export {};\n' }, '');
    runGitOrThrow(['sparse-checkout', 'set', '--no-cone', '/*', '!/out/'], { cwd: root });
    expect(runGitOrThrow(['ls-files', '-v', '--', 'out/left.ts'], { cwd: root }), 'skip-worktree').toMatch(/^S /);

    const members = await expectParity(root);
    const files = relativeSorted(root, members.files);
    expect(files).toContain('kept.ts');
    expect(files).not.toContain('out/left.ts');
  });
});

describe.skipIf(CANNOT_DENY_READS)('one predicate decides membership and refusal', () => {
  /** A repository whose unignored `packages/a/coverage/` holds an untracked test, locked. */
  function lockedCoverage(): { root: string; directory: string } {
    const root = repo('vat-git-content-locked-', { 'packages/a/src/x.ts': 'export {};\n' }, 'dist/\n');
    writeFileIn(root, 'packages/a/coverage/x.test.ts', 'it("x", () => {});\n');
    const directory = safePath.join(root, 'packages/a/coverage');
    chmodSync(directory, 0o000);
    locked.push(directory);
    return { root, directory };
  }

  function expectCoverageRefusal(thrown: unknown, directory: string): void {
    expect(thrown).toBeInstanceOf(DirectoryListingRefusedError);
    expect(thrown).toMatchObject({ code: FS_FAULT_CODE });
    expect((thrown as DirectoryListingRefusedError).refusal.directory).toBe(directory);
    expect((thrown as Error).message).toContain("'packages/a/coverage'");
  }

  it('the cold crawl refuses an unreadable, unignored coverage/ directory by name', async () => {
    const { root, directory } = lockedCoverage();
    const thrown = await new GitCrawlSource(root, []).enumerate().then(() => undefined, (error: unknown) => error);
    expectCoverageRefusal(thrown, directory);
  });

  it('assertListable refuses the same directory with the cold crawl\'s code, and counts one listing', () => {
    const { root, directory } = lockedCoverage();
    const source = new GitCrawlSource(root, []);
    const before = readWorkCounters()['git.listings'];
    let thrown: unknown;
    try {
      source.assertListable();
    } catch (error) {
      thrown = error;
    }
    expectCoverageRefusal(thrown, directory);
    expect(readWorkCounters()['git.listings'] - before).toBe(1);
  });

  it('assertListable passes on a clean tree, and counts one listing', () => {
    const root = repo('vat-git-content-clean-', { 'packages/a/src/x.ts': 'export {};\n' }, 'dist/\n');
    writeFileIn(root, 'packages/a/coverage/x.test.ts', 'it("x", () => {});\n');
    const source = new GitCrawlSource(root, []);
    const before = readWorkCounters()['git.listings'];
    expect(() => source.assertListable()).not.toThrow();
    expect(readWorkCounters()['git.listings'] - before).toBe(1);
  });
});
