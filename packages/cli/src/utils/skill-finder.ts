/**
 * Utility for finding SKILL.md files in a directory tree
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Recursively find all SKILL.md files in a directory
 *
 * Skips dist and node_modules directories for performance.
 *
 * @param dir - Directory to search
 * @param results - Accumulator for results (internal use)
 * @returns Array of absolute paths to SKILL.md files
 */
export function findSkillFiles(dir: string, results: string[] = []): string[] {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Scanning project directories
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // Skip dist and node_modules
      if (entry.name === 'dist' || entry.name === 'node_modules') {
        continue;
      }

      if (entry.isDirectory()) {
        findSkillFiles(fullPath, results);
      } else if (entry.name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
  } catch (error) {
    // Log warning but continue validation of accessible directories
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Skipping directory ${dir}: ${errorMessage}`);
  }

  return results;
}
