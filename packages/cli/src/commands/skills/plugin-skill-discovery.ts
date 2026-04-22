/**
 * Plugin-local SKILL.md discovery.
 *
 * From spec section Design -> Skill stream + Discovery glob extension:
 *   - Auto-inject plugins/<name>/skills/**\/SKILL.md for each declared plugin.
 *   - Non-gitignore-aware: plugin-local skills are semantically mandatory and
 *     discovered regardless of .gitignore status.
 *   - If a SKILL.md itself is gitignored, still discover; emit a warning.
 *   - Dedupe by canonical path.
 *   - Respect `source` override (default: plugins/<name>).
 */

import { existsSync } from 'node:fs';

import {
  crawlDirectory,
  normalizePath,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';

import { readSkillName } from './skill-discovery.js';

export interface PluginLocalSkill {
  name: string;
  plugin: string;
  sourcePath: string;
}

export interface DiscoverPluginLocalSkillsArgs {
  projectRoot: string;
  pluginNames: readonly string[];
  sourceOverrides?: Record<string, string>;
  warn?: (message: string) => void;
}

interface CollectForPluginArgs {
  projectRoot: string;
  pluginName: string;
  sourceOverride: string | undefined;
  warn: ((message: string) => void) | undefined;
}

async function collectForPlugin(
  args: CollectForPluginArgs,
  canonical: Map<string, PluginLocalSkill>,
): Promise<void> {
  const { projectRoot, pluginName, sourceOverride, warn } = args;
  const rel = sourceOverride ?? `plugins/${pluginName}`;
  const sourceDir = safePath.join(projectRoot, rel);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  if (!existsSync(sourceDir)) return;

  const [paths, visible] = await Promise.all([
    crawlDirectory({
      baseDir: sourceDir,
      include: ['skills/**/SKILL.md'],
      absolute: true,
      filesOnly: true,
      respectGitignore: false,
      dot: true,
    }),
    crawlDirectory({
      baseDir: sourceDir,
      include: ['skills/**/SKILL.md'],
      absolute: true,
      filesOnly: true,
      respectGitignore: true,
      dot: true,
    }),
  ]);

  const visibleCanons = new Set(visible.map((v) => toForwardSlash(normalizePath(v))));

  for (const p of paths) {
    const canon = toForwardSlash(normalizePath(p));
    if (canonical.has(canon)) continue;

    const name = await readSkillName(p);
    if (!name) continue;

    if (!visibleCanons.has(canon) && warn) {
      warn(
        `Plugin-local SKILL.md "${toForwardSlash(safePath.relative(projectRoot, p))}" is gitignored ` +
          `but still being discovered. Plugin-local skills are semantically mandatory; remove the gitignore entry ` +
          `if you do not intend to ship this skill.`,
      );
    }

    canonical.set(canon, { name, plugin: pluginName, sourcePath: toForwardSlash(p) });
  }
}

export async function discoverPluginLocalSkills(
  args: DiscoverPluginLocalSkillsArgs,
): Promise<PluginLocalSkill[]> {
  const { projectRoot, pluginNames, sourceOverrides, warn } = args;
  const canonical = new Map<string, PluginLocalSkill>();
  const uniquePlugins = [...new Set(pluginNames)];

  for (const pluginName of uniquePlugins) {
    await collectForPlugin(
      {
        projectRoot,
        pluginName,
        sourceOverride: sourceOverrides?.[pluginName],
        warn,
      },
      canonical,
    );
  }

  return [...canonical.values()];
}
