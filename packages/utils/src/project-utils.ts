/**
 * Project root discovery utilities.
 *
 * Finds the project root directory using a layered detection strategy:
 * workspace root (monorepo) -> git root -> directory fallback.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { gitFindRoot } from './git-utils.js';

const PACKAGE_JSON_FILENAME = 'package.json';

/**
 * Find the project root for boundary enforcement.
 *
 * Detection order:
 * 1. Walk up from startDir looking for package.json with "workspaces" (monorepo root)
 * 2. Fall back to git repository root
 * 3. Fall back to startDir itself (tests / standalone)
 *
 * @param startDir - Directory to start searching from (e.g., dirname of SKILL.md)
 * @returns Project root directory
 */
export function findProjectRoot(startDir: string): string {
  let currentDir = resolve(startDir);
  const resolvedStartDir = currentDir;

  // 1. Walk up looking for workspace root (package.json with "workspaces")
  while (currentDir !== dirname(currentDir)) {
    const packageJsonPath = join(currentDir, PACKAGE_JSON_FILENAME);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Walking up from validated startDir
    if (existsSync(packageJsonPath)) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Walking up from validated startDir
        const content = readFileSync(packageJsonPath, 'utf-8');
        const parsed: unknown = JSON.parse(content);
        if (typeof parsed === 'object' && parsed !== null && 'workspaces' in parsed) {
          return currentDir;
        }
      } catch {
        // Invalid JSON - skip this package.json
      }
    }
    currentDir = dirname(currentDir);
  }

  // 2. Fall back to git root
  const gitRoot = gitFindRoot(resolvedStartDir);
  if (gitRoot !== null) {
    return gitRoot;
  }

  // 3. Fall back to start directory
  return resolvedStartDir;
}
