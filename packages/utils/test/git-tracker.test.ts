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
