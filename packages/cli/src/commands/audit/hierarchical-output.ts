import * as os from 'node:os';

import type { ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import {
  calculateValidationStatus,
  countBySeverity,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { issueLocation, toForwardSlash } from '@vibe-agent-toolkit/utils';

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
  /** Path relative to the run root stated once at the top of the report. */
  path: string;
  status: 'success' | 'warning' | 'error';
  issues: ValidationIssue[];
  cacheStatus?: CacheStatus;
}

interface ParsedSkillPath {
  marketplace?: string;
  plugin?: string;
  skill: string;
  isCached: boolean;
  /**
   * The logical resource a cached copy and its installed source SHARE, unique
   * within one report.
   *
   * The bare skill name is not it. Two marketplaces routinely ship a skill of
   * the same name — a real `--user` scan produced 93 such collisions across two
   * marketplaces alone — so a bare-name index keeps only whichever result was
   * seen last and then compares every cache copy against a stranger. Identical
   * copies read as `stale`; genuinely drifted ones can read as `fresh` and be
   * dropped from the report entirely.
   *
   * When no plugin can be identified, the skill's own directory is used: nothing
   * else can share it, so such a result matches only itself. Nothing is lost —
   * every cached path carries a marketplace and plugin, so a plugin-less source
   * was never a candidate for cache matching in the first place.
   */
  identity: string;
}

/** Build {@link ParsedSkillPath.identity} from the parsed segments. */
function skillIdentity(
  parts: string[],
  marketplace: string | undefined,
  plugin: string | undefined,
  skill: string,
): string {
  if (plugin === undefined) {
    return parts.slice(0, -1).join('/');
  }
  return `${marketplace ?? ''}/${plugin}/${skill}`;
}

function parsed(
  parts: string[],
  skill: string,
  isCached: boolean,
  marketplace?: string,
  plugin?: string,
): ParsedSkillPath {
  const out: ParsedSkillPath = {
    skill,
    isCached,
    identity: skillIdentity(parts, marketplace, plugin, skill),
  };
  if (marketplace !== undefined) out.marketplace = marketplace;
  if (plugin !== undefined) out.plugin = plugin;
  return out;
}

/**
 * Parse path structure to extract marketplace, plugin, and skill names
 *
 * Expected patterns:
 * - Cached plugin skill: .../plugins/cache/{marketplace}/{plugin}/{version}/skills/{skill}/SKILL.md
 * - Marketplace plugin skill: .../marketplaces/{marketplace}/[plugins/]{plugin}/skills/{skill}/SKILL.md
 * - Standalone plugin skill (in plugins dir): .../plugins/{plugin}/skills/{skill}/SKILL.md (no marketplaces/)
 * - Skill-claude-plugin: .../plugins/{skill}/SKILL.md (root SKILL.md + .claude-plugin/plugin.json, no skills/ subdir)
 * - Standalone skill (in skills dir): ~/.claude/skills/{skill}/SKILL.md
 *
 * The plugin is read as the segment immediately BEFORE `skills/`, not as a fixed
 * offset from `marketplaces/`. Claude Code's installed layout carries an extra
 * `plugins/` segment between the marketplace and the plugin
 * (`marketplaces/{marketplace}/plugins/{plugin}/skills/...`), so the fixed offset
 * named every group `plugins`; the offset only looked right against fixtures that
 * omitted that segment.
 */
function parsePathStructure(filePath: string): ParsedSkillPath {
  // Normalize to forward slashes for cross-platform parsing
  const normalizedPath = toForwardSlash(filePath);
  const parts = normalizedPath.split('/');

  // Detect if this is a cached resource
  const cacheIdx = parts.indexOf('cache');
  const isCached = cacheIdx >= 0;

  // Find key indices
  const marketplacesIdx = parts.indexOf('marketplaces');
  const pluginsIdx = parts.indexOf('plugins');
  const skillsIdx = parts.indexOf('skills');

  // Cached plugin skill: .../cache/{marketplace}/{plugin}/{version}/skills/{skill}/SKILL.md
  // The marketplace and plugin are named here, which is what lets a cached copy
  // be matched against its own source rather than a same-named stranger.
  if (isCached && skillsIdx > cacheIdx) {
    const marketplace = parts[cacheIdx + 1];
    const plugin = parts[cacheIdx + 2];
    const skill = parts[skillsIdx + 1];
    if (marketplace !== undefined && plugin !== undefined && skill !== undefined) {
      return parsed(parts, skill, isCached, marketplace, plugin);
    }
  }

  // Marketplace plugin skill: .../marketplaces/{marketplace}/[plugins/]{plugin}/skills/{skill}/SKILL.md
  if (marketplacesIdx >= 0 && skillsIdx > marketplacesIdx) {
    const marketplace = parts[marketplacesIdx + 1];
    const plugin = parts[skillsIdx - 1];
    const skill = parts[skillsIdx + 1];
    if (marketplace !== undefined && plugin !== undefined && skill !== undefined) {
      return parsed(parts, skill, isCached, marketplace, plugin);
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
      return parsed(parts, skill, isCached);
    }
  }

  // Fallback: use directory name before SKILL.md
  const skill = parts.at(-2) ?? 'unknown';
  return parsed(parts, skill, isCached);
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
): ParsedSkillPath {
  // Standalone plugin skill: .../plugins/{plugin}/skills/{skill}/SKILL.md
  if (skillsIdx >= 0) {
    const plugin = parts[skillsIdx - 1]; // Plugin name is before /skills/
    const skill = parts[skillsIdx + 1];
    if (plugin !== undefined && skill !== undefined) {
      return parsed(parts, skill, isCached, undefined, plugin);
    }
  }

  // Skill-claude-plugin: .../plugins/{skill}/SKILL.md (root SKILL.md + .claude-plugin/plugin.json, no /skills/ subdir)
  const skill = parts[pluginsIdx + 1];
  if (skill !== undefined) {
    return parsed(parts, skill, isCached);
  }

  // Fallback
  return parsed(parts, 'unknown', isCached);
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
  const sourceByIdentity = new Map<string, ValidationResult>();
  const cacheResults: ValidationResult[] = [];
  const nonCacheResults: ValidationResult[] = [];
  const cacheStatusMap = new Map<string, 'stale' | 'orphaned' | 'fresh'>();

  // First pass: categorize results and build source index
  for (const result of results) {
    const { identity, isCached } = parsePathStructure(result.path);

    if (isCached) {
      cacheResults.push(result);
    } else {
      nonCacheResults.push(result);
      // Index source results by marketplace/plugin/skill identity — see
      // ParsedSkillPath.identity for why the bare skill name cannot be the key.
      sourceByIdentity.set(identity, result);
    }
  }

  // Second pass: filter cache results and track status
  const filteredCache: ValidationResult[] = [];
  for (const cacheResult of cacheResults) {
    const { identity } = parsePathStructure(cacheResult.path);
    const sourceResult = sourceByIdentity.get(identity);

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
  cacheStatusMap: Map<string, CacheStatus>,
  locationRoot: string,
): SkillEntry {
  const { skill, isCached } = parsePathStructure(result.path);

  const entry: SkillEntry = {
    name: skill,
    path: issueLocation(result.path, locationRoot),
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
  location: ParsedSkillPath,
  maps: CategoryMaps
): void {
  const { marketplace, plugin, isCached } = location;
  // Cached first: a cached path now names its marketplace too (that is what makes
  // cache/source matching correct), so testing `marketplace` first would fold the
  // whole cache into the marketplace tree and empty the `cachedPlugins` section.
  if (isCached && plugin !== undefined) {
    addToCachedPluginMap(maps.cachedPluginsMap, plugin, entry);
  } else if (marketplace !== undefined && plugin !== undefined) {
    addToMarketplaceMap(maps.marketplacesMap, marketplace, plugin, entry);
  } else if (plugin === undefined) {
    maps.standaloneSkills.push(entry);
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
 * @param locationRoot - Run root the emitted `location` is expressed relative to
 * @returns Results with misconfiguration issues added
 */
function addMisconfigurationIssues(results: ValidationResult[], locationRoot: string): ValidationResult[] {
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
      location: issueLocation(result.path, locationRoot),
      fix: 'Move to ~/.claude/skills/ for standalone skills, or add .claude-plugin/plugin.json for a proper plugin',
    };

    // Clone result and add issue. The status and the counts are DERIVED from the
    // new issue list by the one shared collapse — never hand-set — so they cannot
    // drift from the findings they describe.
    const issues = [...result.issues, misconfigIssue];
    return {
      ...result,
      status: calculateValidationStatus(issues),
      issueCounts: countBySeverity(issues),
      issues,
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
 * @param locationRoot - The run's single stated root. Every emitted `path` and
 *   issue `location` is expressed relative to it, so one report never mixes
 *   coordinate systems across the three `--user` scan directories.
 * @returns Hierarchical structure for display
 */
export function buildHierarchicalOutput(
  results: ValidationResult[],
  verbose: boolean,
  locationRoot: string,
): HierarchicalOutput {
  // Filter out cache duplicates that match their source
  const { filtered: filteredResults, cacheStatusMap } = filterCacheDuplicates(results);

  // Add misconfiguration detection to results BEFORE verbose filtering
  const resultsWithMisconfigDetection = addMisconfigurationIssues(filteredResults, locationRoot);

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
    // Only include results with issues (terse principle), unless verbose mode.
    //
    // Keyed on the ISSUE COUNT, never on the status. A status names the worst
    // ACTIONABLE severity, so an info-only result is `success` — keying this on
    // `status === 'success'` deleted every info-only skill from the report while
    // the summary went on counting its findings (a real `--user` scan hid 167
    // info findings across 128 skills that way).
    if (!verbose && result.issues.length === 0) {
      continue;
    }

    const entry = createSkillEntry(result, cacheStatusMap, locationRoot);
    categorizeEntry(entry, parsePathStructure(result.path), maps);
  }

  return {
    marketplaces: convertMarketplacesMapToArray(marketplacesMap),
    cachedPlugins: convertPluginMapToArray(cachedPluginsMap),
    standalonePlugins: convertPluginMapToArray(standalonePluginsMap),
    standaloneSkills,
  };
}
