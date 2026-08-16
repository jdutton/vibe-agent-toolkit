/**
 * Git tracking cache for efficient git-ignore checking.
 *
 * Problem: Calling git check-ignore on every file is expensive (spawns process each time).
 * Solution: Cache results and pre-populate with git ls-files (tracked + untracked non-ignored).
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  CRAWL_SHARED_GIT_TRACKER_ID,
  crawlTimingStart,
  recordSharedPass,
} from './crawl-timing.js';
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
  /**
   * Lowercased absolute path → the root-relative path spelled the way git
   * spelled it. Built from the very same `git ls-files` output `activeSet`
   * comes from, so it costs one extra `Map` and no extra git invocation.
   */
  private readonly indexPaths: Map<string, string> = new Map();
  private initialized = false;
  private activeSetPopulated = false;
  /** Whether `git ls-files` actually answered during {@link initialize}. */
  private gitAnswered = false;

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
   *
   * ## This is the one bracket in the crawl-timing seam's `shared` stratum
   *
   * The `git ls-files` spawn below is preparation BOTH crawlers consume and
   * NEITHER owns — the incumbent link walk and the projection's contributors are
   * each handed a tracker by their caller — so it is charged to
   * {@link CRAWL_SHARED_GIT_TRACKER_ID}, in a stratum belonging to no arm.
   *
   * The bracket is here, inside the class, and not at the six sites that build a
   * tracker, for the reason `crawl-timing.ts` gives about `ResourceRegistry`: six
   * copies are six chances to disagree, and a seventh site added later would
   * silently go uncharged. Here, every caller is covered by construction — which
   * includes `@vibe-agent-toolkit/discovery`, a package that could not have filed
   * a row from its own call site at all, since it depends on `utils` alone.
   *
   * The early return above is deliberately OUTSIDE it: a re-entrant call does no
   * work, and charging it would inflate `calls` with questions rather than
   * spawns.
   */
  async initialize(options?: GitTrackerInitOptions): Promise<void> {
    if (this.initialized) {
      return;
    }

    const startedAt = crawlTimingStart();
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
        this.indexPaths.set(absolutePath.toLowerCase(), toForwardSlash(relativePath));
      }
      this.populateAncestorSet();
    }

    this.gitAnswered = files !== null;
    this.activeSetPopulated = includeUntracked && files !== null;
    this.initialized = true;
    // After the state above is settled, so a throw from the seam could never
    // leave a half-initialized tracker; and charged even when git did not answer,
    // because a failed `git ls-files` still spawned a process and still cost the
    // command the time it took to fail.
    recordSharedPass(CRAWL_SHARED_GIT_TRACKER_ID, startedAt);
  }

  /**
   * Did git actually answer, or is this tracker an empty shell?
   *
   * `gitLsFiles` returns `null` for every way asking can fail — no `git` on
   * `PATH`, a corrupt `.git`, an unreadable `.git`, a non-repository cwd — and
   * that `null` is otherwise indistinguishable here from "git answered, and the
   * repository is empty": both leave the active set with zero entries, after
   * which {@link isIgnoredByActiveSet} reports every path as NOT ignored.
   *
   * For a walker that is fine — unfiltered is the safe default. For a caller that
   * INFERS something from "not ignored" (provenance, publication, leakage) it is
   * not: the inference silently becomes a fixed answer. Such callers must ask
   * this first and treat `false` as "no answer available", never as a verdict.
   */
  isUsable(): boolean {
    return this.gitAnswered;
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
   * For paths INSIDE the project root **that exist on disk**, membership in the
   * active set is authoritative: such a path is ignored iff it is not in the
   * active set AND not an ancestor of any active-set path. No `git
   * check-ignore` spawn.
   *
   * The existence qualifier is load-bearing, not a caveat. The active set is
   * built from `git ls-files`, so it can only ever contain paths that EXIST — a
   * path that does not exist is trivially absent from it, and a bare set lookup
   * would call every typo'd or never-built path "ignored". Callers acted on
   * that: a broken markdown link was reported as a gitignored-data leak rather
   * than a broken link. Such paths therefore fall back to {@link isIgnored},
   * i.e. `git check-ignore`, which answers from the ignore PATTERNS and is
   * correct for a path that is merely named (`dist/out.js` under an ignored
   * `dist/` is ignored; `docs/typo.md` is not). The fallback result is cached,
   * so a repeated miss on the same path stays O(1).
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
   * @param knownToExist - The caller's own answer to the existence question, when
   *   it has already asked. Supplying it skips this method's `existsSync`, which
   *   is otherwise paid once per path that is absent from the active set — i.e.
   *   once per ignored path, and the projection's `filesystem` extent enumerates
   *   all of them (11,108 calls on an 8,496-path adopter tree).
   *
   *   **It must mean what `existsSync` means: `stat` succeeds, following
   *   symlinks.** A caller holding only an `lstat` result has a DIFFERENT fact —
   *   `lstat` succeeds on a dangling symlink where `existsSync` returns false —
   *   and must narrow it to `exists && symlinkResolves !== false` rather than
   *   pass the `lstat` boolean through, or dangling symlinks silently stop
   *   falling back to `git check-ignore` and start reporting as ignored.
   *   Omit it and nothing changes.
   */
  isIgnoredByActiveSet(absolutePath: string, knownToExist?: boolean): boolean {
    if (!this.activeSetPopulated) {
      return this.isIgnored(absolutePath);
    }

    const normalized = safePath.resolve(absolutePath);

    // Paths outside projectRoot can't be answered from the active set alone.
    if (!this.isWithinProjectRoot(normalized)) {
      return this.isIgnored(absolutePath);
    }

    if (this.activeSet.has(normalized) || this.activeAncestors.has(normalized)) {
      return false;
    }

    // Absent from the active set. That means "ignored" only for a path that is
    // actually there; otherwise the set has no opinion and git must be asked.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied path, read-only existence probe
    const present = knownToExist ?? existsSync(normalized);
    if (!present) {
      return this.isIgnored(absolutePath);
    }

    return true;
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
   * The spelling git records for a path, or `null` if git has no record of it.
   *
   * This is the casing oracle, not another ignore check. On a case-insensitive
   * filesystem `docs/Readme.md` and `docs/README.md` are one inode with two
   * spellings, and Node's two `realpath` implementations disagree about which
   * one they hand back — so anything that derives an identity from a path needs
   * a single authoritative spelling, and git's is it wherever git has one.
   *
   * The lookup key is lowercased, which is the point: the caller asks with
   * whatever casing it observed and gets back the casing git holds.
   *
   * Answers only from the pre-populated set — never spawns. A path git does not
   * know (untracked-and-ignored, non-existent, outside the project root, or any
   * path at all when `git ls-files` did not answer) returns `null`, and the
   * caller falls back to the on-disk casing.
   *
   * @param absolutePath - Absolute path to look up
   * @returns Root-relative, forward-slashed path as git spells it — relative to
   *   THIS tracker's project root — or `null` when git has no record of it
   */
  indexPathFor(absolutePath: string): string | null {
    return this.indexPaths.get(safePath.resolve(absolutePath).toLowerCase()) ?? null;
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
    this.indexPaths.clear();
    this.initialized = false;
    this.activeSetPopulated = false;
    this.gitAnswered = false;
  }
}
