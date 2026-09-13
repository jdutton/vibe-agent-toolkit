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
 * the two arms AGREE — and, since the registry's incumbent walk
 * (`VAT_RESOURCES_CRAWL=walk`) is a third lane over the same tree that used to
 * answer with a WARNING at exit 1, that it agrees with them too, sentence for
 * sentence. The remedy in that sentence is decided per root: an ignore rule
 * inside a repository, and — pinned in the last suite — no such rule outside
 * one, where "gitignore it" would be a dead knob.
 *
 * A real repository and a real `chmod 000`, because the git arm's refusal comes
 * from git's own walk, which no `readdir` spy reaches; so POSIX-only, and not as
 * root — the same rule `audit-unreadable-path.integration.test.ts` applies.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';

import {
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { DirectoryListingRefusedError, type DirectoryRefusal } from '@vibe-agent-toolkit/utils/crawl';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { withReaddirSyncRefused , CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
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
import { ResourceRegistry } from '../src/resource-registry.js';

import { createCommittedRepo, writeFileIn } from './test-helpers.js';

/** `chmod 000` denies nothing to uid 0 and binds nothing on Windows. */

const OPEN_FILE = 'docs/open/ok.md';
const LOCKED_DIR = 'docs/locked';
const LOCKED_FILE = `${LOCKED_DIR}/t.md`;
const IGNORED_LOCKED_DIR = 'build/locked';
const IGNORED_LOCKED_FILE = `${IGNORED_LOCKED_DIR}/b.md`;

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

/** What the registry's incumbent walk (`VAT_RESOURCES_CRAWL=walk`) threw over `crawlRoot`, or `undefined`. */
async function thrownByWalk(crawlRoot: string): Promise<unknown> {
  try {
    await new ResourceRegistry({ baseDir: crawlRoot }).crawl({ unreadable: 'refuse', baseDir: crawlRoot, include: ['**/*.md'] });
    return undefined;
  } catch (error) {
    return error;
  }
}

/** What the filesystem arm and the walk lane each threw for `docs/locked` refusing to list under `crawlRoot`. */
async function refusalsOn(crawlRoot: string): Promise<{ projection: unknown; walk: unknown }> {
  return withReaddirSyncRefused(safePath.join(crawlRoot, LOCKED_DIR), 'EACCES', async () => ({
    projection: await thrownBy(new FilesystemCrawlSource(crawlRoot)),
    walk: await thrownByWalk(crawlRoot),
  }));
}

describe.skipIf(CANNOT_DENY_READS)('crawl sources: a refused listing gets one verdict on both arms', () => {
  beforeEach(() => {
    root = createCommittedRepo('vat-crawl-refused-', { files: { [OPEN_FILE]: '# ok\n' }, gitignore: 'build/\n' });
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
      // The projection reads no include/exclude, so it must not prescribe one —
      // and, because an adopter who HAS excluded the directory is the one
      // reading this, it must say why that changed nothing.
      expect(message).not.toMatch(/add it to resources\.exclude/);
      expect(message).toMatch(/regardless of resources\.include or resources\.exclude/);
      expect(message).toMatch(/gitignore it/);
      // Nor may it claim the directory is in a "declared scan" — nothing
      // declared it; the population is the whole non-ignored tree.
      expect(message).not.toMatch(/declared scan/);
      expect((thrown as DirectoryListingRefusedError).refusal.directory).toBe(safePath.join(root, LOCKED_DIR));
    });

    it('the two arms throw the SAME sentence for the same directory', async () => {
      lock(LOCKED_DIR);
      const [fromFilesystem, fromGit] = await Promise.all(
        ARMS.map(async ([, sourceFor]) => (await thrownBy(sourceFor(root)) as Error).message),
      );
      expect(fromGit).toBe(fromFilesystem);
    });

    /**
     * The registry's incumbent walk (`VAT_RESOURCES_CRAWL=walk`) is the third
     * lane over the same tree, and it used to answer with a WARNING and exit 1
     * where both projection arms exit 2. Standing ruling: one class, one
     * sentence, on every lane.
     */
    it('the registry walk lane throws the SAME class and sentence as the projection arms', async () => {
      lock(LOCKED_DIR);
      const fromWalk = await thrownByWalk(root);
      const fromGit = await thrownBy(new GitCrawlSource(root));

      expect(fromWalk).toBeInstanceOf(DirectoryListingRefusedError);
      expect((fromWalk as Error).message).toBe((fromGit as Error).message);
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

/**
 * Outside a repository there is no ignore rule, so "gitignore it" is a remedy
 * the adopter can apply and see nothing change — the exact failure the remedy
 * text was written to avoid. `vat build` on a `.git`-less tree said exactly
 * that. The remedy is decided per root, and the walk that meets the refusal
 * is a Node `readdir`, so the refusal itself needs no `chmod`: this runs on
 * every platform.
 */
describe('a refused listing under a root with NO repository', () => {
  let plainRoot: string;

  beforeEach(() => {
    plainRoot = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-crawl-refused-norepo-')));
    writeFileIn(plainRoot, OPEN_FILE, '# ok\n');
    writeFileIn(plainRoot, LOCKED_FILE, '# t\n');
  });

  afterEach(() => {
    rmSync(plainRoot, { recursive: true, force: true });
  });

  it('names the missing repository as the reason no ignore rule can help, and does not say "gitignore it"', async () => {
    const { projection } = await refusalsOn(plainRoot);

    expect(projection).toBeInstanceOf(DirectoryListingRefusedError);
    const message = (projection as Error).message;
    expect(message).toContain(`'${LOCKED_DIR}'`);
    expect(message).toMatch(/no git repository/i);
    expect(message).not.toMatch(/gitignore it/);
    expect(message).toMatch(/regardless of resources\.include or resources\.exclude/);
  });

  it('the registry walk lane throws the SAME class and sentence here too', async () => {
    const { projection, walk } = await refusalsOn(plainRoot);
    expect(walk).toBeInstanceOf(DirectoryListingRefusedError);
    expect((walk as Error).message).toBe((projection as Error).message);
  });
});
