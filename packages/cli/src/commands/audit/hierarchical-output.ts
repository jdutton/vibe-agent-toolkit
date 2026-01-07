import * as os from 'node:os';

import type { ValidationIssue, ValidationResult } from '@vibe-agent-toolkit/runtime-claude-skills';
import { toUnixPath } from '@vibe-agent-toolkit/utils';

export interface HierarchicalOutput {
  marketplaces: MarketplaceGroup[];
  standalonePlugins: PluginGroup[];
  standaloneSkills: SkillEntry[];
}

export interface MarketplaceGroup {
  name: string;
  plugins: PluginGroup[];
}

export interface PluginGroup {
  name: string;
  skills: SkillEntry[];
}

export interface SkillEntry {
  name: string;
  path: string;
  status: 'success' | 'warning' | 'error';
  issues: ValidationIssue[];
}

/**
 * Replace home directory with ~ for cleaner paths
 * Normalizes paths for cross-platform comparison (handles Windows backslashes)
 */
function replaceHomeDir(filePath: string): string {
  const homeDir = os.homedir();

  // Normalize both paths to forward slashes for comparison
  const normalizedFilePath = toUnixPath(filePath);
  const normalizedHomeDir = toUnixPath(homeDir);

  if (normalizedFilePath.startsWith(normalizedHomeDir)) {
    // Replace using original paths to preserve platform separators in output
    return filePath.replace(homeDir, '~');
  }
  return filePath;
}

/**
 * Parse path structure to extract marketplace, plugin, and skill names
 *
 * Expected patterns:
 * - Marketplace plugin skill: .../marketplaces/{marketplace}/{plugin}/skills/{skill}/SKILL.md
 * - Standalone plugin skill: .../plugins/{plugin}/skills/{skill}/SKILL.md (no marketplaces/)
 * - Standalone skill: .../plugins/{skill}/SKILL.md (no skills/)
 */
function parsePathStructure(filePath: string): {
  marketplace?: string;
  plugin?: string;
  skill: string;
} {
  // Normalize to forward slashes for cross-platform parsing
  const normalizedPath = toUnixPath(filePath);
  const parts = normalizedPath.split('/');

  // Find key indices
  const marketplacesIdx = parts.indexOf('marketplaces');
  const pluginsIdx = parts.indexOf('plugins');
  const skillsIdx = parts.indexOf('skills');

  // Marketplace plugin skill: .../marketplaces/{marketplace}/{plugin}/skills/{skill}/SKILL.md
  if (marketplacesIdx >= 0 && skillsIdx >= 0) {
    const marketplace = parts[marketplacesIdx + 1];
    const plugin = parts[marketplacesIdx + 2];
    const skill = parts[skillsIdx + 1];
    if (marketplace !== undefined && plugin !== undefined && skill !== undefined) {
      return { marketplace, plugin, skill };
    }
  }

  // Standalone plugin skill: .../plugins/{plugin}/skills/{skill}/SKILL.md
  if (pluginsIdx >= 0 && skillsIdx >= 0) {
    const plugin = parts[skillsIdx - 1]; // Plugin name is before /skills/
    const skill = parts[skillsIdx + 1];
    if (plugin !== undefined && skill !== undefined) {
      return { plugin, skill };
    }
  }

  // Standalone skill: .../plugins/{skill}/SKILL.md
  if (pluginsIdx >= 0) {
    const skill = parts[pluginsIdx + 1];
    if (skill !== undefined) {
      return { skill };
    }
  }

  // Fallback: use directory name before SKILL.md
  const skill = parts.at(-2) ?? 'unknown';
  return { skill };
}

/**
 * Add skill entry to marketplace map
 */
function addToMarketplaceMap(
  marketplacesMap: Map<string, Map<string, SkillEntry[]>>,
  marketplace: string,
  plugin: string,
  entry: SkillEntry
): void {
  if (!marketplacesMap.has(marketplace)) {
    marketplacesMap.set(marketplace, new Map());
  }
  const pluginsMap = marketplacesMap.get(marketplace);
  if (pluginsMap === undefined) {
    return;
  }

  if (!pluginsMap.has(plugin)) {
    pluginsMap.set(plugin, []);
  }
  pluginsMap.get(plugin)?.push(entry);
}

/**
 * Add skill entry to standalone plugin map
 */
function addToStandalonePluginMap(
  standalonePluginsMap: Map<string, SkillEntry[]>,
  plugin: string,
  entry: SkillEntry
): void {
  if (!standalonePluginsMap.has(plugin)) {
    standalonePluginsMap.set(plugin, []);
  }
  standalonePluginsMap.get(plugin)?.push(entry);
}

/**
 * Build hierarchical output structure from validation results.
 *
 * Groups skills by:
 * 1. Marketplace -> Plugin -> Skills (for marketplace-installed plugins)
 * 2. Standalone Plugins -> Skills (for non-marketplace plugins)
 * 3. Standalone Skills (for skills without plugins)
 *
 * Only includes skills with issues (terse principle).
 * Replaces home directory with ~ for cleaner display.
 *
 * @param results - Validation results from audit command
 * @returns Hierarchical structure for display
 */
export function buildHierarchicalOutput(results: ValidationResult[]): HierarchicalOutput {
  const marketplacesMap = new Map<string, Map<string, SkillEntry[]>>();
  const standalonePluginsMap = new Map<string, SkillEntry[]>();
  const standaloneSkills: SkillEntry[] = [];

  for (const result of results) {
    // Only include results with issues (terse principle)
    if (result.status === 'success') {
      continue;
    }

    const { marketplace, plugin, skill } = parsePathStructure(result.path);

    const entry: SkillEntry = {
      name: skill,
      path: replaceHomeDir(result.path),
      status: result.status,
      issues: result.issues,
    };

    if (marketplace !== undefined && plugin !== undefined) {
      // Marketplace plugin skill
      addToMarketplaceMap(marketplacesMap, marketplace, plugin, entry);
    } else if (plugin === undefined) {
      // Standalone skill
      standaloneSkills.push(entry);
    } else {
      // Standalone plugin skill
      addToStandalonePluginMap(standalonePluginsMap, plugin, entry);
    }
  }

  // Convert maps to arrays
  const marketplaces: MarketplaceGroup[] = [];
  for (const [marketplaceName, pluginsMap] of marketplacesMap) {
    const plugins: PluginGroup[] = [];
    for (const [pluginName, skills] of pluginsMap) {
      plugins.push({ name: pluginName, skills });
    }
    marketplaces.push({ name: marketplaceName, plugins });
  }

  const standalonePlugins: PluginGroup[] = [];
  for (const [pluginName, skills] of standalonePluginsMap) {
    standalonePlugins.push({ name: pluginName, skills });
  }

  return { marketplaces, standalonePlugins, standaloneSkills };
}
