/**
 * Centralized git command wrapper.
 * All git commands should go through this module for consistency and testability.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, parse } from 'node:path';

import which from 'which';

import { safePath , toForwardSlash } from './path-utils.js';


/**
 * Find the git repository root by walking up from the given directory.
 *
 * @param startDir - Directory to start searching from
 * @returns Path to git root, or null if not in a git repository
 */
export function gitFindRoot(startDir: string): string | null {
  let currentDir = safePath.resolve(startDir);
  const root = parse(currentDir).root;

  while (currentDir !== root) {
    const gitDir = safePath.join(currentDir, '.git');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walking up from validated startDir
    if (existsSync(gitDir)) {
      return currentDir;
    }
    currentDir = dirname(currentDir);
  }

  return null;
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
 * **Performance warning**: This spawns a git subprocess for each file (plus up to N ancestor
 * checks when the path traverses a symlink). For checking multiple files, use
 * `gitCheckIgnoredBatch()` instead.
 *
 * @param filePath - Absolute or relative path to check
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns true if file is gitignored, false otherwise
 */
export function isGitIgnored(filePath: string, cwd: string = process.cwd()): boolean {
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

/**
 * Batch check if multiple file paths are ignored by git
 *
 * Much more efficient than calling `isGitIgnored()` in a loop - uses a single
 * git subprocess with stdin instead of N subprocesses.
 *
 * **Symlink handling**: After the batch check, any paths that were not reported as
 * ignored are re-checked individually via `isGitIgnored()`, which handles exit code
 * 128 ("beyond a symbolic link") by walking up ancestor directories. This ensures
 * paths through symlinks in gitignored directories are correctly detected.
 *
 * @param filePaths - Array of absolute or relative paths to check
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns Map of filePath -> isIgnored (true if gitignored, false otherwise)
 *
 * @example
 * ```typescript
 * const files = ['src/foo.ts', 'dist/bar.js', 'node_modules/baz.js'];
 * const ignoreMap = gitCheckIgnoredBatch(files, '/project');
 * // ignoreMap.get('src/foo.ts') === false
 * // ignoreMap.get('dist/bar.js') === true
 * // ignoreMap.get('node_modules/baz.js') === true
 * ```
 */
/** Build the normalized→original path map and initialize result map. */
function initBatchMaps(filePaths: string[]): {
  normalizedPaths: string[];
  pathMap: Map<string, string>;
  result: Map<string, boolean>;
} {
  const normalizedPaths = filePaths.map(p => toForwardSlash(p));
  const pathMap = new Map<string, string>();
  const result = new Map<string, boolean>();

  for (const [index, normalizedPath] of normalizedPaths.entries()) {
    const originalPath = filePaths[index];
    if (originalPath !== undefined) {
      pathMap.set(normalizedPath, originalPath);
    }
  }
  for (const filePath of filePaths) {
    result.set(filePath, false);
  }

  return { normalizedPaths, pathMap, result };
}

/** Parse `git check-ignore --stdin` stdout and mark those paths as ignored. */
function applyBatchIgnoredPaths(
  stdout: string,
  pathMap: Map<string, string>,
  result: Map<string, boolean>,
): void {
  const ignoredPaths = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const ignoredPath of ignoredPaths) {
    const originalPath = pathMap.get(ignoredPath);
    if (originalPath !== undefined) {
      result.set(originalPath, true);
    }
  }
}

/**
 * Per-path fallback using isGitIgnored(), which walks ancestor dirs to handle
 * the "beyond a symbolic link" case. Used only when the batch call didn't
 * complete cleanly — see the call site for the exit-code rationale.
 */
function applyPerPathFallback(result: Map<string, boolean>, cwd: string): void {
  for (const [filePath, ignored] of result) {
    if (!ignored && isGitIgnored(filePath, cwd)) {
      result.set(filePath, true);
    }
  }
}

export function gitCheckIgnoredBatch(
  filePaths: string[],
  cwd: string = process.cwd()
): Map<string, boolean> {
  if (filePaths.length === 0) {
    return new Map<string, boolean>();
  }

  const { normalizedPaths, pathMap, result } = initBatchMaps(filePaths);

  try {
    const gitPath = which.sync('git');

    const gitResult = spawnSync(gitPath, ['check-ignore', '--stdin'], {
      cwd,
      encoding: 'utf-8',
      input: normalizedPaths.join('\n'),
      stdio: 'pipe',
      shell: false,
    });

    if (gitResult.status === 0 && gitResult.stdout) {
      applyBatchIgnoredPaths(gitResult.stdout, pathMap, result);
    }

    // `git check-ignore --stdin` exits:
    //   0  — at least one path was reported as ignored (authoritative)
    //   1  — no paths were ignored (authoritative; nothing on stdout)
    //  128 — fatal error, commonly "beyond a symbolic link" for one of the
    //        inputs. When this happens the batch results may be incomplete,
    //        so fall back to per-path isGitIgnored() (which walks ancestor
    //        dirs to handle the symlink case).
    //
    // The fallback used to run unconditionally, which spawns one git
    // subprocess per non-ignored path — O(N) spawns for every batch call
    // and a measurable cost for monorepo-scale walkers (half of
    // `vat audit .` wall time on the VAT repo before this change).
    if (gitResult.status !== 0 && gitResult.status !== 1) {
      applyPerPathFallback(result, cwd);
    }

    return result;
  } catch {
    return result;
  }
}
