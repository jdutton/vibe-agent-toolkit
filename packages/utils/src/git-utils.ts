/**
 * Centralized git command wrapper.
 * All git commands should go through this module for consistency and testability.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, parse } from 'node:path';

import which from 'which';

import { lookupGitRoot, rememberGitRoot } from './git-root-cache.js';
import { safePath } from './path-utils.js';


/**
 * Find the git repository root by walking up from the given directory.
 *
 * Memoized module-wide via `git-root-cache.ts`: the walk seeds an entry for
 * every directory it climbs, not just for `startDir`, because the redundancy
 * this removes is overlapping walks from *different* start directories rather
 * than repeated calls with the same one. A `null` answer is memoized too — that
 * is the case that costs a walk to the filesystem root.
 *
 * The memo therefore does NOT see a `.git` directory created or removed after
 * the fact. Anything that mutates repositories in-process (tests; a host that
 * re-enters a command) must call `resetProjectRootCaches()`, which clears this
 * cache along with the project-root one.
 *
 * @param startDir - Directory to start searching from
 * @returns Path to git root, or null if not in a git repository
 */
export function gitFindRoot(startDir: string): string | null {
  let currentDir = safePath.resolve(startDir);
  const root = parse(currentDir).root;
  const climbed: string[] = [];

  while (currentDir !== root) {
    const memoized = lookupGitRoot(currentDir);
    if (memoized !== undefined) return rememberGitRoot(climbed, memoized);
    climbed.push(currentDir);

    const gitDir = safePath.join(currentDir, '.git');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walking up from validated startDir
    if (existsSync(gitDir)) {
      return rememberGitRoot(climbed, currentDir);
    }
    currentDir = dirname(currentDir);
  }

  return rememberGitRoot(climbed, null);
}

/**
 * List files tracked by git, optionally filtered by patterns.
 *
 * @param options - Configuration options
 * @param options.cwd - Working directory (git repository root or subdirectory)
 * @param options.patterns - Optional glob patterns to filter files (e.g., '*.md', 'docs/**\/*.ts')
 * @param options.includeUntracked - Include untracked files that aren't gitignored (default: false)
 * @returns Array of file paths relative to the git root, or null if not in a git repo
 *
 * @example
 * ```typescript
 * // List all tracked markdown files
 * const files = gitLsFiles({ cwd: '/project', patterns: ['*.md', 'docs/**\/*.md'] });
 *
 * // List all non-ignored files (tracked + untracked)
 * const allFiles = gitLsFiles({ cwd: '/project', includeUntracked: true });
 * ```
 */
export function gitLsFiles(options: {
  cwd: string;
  patterns?: string[];
  includeUntracked?: boolean;
}): string[] | null {
  try {
    // Resolve git path using which for security (avoids PATH manipulation)
    const gitPath = which.sync('git');

    const args = ['ls-files'];

    // Include untracked files that aren't gitignored
    if (options.includeUntracked) {
      args.push('--cached', '--others', '--exclude-standard');
    }

    // Add patterns if provided
    if (options.patterns && options.patterns.length > 0) {
      args.push('--', ...options.patterns);
    }

    const result = spawnSync(gitPath, args, {
      cwd: options.cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      shell: false, // No shell interpreter for security
    });

    // Exit code 128 typically means not a git repository
    if (result.status === 128 || result.error) {
      return null;
    }

    if (result.status !== 0) {
      return null;
    }

    // Parse output into array of file paths
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    // Git not available or other error
    return null;
  }
}

/**
 * Check if a file path is ignored by git
 *
 * Uses git check-ignore which respects .gitignore, .git/info/exclude, and global gitignore.
 *
 * **Symlink handling**: When `git check-ignore` fails with exit code 128 ("beyond a symbolic
 * link"), this function walks up ancestor directories and checks each one. If any ancestor is
 * gitignored (e.g., `data/` is in `.gitignore`), the file is considered gitignored too. This
 * handles the common pattern where a gitignored directory contains symlinks to external content
 * (e.g., OneDrive, shared drives).
 *
 * **Outside a repository**: answered from the filesystem, with zero subprocesses (see below).
 *
 * **Performance warning**: This spawns a git subprocess for each file (plus up to N ancestor
 * checks when the path traverses a symlink). For bulk workflows, initialize a
 * {@link GitTracker} once and use `isIgnoredByActiveSet()` for O(1) in-repo lookups.
 *
 * @param filePath - Absolute or relative path to check
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns true if file is gitignored, false otherwise
 */
export function isGitIgnored(filePath: string, cwd: string = process.cwd()): boolean {
  // `git check-ignore` exits 128 for two unrelated conditions: "not a git repository"
  // and "beyond a symbolic link". The exit code alone cannot distinguish them, and the
  // symlink recovery below (walk the ancestors, re-spawning git for each) is exactly
  // the wrong response to the first: with no repository *every* ancestor also exits
  // 128, so the walk never breaks, climbs to the filesystem root, and returns `false`
  // after (1 + depth) spawns — per call, for every link in the corpus. It is the right
  // answer by the wrong route, which is why no assertion ever caught it; on a
  // 3,437-document tree with no `.git` ancestor, spawnSync was 87.6% of the run.
  //
  // "Is there a repository here?" is a filesystem question, so settle it from the
  // filesystem before spawning anything.
  if (gitFindRoot(cwd) === null) {
    return false;
  }

  try {
    // Resolve git path using which for security (avoids PATH manipulation)
    const gitPath = which.sync('git');
    const checkIgnoreArgs = ['check-ignore', '-q'] as const;

    // git check-ignore returns exit code 0 if file is ignored, 1 if not
    const result = spawnSync(gitPath, [...checkIgnoreArgs, filePath], {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      shell: false, // No shell interpreter for security
    });

    if (result.status === 0) {
      return true;
    }

    // Exit code 128 = fatal error (e.g., path beyond a symbolic link).
    // Walk up ancestor directories to check if a parent is gitignored.
    // Example: data/ is gitignored, data/symlink/deep/file.md fails with 128,
    // but checking data/ directly returns 0.
    if (result.status !== 1) {
      const resolvedCwd = safePath.resolve(cwd);
      const resolvedFile = safePath.resolve(cwd, filePath);
      let current = dirname(resolvedFile);

      while (current !== resolvedCwd && !current.endsWith(parse(current).root)) {
        const ancestorResult = spawnSync(gitPath, [...checkIgnoreArgs, current], {
          cwd,
          encoding: 'utf-8',
          stdio: 'pipe',
          shell: false,
        });
        if (ancestorResult.status === 0) {
          return true;
        }
        // If this ancestor check also fails fatally, keep walking up
        // If it returns 1 (not ignored), the parent is tracked — stop walking
        if (ancestorResult.status === 1) {
          break;
        }
        current = dirname(current);
      }
    }

    return false;
  } catch {
    // If git is not available or other error, assume not ignored
    return false;
  }
}

