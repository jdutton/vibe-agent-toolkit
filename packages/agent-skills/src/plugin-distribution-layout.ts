/**
 * Plugin distribution layout helpers.
 *
 * Shared primitives for locating where `vat build --only claude` places
 * tree-copied plugin skills in the output tree, and where it reads them from.
 *
 * Consumed by `vat build`, `vat verify`, and consistency-check so the path
 * conventions can never drift between those commands.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { crawlDirectorySync, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

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
 * Every plugin-local SKILL DIRECTORY under `<pluginSourceDir>/skills/`, as a
 * forward-slash path relative to that `skills/` dir (`my-skill`,
 * `group/nested-skill`).
 *
 * Three properties, each of which a previous shape got wrong and shipped a bug:
 *
 * 1. **A skill is a directory holding a `SKILL.md`** — not "any immediate
 *    subdirectory of `skills/`". A `shared/` helper dir, a `_templates/` dir, or
 *    the mere PARENT of a nested skill is not a skill; it has no packager, so the
 *    plugin build's verbatim tree-copy is its only route into the bundle and it
 *    must not appear here.
 * 2. **Recursive.** Claude Code discovers `skills/<group>/<skill>/SKILL.md`, so
 *    VAT must too. A non-recursive listing left every nested plugin-local skill
 *    to the verbatim tree-copy — shipping its eval suite (answer key included),
 *    scratch files, and un-rewritten links, and producing it a SECOND time when
 *    the same skill was also selected from the pool.
 * 3. **Same file visibility as the tree-copy** (`crawlDirectorySync` with
 *    `respectGitignore`, i.e. tracked files only inside a git repo). The two
 *    producers of a plugin's `skills/` tree must agree on which files exist at
 *    all; a `readdirSync` listing saw gitignored/untracked skill directories the
 *    tree-copy would never have shipped, and packaged them into the published
 *    marketplace bundle.
 *
 * A skill nested INSIDE another skill (`a/SKILL.md` and `a/b/SKILL.md`) yields
 * only the outermost (`a`): the inner dir is part of the outer skill's own tree,
 * and packaging both would have the inner packager write into a directory the
 * outer packager owns.
 *
 * Returns `[]` when the `skills/` directory does not exist (pool-only plugin).
 */
export function listPluginSourceSkillDirs(pluginSourceDir: string): string[] {
  const skillsDir = safePath.join(pluginSourceDir, 'skills');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller validates pluginSourceDir
  if (!existsSync(skillsDir)) return [];

  // `exclude: []` (not the crawler's default) and `dot: true` so this sees exactly
  // what treeCopyPlugin sees — the only filter either applies is git visibility.
  const skillFiles = crawlDirectorySync({
    baseDir: skillsDir,
    include: ['**/SKILL.md'],
    exclude: [],
    absolute: false,
    filesOnly: true,
    respectGitignore: true,
    dot: true,
  });

  const dirs = skillFiles
    .map((rel) => toForwardSlash(dirname(rel)))
    // `dirname` of a bare `SKILL.md` is `.`: a skill file directly in `skills/` would
    // make the whole tree one skill, which is not a layout VAT recognizes and would
    // swallow every sibling.
    .filter((dir) => dir !== '.' && dir !== '')
    // Lexicographic order puts a parent immediately before its own descendants (a
    // proper prefix always sorts first), which is all the outermost-wins scan needs.
    .sort((a, b) => a.localeCompare(b));

  const outermost: string[] = [];
  for (const dir of dirs) {
    if (!outermost.some((kept) => toForwardSlash(dir).startsWith(`${toForwardSlash(kept)}/`))) {
      outermost.push(dir);
    }
  }
  return outermost;
}

/** Location of a single skill shipped via source tree-copy. */
export interface DistributedSkillLocation {
  /** Name of the marketplace this skill ships through. */
  marketplaceName: string;
  /** Name of the plugin that contains this skill. */
  pluginName: string;
  /**
   * Forward-slash path of the skill's directory RELATIVE to the plugin's `skills/`
   * dir — `my-skill`, or `group/nested-skill` for a nested skill. A path, not a
   * bare name: the output layout mirrors the source layout, so a nested skill
   * ships at the same depth it was authored at.
   */
  skillDirPath: string;
  /** Absolute SOURCE skill dir: `<pluginSourceDir>/skills/<skillDirPath>`. */
  skillSourceDir: string;
  /** Absolute output path where `vat build` places the skill: `getPluginOutputDir(...)/skills/<skillDirPath>`. */
  skillOutputDir: string;
}

/**
 * Every plugin-local skill across all marketplaces in the config, paired with the
 * output directory where `vat build` places it.
 *
 * "Tree-copied" in the name is historical: plugin-local skills are PACKAGED (see
 * `packagePluginLocalSkills` in the CLI's plugin build), not copied verbatim. The
 * locations are unchanged, which is what every consumer here actually needs.
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
      const skillDirPaths = listPluginSourceSkillDirs(pluginSourceDir);
      if (skillDirPaths.length === 0) continue;

      const pluginOutputDir = getPluginOutputDir(configDir, marketplaceName, plugin.name);
      for (const skillDirPath of skillDirPaths) {
        locations.push({
          marketplaceName,
          pluginName: plugin.name,
          skillDirPath,
          skillSourceDir: safePath.join(pluginSourceDir, 'skills', skillDirPath),
          skillOutputDir: safePath.join(pluginOutputDir, 'skills', skillDirPath),
        });
      }
    }
  }

  return locations;
}

/** FS-safe single path segment for a skill name (colon → `__`, invalid on Windows). */
export function skillNameToFsPath(name: string): string {
  return name.replaceAll(':', '__');
}

/**
 * Find the tree-copied location whose SOURCE skill dir equals `skillSourceDir`
 * (compared via resolved absolute paths). Returns `undefined` for pool skills
 * or skills not declared in any plugin's `skills/` source dir.
 */
export function findDistributedSkillLocationBySource(
  config: ProjectConfig,
  configDir: string,
  skillSourceDir: string,
): DistributedSkillLocation | undefined {
  const target = safePath.resolve(skillSourceDir);
  return computeTreeCopiedSkillLocations(config, configDir).find(
    loc => safePath.resolve(loc.skillSourceDir) === target,
  );
}
