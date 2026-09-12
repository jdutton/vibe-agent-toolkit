/**
 * Both crawl sources, one locked tree, ONE verdict per directory.
 *
 * `docs/architecture/resource-scanning-and-caching.md` §3.3 says the two
 * enumerators are cost models, not behaviours: they must answer the same
 * question over the same root. A directory the OS refuses to list is the case
 * where they used to answer opposite things —
 *
 * - a locked UNTRACKED directory inside the population: the walk arm refused
 *   the run at exit 2, the git arm reported `success` over a shorter list
 *   (git prints the refusal to stderr, exits 0, and nobody read it);
 * - a locked GITIGNORED directory outside the population: the git arm's
 *   bounded walk of ignored territory aborted the run — with a sentence
 *   claiming the directory was "in the declared scan" and prescribing
 *   `resources.exclude`, which the projection never reads.
 *
 * Now the decision is the same on both arms: refuse by name for a directory
 * git's population reaches (its files would be absent from every count), and
 * for a gitignored one record it and carry on (nothing beneath it was ever in
 * the population). The test that could not exist before is the one asserting
 * the two arms AGREE.
 *
 * A real repository and a real `chmod 000`, because the git arm's refusal comes
 * from git's own walk, which no `readdir` spy reaches; so POSIX-only, and not as
 * root — the same rule `audit-unreadable-path.integration.test.ts` applies.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { DirectoryListingRefusedError, type DirectoryRefusal } from '@vibe-agent-toolkit/utils/crawl';
import { GitTracker, runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExtentContribution } from '../src/projection/contributor.js';
import {
  EXTENT_DIRECTORY_UNLISTABLE,
  FilesystemExtentContributor,
} from '../src/projection/contributors/filesystem-extent.js';
import {
  type CrawlSource,
  FilesystemCrawlSource,
  GitCrawlSource,
} from '../src/projection/crawl-source.js';
import { ProjectionBuilder } from '../src/projection/projection.js';

import { createGitRepo, writeFileIn } from './test-helpers.js';

/** `chmod 000` denies nothing to uid 0 and binds nothing on Windows. */
const CANNOT_DENY_READS =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

const OPEN_FILE = 'docs/open/ok.md';
const LOCKED_DIR = 'docs/locked';
const LOCKED_FILE = `${LOCKED_DIR}/t.md`;
const IGNORED_LOCKED_DIR = 'build/locked';
const IGNORED_LOCKED_FILE = `${IGNORED_LOCKED_DIR}/b.md`;
const EXCLUDE_KNOB = 'resources.exclude';

const ARMS: readonly (readonly [string, (root: string) => CrawlSource])[] = [
  ['filesystem', (root) => new FilesystemCrawlSource(root)],
  ['git', (root) => new GitCrawlSource(root)],
];

let root: string;
const locked: string[] = [];

function lock(relative: string): string {
  const absolute = safePath.join(root, relative);
  chmodSync(absolute, 0o000);
  locked.push(absolute);
  return absolute;
}

/** Root-relative paths an arm enumerated, sorted. */
async function enumerated(source: CrawlSource): Promise<string[]> {
  const paths = await source.enumerate();
  return paths
    .map((entry) => toForwardSlash(safePath.relative(root, entry.absolutePath)))
    .sort((a, b) => a.localeCompare(b));
}

/** The filesystem extent over `root`, enumerated by one arm, with a real git oracle. */
async function contribute(sourceFor: (root: string) => CrawlSource): Promise<ExtentContribution> {
  const tracker = new GitTracker(root);
  await tracker.initialize();
  const base = new ProjectionBuilder({ root, gitTracker: tracker }).base();
  return new FilesystemExtentContributor(sourceFor).contribute(base, null);
}

/** What an arm threw, or `undefined` when it completed. */
async function thrownBy(source: CrawlSource): Promise<unknown> {
  try {
    await source.enumerate();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe.skipIf(CANNOT_DENY_READS)('crawl sources: a refused listing gets one verdict on both arms', () => {
  beforeEach(() => {
    root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-crawl-refused-')));
    createGitRepo(root);
    runGitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    runGitOrThrow(['config', 'user.name', 'Test'], { cwd: root });
    writeFileIn(root, OPEN_FILE, '# ok\n');
    writeFileIn(root, '.gitignore', 'build/\n');
    runGitOrThrow(['add', '-A'], { cwd: root });
    runGitOrThrow(['commit', '-qm', 'init'], { cwd: root });
    // After the commit: untracked and ignored respectively, never staged.
    writeFileIn(root, LOCKED_FILE, '# t\n');
    writeFileIn(root, IGNORED_LOCKED_FILE, '# b\n');
    mkdirSyncReal(safePath.join(root, LOCKED_DIR), { recursive: true });
  });

  afterEach(() => {
    for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  it.each(ARMS)('%s arm enumerates the whole tree when nothing is locked (positive control)', async (_label, sourceFor) => {
    const paths = await enumerated(sourceFor(root));
    expect(paths).toContain(LOCKED_FILE);
    expect(paths).toContain(IGNORED_LOCKED_FILE);
    expect(paths).toContain(OPEN_FILE);
  });

  describe('a locked directory INSIDE the population (untracked, not ignored)', () => {
    it.each(ARMS)('%s arm refuses the run by name, root-relative, without naming a knob this lane does not read', async (_label, sourceFor) => {
      lock(LOCKED_DIR);
      const thrown = await thrownBy(sourceFor(root));

      expect(thrown).toBeInstanceOf(DirectoryListingRefusedError);
      const message = (thrown as Error).message;
      expect(message).toContain(`'${LOCKED_DIR}'`);
      expect(message).toContain('EACCES');
      expect(message).not.toContain(root);
      // The projection reads no include/exclude, so it must not prescribe one.
      expect(message).not.toContain(EXCLUDE_KNOB);
      expect((thrown as DirectoryListingRefusedError).refusal.directory).toBe(safePath.join(root, LOCKED_DIR));
    });

    it('the two arms throw the SAME sentence for the same directory', async () => {
      lock(LOCKED_DIR);
      const [fromFilesystem, fromGit] = await Promise.all(
        ARMS.map(async ([, sourceFor]) => (await thrownBy(sourceFor(root)) as Error).message),
      );
      expect(fromGit).toBe(fromFilesystem);
    });
  });

  describe('a locked directory OUTSIDE the population (gitignored)', () => {
    it.each(ARMS)('%s arm completes, keeps the directory as a member, and records the refusal', async (_label, sourceFor) => {
      const lockedAbsolute = lock(IGNORED_LOCKED_DIR);
      const source = sourceFor(root);

      const paths = await enumerated(source);

      // Not a run abort: everything the arm could see is still there …
      expect(paths).toContain(OPEN_FILE);
      expect(paths).toContain(LOCKED_FILE);
      // … the directory itself is a member (its row will say gitignored) …
      expect(paths).toContain(IGNORED_LOCKED_DIR);
      expect(paths).not.toContain(IGNORED_LOCKED_FILE);
      // … and the gap is on the record, as the same shape the walk produces.
      const expected: DirectoryRefusal = {
        kind: 'directory_unreadable',
        code: 'EACCES',
        directory: toForwardSlash(lockedAbsolute),
        transient: false,
      };
      expect(source.unlistable).toEqual([expected]);
    });

    it('the two arms enumerate the SAME set', async () => {
      lock(IGNORED_LOCKED_DIR);
      const [fromFilesystem, fromGit] = await Promise.all(ARMS.map(async ([, sourceFor]) => enumerated(sourceFor(root))));
      expect(fromGit).toEqual(fromFilesystem);
    });
  });

  it.each(ARMS)('%s arm records nothing when nothing is locked (the record is not a constant)', async (_label, sourceFor) => {
    const source = sourceFor(root);
    await source.enumerate();
    expect(source.unlistable).toEqual([]);
  });

  /**
   * The record has to leave the source: the filesystem extent carries each
   * refusal as a `realization_conditions` row — the projection's channel for a
   * population-time fact — so a query can see it and `validate` can surface it.
   */
  describe('the filesystem extent carries the refusal as a realization_conditions row', () => {
    it.each(ARMS)('%s arm: one warning row naming the directory root-relative, with the errno', async (_label, sourceFor) => {
      lock(IGNORED_LOCKED_DIR);
      const contribution = await contribute(sourceFor);

      const rows = contribution.conditions.filter((row) => row.code === EXTENT_DIRECTORY_UNLISTABLE);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.path).toBe(IGNORED_LOCKED_DIR);
      expect(rows[0]?.severity).toBe('warning');
      expect(rows[0]?.message).toContain('EACCES');
      expect(rows[0]?.message).not.toContain(root);
      // The directory is still realized, and the row points at that identity.
      const realized = contribution.realizations.find((row) => row.path === IGNORED_LOCKED_DIR);
      expect(realized?.gitignored).toBe(true);
      expect(rows[0]?.resourceId).toBe(realized?.resourceId);
    });

    it.each(ARMS)('%s arm: no row when nothing is locked (control)', async (_label, sourceFor) => {
      const contribution = await contribute(sourceFor);
      expect(contribution.conditions.filter((row) => row.code === EXTENT_DIRECTORY_UNLISTABLE)).toEqual([]);
    });
  });
});
