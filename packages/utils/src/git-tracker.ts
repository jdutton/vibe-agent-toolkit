/**
 * Git tracking cache for efficient git-ignore checking.
 *
 * Problem: Calling git check-ignore on every file is expensive (spawns process each time).
 * Solution: Cache results and pre-populate with git ls-files (tracked + untracked non-ignored).
 */

import { dirname } from 'node:path';

import { gitLsFiles, isGitIgnored } from './git-utils.js';
import { safePath, toForwardSlash } from './path-utils.js';

/**
 * Options for {@link GitTracker.initialize}.
 */
export interface GitTrackerInitOptions {
  /**
   * When true (default), pre-populate the "active set" from
   * `git ls-files --cached --others --exclude-standard`, which returns all
   * tracked + untracked-but-not-gitignored files. This enables O(1) bulk
   * `isIgnoredByActiveSet` lookups without spawning `git check-ignore` per
   * path.
   *
   * When false, only tracked files are pre-populated (legacy v0.1.31 behavior).
   * Use this only when you know the caller will still rely on
   * {@link GitTracker.isIgnored}'s cache-miss fallback and untracked
   * non-ignored files are rare.
   */
  includeUntracked?: boolean;
}

/**
 * Git tracking cache service.
 *
 * Provides efficient git-ignore checking with caching and pre-population from git ls-files.
 *
 * Bulk callers (directory walkers that process hundreds+ of paths) should
 * prefer {@link isIgnoredByActiveSet} and {@link hasActiveDescendant} — both
 * answer in O(1) against the pre-populated active set and never spawn a git
 * subprocess for paths inside the project root.
 *
 * One-off callers (e.g. link validators that only check a handful of paths)
 * can use {@link isIgnored}, which falls back to `git check-ignore` on cache
 * miss.
 *
 * @example
 * ```typescript
 * const tracker = new GitTracker('/project');
 * await tracker.initialize(); // defaults to includeUntracked: true
 *
 * // Bulk path: O(1) lookup against pre-populated active set
 * if (!tracker.isIgnoredByActiveSet('/project/docs/file.md')) { ... }
 *
 * // One-off path: may spawn `git check-ignore` on miss
 * if (!tracker.isIgnored('/project/docs/file.md')) { ... }
 * ```
 */
export class GitTracker {
  private readonly projectRoot: string;
  private readonly normalizedProjectRoot: string;
  private readonly cache: Map<string, boolean> = new Map();
  /** Absolute paths of all files known to be NOT ignored (tracked + untracked non-ignored). */
  private readonly activeSet: Set<string> = new Set();
  /** Absolute paths of every directory that contains at least one active-set file. */
  private readonly activeAncestors: Set<string> = new Set();
  private initialized = false;
  private activeSetPopulated = false;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.normalizedProjectRoot = safePath.resolve(projectRoot);
  }

  /**
   * Initialize the tracker by pre-populating cache from git ls-files.
   *
   * With `includeUntracked: true` (default), the tracker builds an "active set"
   * of all files that are NOT gitignored (tracked + untracked-not-ignored).
   * This lets {@link isIgnoredByActiveSet} answer in O(1) without spawning
   * `git check-ignore` per file.
   *
   * With `includeUntracked: false`, only tracked files are pre-populated.
   * Untracked non-ignored files will miss the cache and fall through to
   * `git check-ignore` via {@link isIgnored}.
   */
  async initialize(options?: GitTrackerInitOptions): Promise<void> {
    if (this.initialized) {
      return;
    }

    const includeUntracked = options?.includeUntracked ?? true;

    const files = gitLsFiles({
      cwd: this.projectRoot,
      ...(includeUntracked ? { includeUntracked: true } : {}),
    });

    if (files !== null) {
      for (const relativePath of files) {
        const absolutePath = safePath.resolve(this.projectRoot, relativePath);
        this.cache.set(absolutePath, false); // false = not ignored
        this.activeSet.add(absolutePath);
      }
      this.populateAncestorSet();
    }

    this.activeSetPopulated = includeUntracked && files !== null;
    this.initialized = true;
  }

  /**
   * Walk up from each active-set file's directory and record every ancestor up to projectRoot.
   *
   * `activeSet` keys are forward-slash (via `safePath.resolve`) but `node:path.dirname`
   * returns backslashes on Windows. Wrap every `dirname()` result with `toForwardSlash()`
   * so the `activeAncestors` set uses the same key shape as `activeSet` — otherwise every
   * `hasActiveDescendant` / `isIgnoredByActiveSet` ancestor lookup misses on Windows.
   */
  private populateAncestorSet(): void {
    const root = this.normalizedProjectRoot;

    for (const absolutePath of this.activeSet) {
      let current = toForwardSlash(dirname(absolutePath));

      while (current !== root && current.length > root.length) {
        if (this.activeAncestors.has(current)) {
          // Ancestor (and all of its ancestors) already recorded — avoid redundant work.
          break;
        }
        this.activeAncestors.add(current);
        const parent = toForwardSlash(dirname(current));
        if (parent === current) {
          break;
        }
        current = parent;
      }
    }

    // projectRoot itself is always an implicit ancestor of everything under it.
    this.activeAncestors.add(root);
  }

  /**
   * Returns true if the given absolute path IS an active-set file OR is an
   * ancestor directory of at least one active-set file.
   *
   * Used by walkers to decide whether descending into a directory is worth
   * the cost: an ignored directory with no active descendants can be skipped
   * outright. Requires {@link initialize} with `includeUntracked: true`
   * (the default); returns `true` for any path otherwise, to preserve the
   * legacy behavior where walkers descended unconditionally.
   *
   * @param absolutePath - Absolute path to check (file or directory)
   */
  hasActiveDescendant(absolutePath: string): boolean {
    if (!this.activeSetPopulated) {
      return true;
    }
    const normalized = safePath.resolve(absolutePath);
    return this.activeSet.has(normalized) || this.activeAncestors.has(normalized);
  }

  /**
   * Fast O(1) ignore check against the pre-populated active set.
   *
   * For paths INSIDE the project root, membership in the active set is
   * authoritative: a path is ignored iff it is not in the active set AND not
   * an ancestor of any active-set path. No `git check-ignore` spawn.
   *
   * For paths OUTSIDE the project root, falls back to {@link isIgnored} so
   * legacy behavior is preserved.
   *
   * Requires {@link initialize} with `includeUntracked: true` (the default).
   * When initialized without untracked files, this method delegates to
   * {@link isIgnored} so callers still get correct results at the cost of a
   * possible per-path spawn.
   *
   * @param absolutePath - Absolute path to check
   */
  isIgnoredByActiveSet(absolutePath: string): boolean {
    if (!this.activeSetPopulated) {
      return this.isIgnored(absolutePath);
    }

    const normalized = safePath.resolve(absolutePath);

    // Paths outside projectRoot can't be answered from the active set alone.
    if (!this.isWithinProjectRoot(normalized)) {
      return this.isIgnored(absolutePath);
    }

    return !(this.activeSet.has(normalized) || this.activeAncestors.has(normalized));
  }

  private isWithinProjectRoot(normalizedAbsolutePath: string): boolean {
    const root = this.normalizedProjectRoot;
    if (normalizedAbsolutePath === root) {
      return true;
    }
    return normalizedAbsolutePath.startsWith(`${root}/`);
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
    // Normalize to the same shape used during cache population so Windows
    // paths (drive-prefixed by `path.resolve`) hit the cache instead of
    // falling through to `git check-ignore`. On POSIX this is a no-op for
    // canonical absolute paths but is still required for robustness against
    // paths containing `..` or trailing slashes. The original filePath is
    // still passed to `isGitIgnored` — git handles its own normalization.
    const cacheKey = safePath.resolve(filePath);

    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Not in cache - call git check-ignore and cache result
    const ignored = isGitIgnored(filePath, this.projectRoot);
    this.cache.set(cacheKey, ignored);

    return ignored;
  }

  /**
   * Get cache statistics.
   */
  getStats(): { cacheSize: number; activeSetSize: number; activeAncestorsSize: number } {
    return {
      cacheSize: this.cache.size,
      activeSetSize: this.activeSet.size,
      activeAncestorsSize: this.activeAncestors.size,
    };
  }

  /**
   * Clear the cache.
   */
  clear(): void {
    this.cache.clear();
    this.activeSet.clear();
    this.activeAncestors.clear();
    this.initialized = false;
    this.activeSetPopulated = false;
  }
}
