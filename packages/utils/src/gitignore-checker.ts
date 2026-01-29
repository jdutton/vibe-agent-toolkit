/**
 * Utilities for checking if files are gitignored.
 * Used by file-crawler and link validation.
 */

import fs from 'node:fs';
import path from 'node:path';

import ignore, { type Ignore } from 'ignore';

import { toForwardSlash } from './path-utils.js';

/**
 * Find the git repository root by walking up from the given directory.
 *
 * @param startDir - Directory to start searching from
 * @returns Path to git root, or null if not in a git repository
 */
export function findGitRoot(startDir: string): string | null {
  let currentDir = path.resolve(startDir);
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    const gitDir = path.join(currentDir, '.git');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walking up from validated startDir
    if (fs.existsSync(gitDir)) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }

  return null;
}

/**
 * Load and parse .gitignore files from git root to baseDir.
 * Returns an ignore instance configured with all applicable .gitignore rules.
 *
 * @param gitRoot - Git repository root directory
 * @param baseDir - Base directory being checked (optional, defaults to gitRoot)
 * @returns Configured ignore instance, or null if no gitignore files found
 */
export function loadGitignoreRules(gitRoot: string, baseDir?: string): Ignore | null {
  const ig = ignore();
  let hasRules = false;

  // Always ignore .git directory
  ig.add('.git');
  hasRules = true;

  // Collect all directories from gitRoot to baseDir
  const dirsToCheck: string[] = [];
  let currentDir = path.resolve(baseDir ?? gitRoot);
  const resolvedGitRoot = path.resolve(gitRoot);

  // Normalize for cross-platform path comparison
  const normalizedGitRoot = toForwardSlash(resolvedGitRoot);

  while (toForwardSlash(currentDir).startsWith(normalizedGitRoot)) {
    dirsToCheck.unshift(currentDir);
    if (currentDir === resolvedGitRoot) {
      break;
    }
    currentDir = path.dirname(currentDir);
  }

  // Load .gitignore files from git root down to baseDir
  for (const dir of dirsToCheck) {
    const gitignorePath = path.join(dir, '.gitignore');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from validated gitRoot and baseDir
    if (fs.existsSync(gitignorePath)) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated above
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        ig.add(content);
      } catch {
        // Skip gitignore files we can't read
      }
    }
  }

  return hasRules ? ig : null;
}

/**
 * Check if a file path is ignored by git.
 *
 * @param filePath - Absolute path to check
 * @param gitRoot - Git repository root (optional, will auto-detect if not provided)
 * @returns True if file is gitignored, false otherwise
 */
export function isGitignored(filePath: string, gitRoot?: string): boolean {
  const resolvedPath = path.resolve(filePath);

  // Find git root if not provided
  const root = gitRoot ?? findGitRoot(resolvedPath);
  if (!root) {
    // Not in a git repository
    return false;
  }

  // Load gitignore rules
  const ig = loadGitignoreRules(root);
  if (!ig) {
    // No gitignore rules
    return false;
  }

  // Get path relative to git root
  const relativePath = path.relative(root, resolvedPath);
  const normalizedPath = toForwardSlash(relativePath);

  return ig.ignores(normalizedPath);
}
