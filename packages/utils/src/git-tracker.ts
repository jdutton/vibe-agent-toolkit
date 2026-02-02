/**
 * Git tracking cache for efficient git-ignore checking.
 *
 * Problem: Calling git check-ignore on every file is expensive (spawns process each time).
 * Solution: Cache results and pre-populate with git ls-files (tracked files are never ignored).
 */

import { gitLsFiles, isGitIgnored } from './git-utils.js';

/**
 * Git tracking cache service.
 *
 * Provides efficient git-ignore checking with caching and pre-population from git ls-files.
 *
 * @example
 * ```typescript
 * const tracker = new GitTracker('/project');
 * await tracker.initialize();
 *
 * // Check if file is ignored (uses cache)
 * const ignored = tracker.isTrackedByGit('/project/docs/file.md');
 * ```
 */
export class GitTracker {
  private readonly projectRoot: string;
  private readonly cache: Map<string, boolean> = new Map();
  private initialized = false;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Initialize the tracker by pre-populating cache from git ls-files.
   *
   * All files returned by git ls-files are tracked and therefore NOT ignored.
   * This avoids calling git check-ignore for the common case (tracked files).
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Get all tracked files from git
    const trackedFiles = gitLsFiles({ cwd: this.projectRoot });

    // Pre-populate cache: tracked files are NOT ignored
    if (trackedFiles !== null) {
      for (const relativePath of trackedFiles) {
        const absolutePath = `${this.projectRoot}/${relativePath}`;
        this.cache.set(absolutePath, false); // false = not ignored
      }
    }

    this.initialized = true;
  }

  /**
   * Check if a file is ignored by git.
   *
   * Uses cache if available, otherwise calls git check-ignore and caches result.
   *
   * @param filePath - Absolute path to file
   * @returns true if file is gitignored, false otherwise
   */
  isIgnored(filePath: string): boolean {
    // Check cache first
    const cached = this.cache.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    // Not in cache - call git check-ignore and cache result
    const ignored = isGitIgnored(filePath, this.projectRoot);
    this.cache.set(filePath, ignored);

    return ignored;
  }

  /**
   * Get cache statistics.
   *
   * @returns Object with cache size
   */
  getStats(): { cacheSize: number } {
    return {
      cacheSize: this.cache.size,
    };
  }

  /**
   * Clear the cache.
   */
  clear(): void {
    this.cache.clear();
    this.initialized = false;
  }
}
