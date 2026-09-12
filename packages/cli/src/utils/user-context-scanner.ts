/**
 * User context scanner
 *
 * Scan user-level Claude directories for plugins, skills, and marketplaces.
 */

import { existsSync } from 'node:fs';

import { getClaudeUserPaths } from '@vibe-agent-toolkit/claude-marketplace';
import { scan, type ScanResult } from '@vibe-agent-toolkit/discovery';
import type { DirectoryRefusal } from '@vibe-agent-toolkit/utils/crawl';


/**
 * Scan user-level Claude directories for skills and plugins
 *
 * Scans:
 * - ~/.claude/plugins for SKILL.md and .claude-plugin directories
 * - ~/.claude/skills for SKILL.md files
 * - ~/.claude/marketplaces (reserved for future use)
 *
 * Returns empty arrays if directories don't exist (not an error).
 *
 * @returns Object containing separate arrays for plugins, skills, marketplaces
 *
 * @example
 * ```typescript
 * const context = await scanUserContext();
 * console.log(`Found ${context.plugins.length} plugins`);
 * console.log(`Found ${context.skills.length} skills`);
 * ```
 */
export async function scanUserContext(): Promise<{
  plugins: ScanResult[];
  skills: ScanResult[];
  marketplaces: ScanResult[];
  /**
   * Directories under either tree that could not be listed — carried through
   * from `ScanSummary.unreadable`, because a `~/.claude/plugins` with one
   * root-owned directory is ordinary and every caller must say what it could
   * not see rather than list fewer skills.
   */
  unreadable: DirectoryRefusal[];
}> {
  const { pluginsDir, skillsDir } = getClaudeUserPaths();
  const unreadable: DirectoryRefusal[] = [];

  // Scan plugins directory (SKILL.md and .claude-plugin directories)
  let plugins: ScanResult[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- User's home directory is safe
  if (existsSync(pluginsDir)) {
    const pluginsScan = await scan({
      path: pluginsDir,
      recursive: true,
      include: ['**/SKILL.md', '**/.claude-plugin/**'],
    });
    plugins = pluginsScan.results;
    unreadable.push(...pluginsScan.unreadable);
  }

  // Scan skills directory (SKILL.md files)
  let skills: ScanResult[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- User's home directory is safe
  if (existsSync(skillsDir)) {
    const skillsScan = await scan({
      path: skillsDir,
      recursive: true,
      include: ['**/SKILL.md'],
    });
    skills = skillsScan.results;
    unreadable.push(...skillsScan.unreadable);
  }

  // Marketplaces reserved for future use
  const marketplaces: ScanResult[] = [];

  return {
    plugins,
    skills,
    marketplaces,
    unreadable,
  };
}
