import * as os from 'node:os';

import type { ValidationIssue, ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import { toForwardSlash } from '@vibe-agent-toolkit/utils';

export interface HierarchicalOutput {
  marketplaces: MarketplaceGroup[];
  cachedPlugins: PluginGroup[];
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

export type CacheStatus = 'stale' | 'orphaned' | 'fresh';

export interface SkillEntry {
  name: string;
  path: string;
  status: 'success' | 'warning' | 'error';
  issues: ValidationIssue[];
  cacheStatus?: CacheStatus;
}

/**
 * Replace home directory with ~ for cleaner paths
 * Normalizes paths for cross-platform comparison (handles Windows backslashes)
 */
function replaceHomeDir(filePath: string): string {
  const homeDir = os.homedir();

  // Normalize both paths to forward slashes for comparison
  const normalizedFilePath = toForwardSlash(filePath);
  const normalizedHomeDir = toForwardSlash(homeDir);

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
 * - Standalone plugin skill (in plugins dir): .../plugins/{plugin}/skills/{skill}/SKILL.md (no marketplaces/)
 * - Standalone plugin skill (no skills subdir): .../plugins/{skill}/SKILL.md (no skills/)
 * - Standalone skill (in skills dir): ~/.claude/skills/{skill}/SKILL.md
 */
function parsePathStructure(filePath: string): {
  marketplace?: string;
  plugin?: string;
  skill: string;
  isCached: boolean;
} {
  // Normalize to forward slashes for cross-platform parsing
  const normalizedPath = toForwardSlash(filePath);
  const parts = normalizedPath.split('/');

  // Detect if this is a cached resource
  const isCached = parts.includes('cache');

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
      return { marketplace, plugin, skill, isCached };
    }
  }

  // Plugin-related patterns (requires /plugins/ in path)
  if (pluginsIdx >= 0) {
    return parsePluginPath(parts, pluginsIdx, skillsIdx, isCached);
  }

  // Standalone skill in skills dir: ~/.claude/skills/{skill}/SKILL.md
  // This is the standard location for standalone skills (not in a plugin)
  if (skillsIdx >= 0) {
    const skill = parts[skillsIdx + 1];
    if (skill !== undefined) {
      return { skill, isCached };
    }
  }

  // Fallback: use directory name before SKILL.md
  const skill = parts.at(-2) ?? 'unknown';
  return { skill, isCached };
}

/**
 * Parse plugin-related paths
 * Handles both: .../plugins/{plugin}/skills/{skill}/SKILL.md and .../plugins/{skill}/SKILL.md
 */
function parsePluginPath(
  parts: string[],
  pluginsIdx: number,
  skillsIdx: number,
  isCached: boolean
): { plugin?: string; skill: string; isCached: boolean } {
  // Standalone plugin skill: .../plugins/{plugin}/skills/{skill}/SKILL.md
  if (skillsIdx >= 0) {
    const plugin = parts[skillsIdx - 1]; // Plugin name is before /skills/
    const skill = parts[skillsIdx + 1];
    if (plugin !== undefined && skill !== undefined) {
      return { plugin, skill, isCached };
    }
  }

  // Standalone skill in plugins dir: .../plugins/{skill}/SKILL.md (no /skills/ subdir)
  const skill = parts[pluginsIdx + 1];
  if (skill !== undefined) {
    return { skill, isCached };
  }

  // Fallback
  return { skill: 'unknown', isCached };
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
 * Add skill entry to cached plugin map
 */
function addToCachedPluginMap(
  cachedPluginsMap: Map<string, SkillEntry[]>,
  plugin: string,
  entry: SkillEntry
): void {
  if (!cachedPluginsMap.has(plugin)) {
    cachedPluginsMap.set(plugin, []);
  }
  cachedPluginsMap.get(plugin)?.push(entry);
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
 * Filter out duplicate cache results that match their source
 *
 * Suppresses cache entries when:
 * - A matching source (marketplace/plugin) exists
 * - Same validation status (success/warning/error)
 * - Same issues (count and content)
 *
 * Keeps cache entries when:
 * - No matching source found (orphaned cache)
 * - Different validation status or issues (stale/different)
 *
 * @returns Filtered results and cache status map
 */
function filterCacheDuplicates(results: ValidationResult[]): {
  filtered: ValidationResult[];
  cacheStatusMap: Map<string, 'stale' | 'orphaned' | 'fresh'>;
} {
  const sourceBySkillName = new Map<string, ValidationResult>();
  const cacheResults: ValidationResult[] = [];
  const nonCacheResults: ValidationResult[] = [];
  const cacheStatusMap = new Map<string, 'stale' | 'orphaned' | 'fresh'>();

  // First pass: categorize results and build source index
  for (const result of results) {
    const { skill, isCached } = parsePathStructure(result.path);

    if (isCached) {
      cacheResults.push(result);
    } else {
      nonCacheResults.push(result);
      // Index source results by skill name for matching
      sourceBySkillName.set(skill, result);
    }
  }

  // Second pass: filter cache results and track status
  const filteredCache: ValidationResult[] = [];
  for (const cacheResult of cacheResults) {
    const { skill } = parsePathStructure(cacheResult.path);
    const sourceResult = sourceBySkillName.get(skill);

    if (!sourceResult) {
      // Orphaned cache - no matching source, keep it
      filteredCache.push(cacheResult);
      cacheStatusMap.set(cacheResult.path, 'orphaned');
      continue;
    }

    // Check if cache and source have identical validation results
    const statusMatches = cacheResult.status === sourceResult.status;
    const issuesMatch =
      cacheResult.issues.length === sourceResult.issues.length &&
      cacheResult.issues.every((issue, idx) =>
        issue.code === sourceResult.issues[idx]?.code &&
        issue.severity === sourceResult.issues[idx]?.severity
      );

    if (!statusMatches || !issuesMatch) {
      // Different validation results - keep both (stale or different)
      filteredCache.push(cacheResult);
      cacheStatusMap.set(cacheResult.path, 'stale');
    } else {
      // Fresh cache - matches source, will be suppressed
      cacheStatusMap.set(cacheResult.path, 'fresh');
    }
    // If they match exactly, suppress the cache copy (don't add to filteredCache)
  }

  return {
    filtered: [...nonCacheResults, ...filteredCache],
    cacheStatusMap,
  };
}

/**
 * Create skill entry from validation result
 */
function createSkillEntry(
  result: ValidationResult,
  cacheStatusMap: Map<string, CacheStatus>
): SkillEntry {
  const { skill, isCached } = parsePathStructure(result.path);

  const entry: SkillEntry = {
    name: skill,
    path: replaceHomeDir(result.path),
    status: result.status,
    issues: result.issues,
  };

  // Add cache status if this is a cached resource
  if (isCached) {
    const cacheStatus = cacheStatusMap.get(result.path);
    if (cacheStatus !== undefined) {
      entry.cacheStatus = cacheStatus;
    }
  }

  return entry;
}

interface CategoryMaps {
  marketplacesMap: Map<string, Map<string, SkillEntry[]>>;
  cachedPluginsMap: Map<string, SkillEntry[]>;
  standalonePluginsMap: Map<string, SkillEntry[]>;
  standaloneSkills: SkillEntry[];
}

/**
 * Categorize entry into appropriate map
 */
function categorizeEntry(
  entry: SkillEntry,
  marketplace: string | undefined,
  plugin: string | undefined,
  isCached: boolean,
  maps: CategoryMaps
): void {
  if (marketplace !== undefined && plugin !== undefined) {
    addToMarketplaceMap(maps.marketplacesMap, marketplace, plugin, entry);
  } else if (plugin === undefined) {
    maps.standaloneSkills.push(entry);
  } else if (isCached) {
    addToCachedPluginMap(maps.cachedPluginsMap, plugin, entry);
  } else {
    addToStandalonePluginMap(maps.standalonePluginsMap, plugin, entry);
  }
}

/**
 * Convert marketplace map to array structure
 */
function convertMarketplacesMapToArray(
  marketplacesMap: Map<string, Map<string, SkillEntry[]>>
): MarketplaceGroup[] {
  const marketplaces: MarketplaceGroup[] = [];
  for (const [marketplaceName, pluginsMap] of marketplacesMap) {
    const plugins: PluginGroup[] = [];
    for (const [pluginName, skills] of pluginsMap) {
      plugins.push({ name: pluginName, skills });
    }
    marketplaces.push({ name: marketplaceName, plugins });
  }
  return marketplaces;
}

/**
 * Convert plugin map to array structure
 */
function convertPluginMapToArray(pluginMap: Map<string, SkillEntry[]>): PluginGroup[] {
  const plugins: PluginGroup[] = [];
  for (const [pluginName, skills] of pluginMap) {
    plugins.push({ name: pluginName, skills });
  }
  return plugins;
}

/**
 * Add misconfiguration issues to standalone skills in wrong locations
 *
 * Detects standalone SKILL.md files in ~/.claude/plugins/ that won't be recognized
 * by Claude Code. These should be either moved to ~/.claude/skills/ or properly
 * configured as plugins with .claude-plugin/plugin.json.
 *
 * @param results - Validation results to check
 * @returns Results with misconfiguration issues added
 */
function addMisconfigurationIssues(results: ValidationResult[]): ValidationResult[] {
  const homeDir = toForwardSlash(os.homedir());
  const pluginsPath = `${homeDir}/.claude/plugins/`;

  return results.map((result) => {
    const { marketplace, plugin, isCached } = parsePathStructure(result.path);

    // Only check standalone skills (no marketplace, no plugin structure)
    if (marketplace || plugin || isCached) {
      return result; // Not a standalone skill, leave unchanged
    }

    // Check if this standalone skill is in the plugins directory
    const normalizedPath = toForwardSlash(result.path);
    if (!normalizedPath.startsWith(pluginsPath)) {
      return result; // Not in plugins dir, leave unchanged
    }

    // This is a standalone SKILL.md in ~/.claude/plugins/ - add misconfiguration issue
    const misconfigIssue: ValidationIssue = {
      severity: 'error',
      code: 'SKILL_MISCONFIGURED_LOCATION',
      message: 'Standalone skill in plugins directory won\'t be recognized by Claude Code',
      location: result.path,
      fix: 'Move to ~/.claude/skills/ for standalone skills, or add .claude-plugin/plugin.json for a proper plugin',
    };

    // Clone result and add issue
    return {
      ...result,
      status: 'error', // Upgrade to error
      issues: [...result.issues, misconfigIssue],
    };
  });
}

/**
 * Build hierarchical output structure from validation results.
 *
 * Groups skills by:
 * 1. Marketplace -> Plugin -> Skills (for marketplace-installed plugins)
 * 2. Standalone Plugins -> Skills (for non-marketplace plugins)
 * 3. Standalone Skills (for skills without plugins)
 *
 * By default, only includes skills with issues (terse principle).
 * With verbose=true, includes all scanned skills regardless of status.
 * Replaces home directory with ~ for cleaner display.
 *
 * @param results - Validation results from audit command
 * @param verbose - If true, include all results; if false, only show results with issues
 * @returns Hierarchical structure for display
 */
export function buildHierarchicalOutput(results: ValidationResult[], verbose: boolean = false): HierarchicalOutput {
  // Filter out cache duplicates that match their source
  const { filtered: filteredResults, cacheStatusMap } = filterCacheDuplicates(results);

  // Add misconfiguration detection to results BEFORE verbose filtering
  const resultsWithMisconfigDetection = addMisconfigurationIssues(filteredResults);

  const marketplacesMap = new Map<string, Map<string, SkillEntry[]>>();
  const cachedPluginsMap = new Map<string, SkillEntry[]>();
  const standalonePluginsMap = new Map<string, SkillEntry[]>();
  const standaloneSkills: SkillEntry[] = [];

  const maps: CategoryMaps = {
    marketplacesMap,
    cachedPluginsMap,
    standalonePluginsMap,
    standaloneSkills,
  };

  for (const result of resultsWithMisconfigDetection) {
    // Only include results with issues (terse principle), unless verbose mode
    if (!verbose && result.status === 'success') {
      continue;
    }

    const { marketplace, plugin, isCached } = parsePathStructure(result.path);
    const entry = createSkillEntry(result, cacheStatusMap);
    categorizeEntry(entry, marketplace, plugin, isCached, maps);
  }

  return {
    marketplaces: convertMarketplacesMapToArray(marketplacesMap),
    cachedPlugins: convertPluginMapToArray(cachedPluginsMap),
    standalonePlugins: convertPluginMapToArray(standalonePluginsMap),
    standaloneSkills,
  };
}
