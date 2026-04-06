/**
 * Plugin list — enumerate locally installed plugins and legacy skills.
 *
 * Reads from:
 * - installed_plugins.json: VAT-managed plugins
 * - known_marketplaces.json: marketplace source metadata
 * - skillsDir (~/.claude/skills): legacy skills (symlinks or directories)
 */

import { existsSync, lstatSync, readdirSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { ClaudeUserPaths } from '../paths/claude-paths.js';

import { readInstalledPlugins, readKnownMarketplaces } from './plugin-registry.js';

export interface ListedPlugin {
  name: string;
  marketplace: string;
  version: string;
  installedAt: string;
  source: 'npm' | 'github' | 'url' | 'hostPattern';
}

export interface ListedLegacySkill {
  name: string;
  path: string;
  type: 'symlink' | 'directory';
}

export interface PluginListResult {
  /** Count of plugins found in installed_plugins.json */
  pluginRegistry: number;
  /** Count of legacy skills found in skillsDir */
  legacySkillsDir: number;
  plugins: ListedPlugin[];
  legacySkills: ListedLegacySkill[];
}

/**
 * List all locally installed plugins and legacy skills.
 *
 * Reads installed_plugins.json for VAT-managed plugins and enumerates
 * ~/.claude/skills for legacy manually-installed skills.
 */
export function listLocalPlugins(paths: ClaudeUserPaths): PluginListResult {
  const plugins = collectPlugins(paths);
  const legacySkills = collectLegacySkills(paths);

  return {
    pluginRegistry: plugins.length,
    legacySkillsDir: legacySkills.length,
    plugins,
    legacySkills,
  };
}

function collectPlugins(paths: ClaudeUserPaths): ListedPlugin[] {
  const plugins: ListedPlugin[] = [];
  const installedPlugins = readInstalledPlugins(paths);
  const knownMarketplaces = readKnownMarketplaces(paths);

  for (const [pluginKey, entries] of Object.entries(installedPlugins.plugins)) {
    const atIdx = pluginKey.lastIndexOf('@');
    // Skip malformed keys where '@' is missing or at position 0 (no name before it)
    if (atIdx <= 0) continue;

    const name = pluginKey.slice(0, atIdx);
    const marketplace = pluginKey.slice(atIdx + 1);
    const entry = entries[0];
    if (!entry) continue;

    const marketplaceEntry = knownMarketplaces[marketplace];
    const source = marketplaceEntry?.source.source ?? 'npm';

    plugins.push({ name, marketplace, version: entry.version, installedAt: entry.installedAt, source });
  }

  return plugins;
}

function collectLegacySkills(paths: ClaudeUserPaths): ListedLegacySkill[] {
  const legacySkills: ListedLegacySkill[] = [];

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths from ClaudeUserPaths
  if (!existsSync(paths.skillsDir)) return legacySkills;

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths from ClaudeUserPaths
    const entries = readdirSync(paths.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillPath = safePath.join(paths.skillsDir, entry.name);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated path
      const stat = lstatSync(skillPath);
      legacySkills.push({
        name: entry.name,
        path: skillPath,
        type: stat.isSymbolicLink() ? 'symlink' : 'directory',
      });
    }
  } catch {
    // skillsDir may be unreadable (permissions, broken symlink, concurrent deletion).
    // Legacy skill enumeration is best-effort — a failure here must not break `vat plugins list`.
    // Return whatever entries were collected before the error.
  }

  return legacySkills;
}
