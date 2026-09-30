/**
 * User context scanner
 *
 * Scan user-level Claude directories for plugins, skills, and marketplaces.
 */

import { statSync } from 'node:fs';

import { getClaudeUserPaths } from '@vibe-agent-toolkit/claude-marketplace';
import { scan, type ScanResult } from '@vibe-agent-toolkit/discovery';
import { rootListingRefusal, type DirectoryRefusal } from '@vibe-agent-toolkit/utils/crawl';

/**
 * Whether a scan root is there to scan. Absent is `false` (scanned and empty);
 * a `stat` the OS refuses — an untraversable `~/.claude` — is recorded in
 * `unreadable` and also `false`, so the root is never reported as read.
 */
function rootToScan(dir: string, unreadable: DirectoryRefusal[]): boolean {
  try {
    statSync(dir);
    return true;
  } catch (error) {
    const refusal = rootListingRefusal(error, dir);
    if (refusal !== undefined) unreadable.push(refusal);
    return false;
  }
}


/**
 * Scan user-level Claude directories for skills and plugins
 *
 * Scans:
 * - ~/.claude/plugins for SKILL.md and .claude-plugin directories
 * - ~/.claude/skills for SKILL.md files
 * - ~/.claude/marketplaces (reserved for future use)
 *
 * Returns empty arrays if directories don't exist (not an error). A root the
 * OS will not let the process `stat` is not absent: it is in `unreadable`.
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
  if (rootToScan(pluginsDir, unreadable)) {
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
  if (rootToScan(skillsDir, unreadable)) {
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
