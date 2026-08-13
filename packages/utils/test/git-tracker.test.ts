/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
/**
 * Tests for GitTracker - git-ignore checking with caching
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitTracker } from '../src/git-tracker.js';
import * as gitUtils from '../src/git-utils.js';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '../src/path-utils.js';

describe('GitTracker', () => {
  const projectRoot = '/project';
  const README_PATH = '/project/README.md';
  const INDEX_PATH = '/project/src/index.ts';
  const GUIDE_PATH = '/project/docs/guide.md';
  const ENV_PATH = '/project/.env';
  const NODE_MODULES_PATH = '/project/node_modules/foo.js';

  beforeEach(() => {
    // Mock git-utils functions
    vi.spyOn(gitUtils, 'gitLsFiles').mockReturnValue([
      'README.md',
      'src/index.ts',
      'docs/guide.md',
    ]);
    vi.spyOn(gitUtils, 'isGitIgnored').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create tracker with project root', () => {
      const tracker = new GitTracker(projectRoot);
      expect(tracker).toBeDefined();
      expect(tracker.getStats().cacheSize).toBe(0);
    });
  });

  describe('initialize()', () => {
    it('should pre-populate cache from git ls-files', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      // Cache should contain all tracked files (not ignored)
      expect(tracker.getStats().cacheSize).toBe(3);
      expect(tracker.isIgnored(README_PATH)).toBe(false);
      expect(tracker.isIgnored(INDEX_PATH)).toBe(false);
      expect(tracker.isIgnored(GUIDE_PATH)).toBe(false);

      // Should NOT call isGitIgnored for cached files
      expect(gitUtils.isGitIgnored).not.toHaveBeenCalled();
    });

    it('should be idempotent (safe to call multiple times)', async () => {
      const tracker = new GitTracker(projectRoot);

      await tracker.initialize();
      const statsAfterFirst = tracker.getStats();

      await tracker.initialize();
      const statsAfterSecond = tracker.getStats();

      // Cache size should remain the same
      expect(statsAfterFirst.cacheSize).toBe(statsAfterSecond.cacheSize);
      expect(gitUtils.gitLsFiles).toHaveBeenCalledTimes(1); // Only called once
    });

    it('should pre-populate with untracked non-ignored files by default', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      // Default path should call gitLsFiles with includeUntracked: true
      expect(gitUtils.gitLsFiles).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: projectRoot, includeUntracked: true }),
      );
    });

    it('should skip untracked files when includeUntracked: false', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize({ includeUntracked: false });

      // Opt-out path should not pass includeUntracked to gitLsFiles.
      expect(gitUtils.gitLsFiles).toHaveBeenCalledWith({ cwd: projectRoot });
    });

    it('should handle git ls-files returning null (not in git repo)', async () => {
      vi.mocked(gitUtils.gitLsFiles).mockReturnValue(null);

      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      // Cache should be empty
      expect(tracker.getStats().cacheSize).toBe(0);
    });
  });

  describe('isIgnored()', () => {
    it('should return false for tracked files (from cache)', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      // Tracked files should return false (not ignored)
      expect(tracker.isIgnored(README_PATH)).toBe(false);
      expect(tracker.isIgnored(INDEX_PATH)).toBe(false);

      // Should NOT call isGitIgnored (using cache)
      expect(gitUtils.isGitIgnored).not.toHaveBeenCalled();
    });

    it('should call git check-ignore and cache result for uncached files', async () => {
      vi.mocked(gitUtils.isGitIgnored).mockReturnValue(true);

      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      // Check a file not in cache
      const ignored = tracker.isIgnored(NODE_MODULES_PATH);

      // Should call isGitIgnored
      expect(gitUtils.isGitIgnored).toHaveBeenCalledWith(
        NODE_MODULES_PATH,
        projectRoot
      );
      expect(ignored).toBe(true);

      // Result should be cached
      expect(tracker.getStats().cacheSize).toBe(4); // 3 tracked + 1 checked
    });

    it('should use cached result on subsequent calls', async () => {
      vi.mocked(gitUtils.isGitIgnored).mockReturnValue(true);

      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      // First call - should check git
      const firstResult = tracker.isIgnored(ENV_PATH);
      expect(gitUtils.isGitIgnored).toHaveBeenCalledTimes(1);
      expect(firstResult).toBe(true);

      // Second call - should use cache
      const secondResult = tracker.isIgnored(ENV_PATH);
      expect(gitUtils.isGitIgnored).toHaveBeenCalledTimes(1); // Still 1
      expect(secondResult).toBe(true);
    });

    it('hits the cache for non-canonical absolute paths (regression: Windows path-resolve drift)', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      // Cache was populated with paths via safePath.resolve(projectRoot, relPath).
      // On Windows that drive-prefixes the key (e.g. C:/project/README.md) while
      // a caller may still pass '/project/README.md' or a path containing '..'.
      // isIgnored() must normalize the lookup key to match the population shape;
      // otherwise it silently falls through to `git check-ignore` per path —
      // exactly the perf regression rc.2 was meant to eliminate.
      const nonCanonical = '/project/src/../README.md';
      expect(tracker.isIgnored(nonCanonical)).toBe(false);

      // No spawn: cache hit via normalization.
      expect(gitUtils.isGitIgnored).not.toHaveBeenCalled();
    });

    it('should work without initialization (cache empty)', () => {
      vi.mocked(gitUtils.isGitIgnored).mockReturnValue(false);

      const tracker = new GitTracker(projectRoot);
      // Don't call initialize()

      const ignored = tracker.isIgnored(README_PATH);

      expect(gitUtils.isGitIgnored).toHaveBeenCalledWith(
        README_PATH,
        projectRoot
      );
      expect(ignored).toBe(false);
      expect(tracker.getStats().cacheSize).toBe(1); // Cached now
    });

    it('should correctly identify gitignored files', async () => {
      // Mock: tracked files return false, .env returns true
      vi.mocked(gitUtils.isGitIgnored).mockImplementation((filePath) =>
        filePath.includes('.env')
      );

      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.isIgnored(README_PATH)).toBe(false); // Tracked
      expect(tracker.isIgnored(ENV_PATH)).toBe(true); // Gitignored
      expect(tracker.isIgnored('/project/src/.env.local')).toBe(true); // Gitignored
    });
  });

  describe('getStats()', () => {
    it('should return cache size', async () => {
      const tracker = new GitTracker(projectRoot);

      // Before initialization
      expect(tracker.getStats().cacheSize).toBe(0);

      // After initialization
      await tracker.initialize();
      expect(tracker.getStats().cacheSize).toBe(3);

      // After checking additional file
      tracker.isIgnored(ENV_PATH);
      expect(tracker.getStats().cacheSize).toBe(4);
    });
  });

  describe('isUsable()', () => {
    // The distinction the tracker could not previously express. Both states leave
    // the active set empty, and `isIgnoredByActiveSet` answers `false` — "not
    // ignored" — for every path in both. A caller that INFERS from "not ignored"
    // therefore got a fixed answer from a silently disabled tracker.
    it('is true when git answered, even with an empty repository', async () => {
      vi.spyOn(gitUtils, 'gitLsFiles').mockReturnValue([]);
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.isUsable()).toBe(true);
      expect(tracker.getStats().activeSetSize).toBe(0);
    });

    it('is false when git could not be consulted', async () => {
      // `null` is what gitLsFiles returns for a missing binary, a corrupt `.git`,
      // an unreadable `.git`, and a non-repository cwd alike.
      vi.spyOn(gitUtils, 'gitLsFiles').mockReturnValue(null);
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.isUsable()).toBe(false);
      expect(tracker.getStats().activeSetSize).toBe(0);
    });

    it('is false before initialize() has run at all', () => {
      expect(new GitTracker(projectRoot).isUsable()).toBe(false);
    });

    it('reports false again after clear(), not a stale true', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();
      expect(tracker.isUsable()).toBe(true);

      tracker.clear();

      expect(tracker.isUsable()).toBe(false);
    });
  });

  describe('clear()', () => {
    it('should clear cache and reset initialized flag', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.getStats().cacheSize).toBe(3);

      tracker.clear();

      expect(tracker.getStats().cacheSize).toBe(0);

      // Should be able to initialize again
      await tracker.initialize();
      expect(tracker.getStats().cacheSize).toBe(3);
      expect(gitUtils.gitLsFiles).toHaveBeenCalledTimes(2); // Called again after clear
    });
  });

  describe('indexPathFor()', () => {
    const INDEX_CASED = 'docs/Getting-Started.MD';
    const ON_DISK_CASED = '/project/docs/getting-started.md';

    it('returns the casing git recorded, whatever casing the caller asks with', async () => {
      vi.spyOn(gitUtils, 'gitLsFiles').mockReturnValue([INDEX_CASED]);
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.indexPathFor(ON_DISK_CASED)).toBe(INDEX_CASED);
      expect(tracker.indexPathFor(`/project/${INDEX_CASED}`)).toBe(INDEX_CASED);
    });

    it('returns a root-relative path for a path git listed', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.indexPathFor(GUIDE_PATH)).toBe('docs/guide.md');
      expect(tracker.indexPathFor(README_PATH)).toBe('README.md');
    });

    it('returns null for a path git has no record of', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.indexPathFor(NODE_MODULES_PATH)).toBeNull();
    });

    it('returns null when git did not answer, rather than guessing a spelling', async () => {
      vi.spyOn(gitUtils, 'gitLsFiles').mockReturnValue(null);
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.isUsable()).toBe(false);
      expect(tracker.indexPathFor(README_PATH)).toBeNull();
    });

    it('forgets every spelling on clear()', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();
      expect(tracker.indexPathFor(README_PATH)).toBe('README.md');

      tracker.clear();

      expect(tracker.indexPathFor(README_PATH)).toBeNull();
    });
  });

  describe('hasActiveDescendant()', () => {
    it('should return true for active-set files', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.hasActiveDescendant(README_PATH)).toBe(true);
      expect(tracker.hasActiveDescendant(INDEX_PATH)).toBe(true);
      expect(tracker.hasActiveDescendant(GUIDE_PATH)).toBe(true);
    });

    it('should return true for directories containing active-set files (ancestors)', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      // /project/src contains src/index.ts; /project/docs contains docs/guide.md
      expect(tracker.hasActiveDescendant('/project/src')).toBe(true);
      expect(tracker.hasActiveDescendant('/project/docs')).toBe(true);
      // projectRoot itself is always an ancestor of everything under it
      expect(tracker.hasActiveDescendant(projectRoot)).toBe(true);
    });

    it('should return false for directories with no active descendants', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.hasActiveDescendant('/project/node_modules')).toBe(false);
      expect(tracker.hasActiveDescendant('/project/dist')).toBe(false);
    });

    it('should return true for any path when includeUntracked: false (fallback to legacy descent)', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize({ includeUntracked: false });

      // Without an authoritative active set we can't prune; let the walker descend.
      expect(tracker.hasActiveDescendant('/project/anything')).toBe(true);
    });
  });

  describe('isIgnoredByActiveSet()', () => {
    it('should return false for files in the active set', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.isIgnoredByActiveSet(README_PATH)).toBe(false);
      expect(tracker.isIgnoredByActiveSet(INDEX_PATH)).toBe(false);
      expect(tracker.isIgnoredByActiveSet(GUIDE_PATH)).toBe(false);

      // Never spawns git check-ignore for in-project paths
      expect(gitUtils.isGitIgnored).not.toHaveBeenCalled();
    });

    it('should return false for ancestor directories of active-set files', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.isIgnoredByActiveSet('/project/src')).toBe(false);
      expect(tracker.isIgnoredByActiveSet('/project/docs')).toBe(false);
    });

    it('should return true for EXISTING paths inside projectRoot that are not in the active set', async () => {
      // Real files on disk, because the active set's authority is now scoped
      // to paths that exist — see the non-existent cases below.
      const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-git-tracker-'));
      try {
        mkdirSyncReal(safePath.join(root, 'node_modules'), { recursive: true });
        mkdirSyncReal(safePath.join(root, 'dist'), { recursive: true });
        writeFileSync(safePath.join(root, 'README.md'), '# readme\n');
        writeFileSync(safePath.join(root, 'node_modules', 'foo.js'), 'x\n');
        writeFileSync(safePath.join(root, 'dist', 'foo.js'), 'x\n');
        vi.mocked(gitUtils.gitLsFiles).mockReturnValue(['README.md']);

        const tracker = new GitTracker(root);
        await tracker.initialize();

        expect(tracker.isIgnoredByActiveSet(safePath.join(root, 'node_modules/foo.js'))).toBe(true);
        expect(tracker.isIgnoredByActiveSet(safePath.join(root, 'dist/foo.js'))).toBe(true);

        // Still no git check-ignore spawn for existing in-project paths
        expect(gitUtils.isGitIgnored).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('should NOT call a non-existent in-project path ignored just because the active set lacks it', async () => {
      // The active set is built from `git ls-files`, so it can only ever
      // contain paths that EXIST. A path that does not exist is trivially
      // absent, and a bare set lookup called every typo'd or never-built path
      // "ignored". Callers acted on that: a broken markdown link was reported
      // as a gitignored-data leak instead of a broken link. Such paths must
      // fall through to `git check-ignore`, which answers from the PATTERNS.
      vi.mocked(gitUtils.isGitIgnored).mockReturnValue(false);

      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      const typo = '/project/docs/typo.md';
      expect(tracker.isIgnoredByActiveSet(typo)).toBe(false);
      expect(gitUtils.isGitIgnored).toHaveBeenCalledWith(typo, projectRoot);
    });

    it('should still report a non-existent path that matches an ignore PATTERN as ignored', async () => {
      // The other half: `dist/never-built.js` under an ignored `dist/` is
      // genuinely ignored even though nothing is there yet. Delegating to
      // check-ignore preserves that answer instead of guessing either way.
      vi.mocked(gitUtils.isGitIgnored).mockReturnValue(true);

      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.isIgnoredByActiveSet(NODE_MODULES_PATH)).toBe(true);
    });

    it('should fall back to isGitIgnored for paths outside the project root', async () => {
      vi.mocked(gitUtils.isGitIgnored).mockReturnValue(false);

      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      const outsidePath = '/other/project/file.md';
      const result = tracker.isIgnoredByActiveSet(outsidePath);

      expect(gitUtils.isGitIgnored).toHaveBeenCalledWith(outsidePath, projectRoot);
      expect(result).toBe(false);
    });

    it('should fall back to isIgnored when initialized with includeUntracked: false', async () => {
      vi.mocked(gitUtils.isGitIgnored).mockReturnValue(true);

      const tracker = new GitTracker(projectRoot);
      await tracker.initialize({ includeUntracked: false });

      // Without an authoritative active set we must delegate to the legacy check
      const result = tracker.isIgnoredByActiveSet('/project/node_modules/foo.js');
      expect(gitUtils.isGitIgnored).toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });

  describe('performance optimization', () => {
    it('should avoid redundant git calls for tracked files', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      // Check all tracked files multiple times
      for (let i = 0; i < 10; i++) {
        tracker.isIgnored(README_PATH);
        tracker.isIgnored(INDEX_PATH);
        tracker.isIgnored(GUIDE_PATH);
      }

      // Should never call isGitIgnored (all cached)
      expect(gitUtils.isGitIgnored).not.toHaveBeenCalled();
    });

    it('should cache gitignored files after first check', async () => {
      vi.mocked(gitUtils.isGitIgnored).mockReturnValue(true);

      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      // Check same ignored file 10 times
      for (let i = 0; i < 10; i++) {
        tracker.isIgnored(NODE_MODULES_PATH);
      }

      // Should only call isGitIgnored once (cached after first call)
      expect(gitUtils.isGitIgnored).toHaveBeenCalledTimes(1);
    });
  });
});
