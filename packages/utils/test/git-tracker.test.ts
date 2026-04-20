/**
 * Tests for GitTracker - git-ignore checking with caching
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitTracker } from '../src/git-tracker.js';
import * as gitUtils from '../src/git-utils.js';

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

    it('should return true for paths inside projectRoot that are not in the active set', async () => {
      const tracker = new GitTracker(projectRoot);
      await tracker.initialize();

      expect(tracker.isIgnoredByActiveSet(NODE_MODULES_PATH)).toBe(true);
      expect(tracker.isIgnoredByActiveSet('/project/dist/foo.js')).toBe(true);

      // Still no git check-ignore spawn for in-project paths
      expect(gitUtils.isGitIgnored).not.toHaveBeenCalled();
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
