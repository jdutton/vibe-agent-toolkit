/**
 * Project root detection utility
 * Walks up directory tree to find .git or vibe-agent-toolkit.config.yaml
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Find project root by walking up directory tree
 * @param startDir - Directory to start search from
 * @returns Project root path or null if not found
 */
export function findProjectRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (current !== root) {
    // Check for .git directory
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path walking is intentional
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }

    // Check for config file
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path walking is intentional
    if (fs.existsSync(path.join(current, 'vibe-agent-toolkit.config.yaml'))) {
      return current;
    }

    // Move up one directory
    const parent = path.dirname(current);
    if (parent === current) {
      break; // Reached root
    }
    current = parent;
  }

  return null;
}
