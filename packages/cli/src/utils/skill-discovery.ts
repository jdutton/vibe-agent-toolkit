/**
 * Skill discovery utilities
 *
 * Find and validate SKILL.md files within a bounded set of resources.
 * Uses case-insensitive matching for discovery but validates proper casing.
 */

import { basename } from 'node:path';

import type { ScanResult } from '@vibe-agent-toolkit/discovery';
import picomatch from 'picomatch';

/**
 * Case-insensitive matcher for SKILL.md files
 *
 * Matches SKILL.md anywhere in the path, regardless of case.
 * Examples: SKILL.md, skill.md, Skill.md, path/to/SKILL.md
 */
const isSkillFile = picomatch('**/SKILL.md', {
  nocase: true,      // Case-insensitive matching
  matchBase: true,   // Match basename anywhere in path
});

/**
 * Discover SKILL.md files from a set of scanned resources
 *
 * Uses case-insensitive matching to find all SKILL.md variants.
 * Does NOT validate that the filename is exactly "SKILL.md" - use
 * validateSkillFilename() for that.
 *
 * @param resources - Array of scan results from discovery package
 * @returns Filtered array containing only SKILL.md files
 *
 * @example
 * ```typescript
 * const allResources = await scan({ path: '~/.claude/plugins', recursive: true });
 * const skills = discoverSkills(allResources.results);
 * // Returns only resources with SKILL.md basename (any case)
 * ```
 */
export function discoverSkills(resources: ScanResult[]): ScanResult[] {
  return resources.filter(resource => isSkillFile(resource.path));
}

/**
 * Validate that a skill file has the exact correct filename
 *
 * SKILL.md must be uppercase. Lowercase (skill.md) or mixed case (Skill.md)
 * may work on case-insensitive filesystems (macOS, Windows) but will fail
 * on Linux.
 *
 * @param skillPath - Absolute path to skill file
 * @returns Validation result with helpful error message if invalid
 *
 * @example
 * ```typescript
 * const validation = validateSkillFilename('/path/to/skill.md');
 * if (!validation.valid) {
 *   console.error(validation.message); // "Filename must be exactly SKILL.md..."
 * }
 * ```
 */
export function validateSkillFilename(skillPath: string): {
  valid: boolean;
  basename: string;
  message?: string;
} {
  // Normalize path separators for cross-platform support
  const normalizedPath = skillPath.replaceAll('\\', '/');
  const filename = basename(normalizedPath);

  if (filename === 'SKILL.md') {
    return {
      valid: true,
      basename: filename,
    };
  }

  return {
    valid: false,
    basename: filename,
    message: `Filename must be exactly "SKILL.md" (case-sensitive). Found "${filename}". This may work on case-insensitive filesystems (macOS, Windows) but will fail on Linux.`,
  };
}
