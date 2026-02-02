/**
 * Project root detection utility
 * Walks up directory tree to find .git or vibe-agent-toolkit.config.yaml
 *
 * Environment Variables:
 * - VAT_TEST_ROOT: Override project root for testing (bypasses detection)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Find project root by walking up directory tree
 *
 * @param startDir - Directory to start search from
 * @returns Project root path or null if not found
 *
 * @remarks
 * Can be overridden with VAT_TEST_ROOT environment variable for testing.
 * This allows tests to specify an exact project root without relying on
 * directory structure (.git or config file presence).
 *
 * @example
 * ```typescript
 * // Normal usage
 * const root = findProjectRoot(process.cwd());
 *
 * // Test usage with override
 * process.env.VAT_TEST_ROOT = '/path/to/test/fixtures';
 * const root = findProjectRoot(process.cwd()); // Returns /path/to/test/fixtures
 * ```
 */
export function findProjectRoot(startDir: string): string | null {
  // Override for testing: VAT_TEST_ROOT bypasses detection
  if (process.env['VAT_TEST_ROOT']) {
    return process.env['VAT_TEST_ROOT'];
  }

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
