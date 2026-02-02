/**
 * Utilities for checking if files are gitignored.
 * Used by file-crawler and link validation.
 *
 * @deprecated This module uses pattern-based checking which doesn't respect tracked files.
 * Use git-utils.ts for authoritative git commands (gitFindRoot, isGitIgnored, gitLsFiles).
 */

import fs from 'node:fs';
import path from 'node:path';

import ignore, { type Ignore } from 'ignore';

import { gitFindRoot } from './git-utils.js';
import { toForwardSlash } from './path-utils.js';

/**
 * Find the git repository root by walking up from the given directory.
 *
 * @param startDir - Directory to start searching from
 * @returns Path to git root, or null if not in a git repository
 *
 * @deprecated Use gitFindRoot from git-utils.ts instead
 */
export function findGitRoot(startDir: string): string | null {
  return gitFindRoot(startDir);
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

