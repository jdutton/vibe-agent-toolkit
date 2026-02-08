/**
 * Claude user directory paths
 *
 * Cross-platform utilities for accessing Claude's user-level directories.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Get user-level Claude directories
 *
 * Returns absolute paths to Claude user directories.
 * Paths are constructed but not checked for existence (caller's responsibility).
 *
 * @returns Object containing absolute paths to Claude directories
 *
 * @example
 * ```typescript
 * const { claudeDir, pluginsDir, skillsDir } = getClaudeUserPaths();
 * // claudeDir: /Users/username/.claude
 * // pluginsDir: /Users/username/.claude/plugins
 * // skillsDir: /Users/username/.claude/skills
 * ```
 */
export function getClaudeUserPaths(): {
  /** ~/.claude directory */
  claudeDir: string;
  /** ~/.claude/plugins directory */
  pluginsDir: string;
  /** ~/.claude/skills directory */
  skillsDir: string;
  /** ~/.claude/marketplaces directory */
  marketplacesDir: string;
} {
  const home = homedir();
  const claudeDir = join(home, '.claude');

  return {
    claudeDir,
    pluginsDir: join(claudeDir, 'plugins'),
    skillsDir: join(claudeDir, 'skills'),
    marketplacesDir: join(claudeDir, 'marketplaces'),
  };
}

