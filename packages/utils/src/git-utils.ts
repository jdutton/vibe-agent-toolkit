/**
 * Centralized git command wrapper.
 * All git commands should go through this module for consistency and testability.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

import which from 'which';

/**
 * Find the git repository root by walking up from the given directory.
 *
 * @param startDir - Directory to start searching from
 * @returns Path to git root, or null if not in a git repository
 */
export function gitFindRoot(startDir: string): string | null {
  let currentDir = resolve(startDir);
  const root = parse(currentDir).root;

  while (currentDir !== root) {
    const gitDir = join(currentDir, '.git');
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
 * Uses git check-ignore which respects .gitignore, .git/info/exclude, and global gitignore
 *
 * @param filePath - Absolute or relative path to check
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns true if file is gitignored, false otherwise
 */
export function isGitIgnored(filePath: string, cwd: string = process.cwd()): boolean {
  try {
    // Resolve git path using which for security (avoids PATH manipulation)
    const gitPath = which.sync('git');

    // git check-ignore returns exit code 0 if file is ignored, 1 if not
    const result = spawnSync(gitPath, ['check-ignore', '-q', filePath], {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      shell: false, // No shell interpreter for security
    });

    return result.status === 0;
  } catch {
    // If git is not available or other error, assume not ignored
    return false;
  }
}
