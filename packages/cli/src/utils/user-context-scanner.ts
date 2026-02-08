/**
 * User context scanner
 *
 * Scan user-level Claude directories for plugins, skills, and marketplaces.
 */

import { existsSync } from 'node:fs';

import { scan, type ScanResult } from '@vibe-agent-toolkit/discovery';

import { getClaudeUserPaths } from './claude-paths.js';

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
}> {
  const { pluginsDir, skillsDir } = getClaudeUserPaths();

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
  }

  // Marketplaces reserved for future use
  const marketplaces: ScanResult[] = [];

  return {
    plugins,
    skills,
    marketplaces,
  };
}
