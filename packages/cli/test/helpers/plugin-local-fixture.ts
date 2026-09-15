/**
 * Fixtures for "is this discovered skill plugin-local?" — the question every lane
 * answers from what the claude phase actually SHIPS: git-visible, outermost skill
 * directories under a plugin's `skills/` dir.
 *
 * Two shapes. {@link fakePluginLocalIndex} is the in-memory index unit tests hand to a
 * lane, saying outright which skills are plugin-local. {@link writeSkillProject} writes a
 * real project (optionally a git repository) for the integration tests that let
 * `indexPluginLocalSkills` list it. A fixture whose directory is named after its skill
 * cannot tell a source-directory match from a name match — so every skill carries its
 * own `dir` and `name`.
 */

import { writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import type {
  DistributedSkillLocation,
  PluginLocalSkillIndex,
  PluginSkillExclusion,
} from '@vibe-agent-toolkit/agent-skills';
import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import * as yaml from 'yaml';

import type { DiscoveredSkill } from '../../src/commands/skills/command-helpers.js';

/** The one plugin every fixture declares: `claude.marketplaces.m.plugins[p]`, source `plugins/p`. */
const FIXTURE_PLUGIN = 'p';

/** A skill to write: its directory relative to the project root, and its declared `name:`. */
export interface FixtureSkill {
  dir: string;
  name: string;
}

/** `plugins/p/skills/<leaf>` — a directory under the fixture plugin's `skills/` dir. */
export function pluginSkillDir(leaf: string): string {
  return `plugins/${FIXTURE_PLUGIN}/skills/${leaf}`;
}

/**
 * Write every skill's `SKILL.md` under `root` and return them as discovery would.
 *
 * `git: 'none'` leaves `root` outside any repository (every file visible). `git: { untracked }`
 * runs `git init` and `git add`s every skill EXCEPT the directories listed — the shape of a
 * skill just created and not yet added, which the claude phase does not package.
 */
export function writeSkillProject(
  root: string,
  skills: readonly FixtureSkill[],
  git: 'none' | { untracked: readonly string[] } = 'none',
): DiscoveredSkill[] {
  const discovered = skills.map(({ dir, name }) => {
    const skillDir = safePath.join(root, dir);
    mkdirSyncReal(skillDir, { recursive: true });
    const sourcePath = safePath.join(skillDir, 'SKILL.md');
    writeFileSync(sourcePath, `---\nname: ${name}\ndescription: fixture skill ${name}\n---\n# ${name}\n`);
    return { name, sourcePath };
  });
  if (git !== 'none') {
    runGitOrThrow(['init', '-q'], { cwd: root });
    const tracked = skills.filter(({ dir }) => !git.untracked.includes(dir)).map(({ dir }) => dir);
    if (tracked.length > 0) runGitOrThrow(['add', '--', ...tracked], { cwd: root });
  }
  return discovered;
}

/** Write `config` as the project's `vibe-agent-toolkit.config.yaml` under `root`. */
export function writeProjectConfig(root: string, config: ProjectConfig): void {
  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), yaml.stringify(config));
}

/** A project config declaring the fixture plugin, with `skills.defaults.publish` as given. */
export function pluginProjectConfig(defaultPublish: boolean): ProjectConfig {
  return {
    version: 1,
    skills: { include: ['**/SKILL.md'], defaults: { publish: defaultPublish } },
    claude: { marketplaces: { m: { owner: { name: 'Owner' }, plugins: [{ name: FIXTURE_PLUGIN, skills: [] }] } } },
  };
}

/**
 * A project config with ONE marketplace, `test`, carrying `plugins` — `skills.defaults.publish`
 * and per-skill `publish` as given.
 */
export function marketplaceConfig(
  plugins: Array<{ name: string; skills: '*' | string[] }>,
  options: { include: string; defaultPublish?: boolean | undefined; publish?: Record<string, boolean> | undefined },
): ProjectConfig {
  return {
    version: 1,
    skills: {
      include: [options.include],
      ...(options.defaultPublish === undefined ? {} : { defaults: { publish: options.defaultPublish } }),
      config: Object.fromEntries(Object.entries(options.publish ?? {}).map(([k, v]) => [k, { publish: v }])),
    },
    claude: { marketplaces: { test: { owner: { name: 'Test Owner' }, plugins } } },
  };
}

/** A plugin-local skill for {@link fakePluginLocalIndex}: its `SKILL.md`, and the plugin (default `p`) shipping it. */
interface FakePluginLocalSkill {
  sourcePath: string;
  pluginName?: string;
  marketplaceName?: string;
}

/**
 * An in-memory {@link PluginLocalSkillIndex}: each of `pluginLocal` is a location (in listing
 * order), matched by the directory holding its `SKILL.md`; `exclusions` answers `exclusionOf`
 * by `SKILL.md` path. Nothing on disk is listed.
 */
export function fakePluginLocalIndex(
  pluginLocal: readonly FakePluginLocalSkill[],
  exclusions: Readonly<Record<string, PluginSkillExclusion>> = {},
): PluginLocalSkillIndex {
  const locations: DistributedSkillLocation[] = pluginLocal.map((skill) => {
    const skillSourceDir = safePath.resolve(dirname(skill.sourcePath));
    const skillDirPath = basename(skillSourceDir);
    return {
      marketplaceName: skill.marketplaceName ?? 'm',
      pluginName: skill.pluginName ?? FIXTURE_PLUGIN,
      skillDirPath,
      skillSourceDir,
      skillOutputDir: safePath.join(skillSourceDir, '..', '..', 'dist-fixture', skillDirPath),
    };
  });
  const locationsOf = (skillMdPath: string): DistributedSkillLocation[] =>
    locations.filter((loc) => loc.skillSourceDir === safePath.resolve(dirname(skillMdPath)));
  return {
    locations,
    locationsOf,
    locationOf: (skillMdPath) => locationsOf(skillMdPath)[0],
    exclusionOf: (skillMdPath) => exclusions[skillMdPath],
  };
}
