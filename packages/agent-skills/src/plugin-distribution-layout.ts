/**
 * Plugin distribution layout helpers.
 *
 * Shared primitives for locating where `vat build --only claude` places
 * tree-copied plugin skills in the output tree, and where it reads them from.
 *
 * Consumed by `vat build`, `vat verify`, and consistency-check so the path
 * conventions can never drift between those commands.
 */

import { existsSync, readdirSync } from 'node:fs';

import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';

/**
 * Absolute path to the built plugin output directory.
 *
 * Shape: `<configDir>/dist/.claude/plugins/marketplaces/<mp>/plugins/<name>/`
 *
 * Extracted verbatim from build.ts lines 577–580 so that build can later adopt
 * this helper with zero behavior change.
 */
export function getPluginOutputDir(
  configDir: string,
  marketplaceName: string,
  pluginName: string,
): string {
  return safePath.join(
    configDir,
    'dist',
    '.claude',
    'plugins',
    'marketplaces',
    marketplaceName,
    'plugins',
    pluginName,
  );
}

/**
 * Absolute path to the plugin source directory.
 *
 * Resolves to `<configDir>/<plugin.source>` when the plugin declares a custom
 * source, otherwise `<configDir>/plugins/<plugin.name>`.
 *
 * Extracted verbatim from build.ts lines 581–584.
 */
export function getPluginSourceDir(
  configDir: string,
  plugin: { name: string; source?: string | undefined },
): string {
  return safePath.join(
    configDir,
    plugin.source ?? safePath.join('plugins', plugin.name),
  );
}

/**
 * Names of immediate skill subdirectories under `<pluginSourceDir>/skills/`.
 *
 * Returns `[]` when the `skills/` directory does not exist (pool-only plugin).
 * Non-directory entries (files, symlinks, …) are silently skipped.
 *
 * Mirrors `listSubdirectories` in install.ts.
 */
export function listPluginSourceSkillDirs(pluginSourceDir: string): string[] {
  const skillsDir = safePath.join(pluginSourceDir, 'skills');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller validates pluginSourceDir
  if (!existsSync(skillsDir)) return [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller validates pluginSourceDir
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

/** Location of a single skill shipped via source tree-copy. */
export interface DistributedSkillLocation {
  /** Name of the marketplace this skill ships through. */
  marketplaceName: string;
  /** Name of the plugin that contains this skill. */
  pluginName: string;
  /** Directory name under the plugin's `skills/` source dir (also the skill fs path segment). */
  skillDirName: string;
  /** Absolute output path where `vat build` places the skill: `getPluginOutputDir(...)/skills/<skillDirName>`. */
  skillOutputDir: string;
}

/**
 * Every skill shipped via source tree-copy across all marketplaces in the
 * config, paired with the output directory where `vat build` places it.
 *
 * Pool-only plugins — those whose source `skills/` directory is absent on disk
 * — contribute nothing to the result.
 */
export function computeTreeCopiedSkillLocations(
  config: ProjectConfig,
  configDir: string,
): DistributedSkillLocation[] {
  const locations: DistributedSkillLocation[] = [];

  const marketplaces = config.claude?.marketplaces;
  if (!marketplaces) return locations;

  for (const [marketplaceName, marketplace] of Object.entries(marketplaces)) {
    for (const plugin of marketplace.plugins) {
      const pluginSourceDir = getPluginSourceDir(configDir, plugin);
      const skillDirNames = listPluginSourceSkillDirs(pluginSourceDir);
      if (skillDirNames.length === 0) continue;

      const pluginOutputDir = getPluginOutputDir(configDir, marketplaceName, plugin.name);
      for (const skillDirName of skillDirNames) {
        locations.push({
          marketplaceName,
          pluginName: plugin.name,
          skillDirName,
          skillOutputDir: safePath.join(pluginOutputDir, 'skills', skillDirName),
        });
      }
    }
  }

  return locations;
}
