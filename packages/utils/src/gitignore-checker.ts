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

import { isPathAbsentError } from './errors/errno.js';
import { safePath , toForwardSlash } from './path-utils.js';
import { readTextContentSync } from './text-file.js';

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
  let currentDir = safePath.resolve(baseDir ?? gitRoot);
  const resolvedGitRoot = safePath.resolve(gitRoot);

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
    const gitignorePath = safePath.join(dir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        // Through the decoding seam. A `.gitignore` written by PowerShell's `>`
        // is UTF-16LE, and `readFileSync(p, 'utf-8')` would hand `ignore` a
        // string of NUL-interleaved garbage — every pattern silently wrong, with
        // no error anywhere.
        ig.add(readTextContentSync(gitignorePath).text);
      } catch (error) {
        // Gone between `existsSync` and the read: no rules here. A `.gitignore`
        // the OS refuses to read (`EACCES`), or one that is a directory
        // (`EISDIR`), holds rules this checker cannot honour — and a crawl that
        // quietly proceeded without them enumerated the ignored tree with
        // nothing anywhere saying so. Those stay loud.
        if (!isPathAbsentError(error)) throw error;
      }
    }
  }

  return hasRules ? ig : null;
}

