/**
 * On-disk fixtures for "is this discovered skill plugin-local?" — the question every
 * lane answers from what the claude phase actually SHIPS: git-visible, outermost
 * skill directories under a plugin's `skills/` dir.
 *
 * A path-string fixture cannot exercise that predicate (it has nothing to list), and a
 * fixture whose directory is named after its skill cannot tell a source-directory match
 * from a name match — so every skill here carries its own `dir` and `name`.
 */

import { writeFileSync } from 'node:fs';

import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';

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

/** A project config declaring the fixture plugin, with `skills.defaults.publish` as given. */
export function pluginProjectConfig(defaultPublish: boolean): ProjectConfig {
  return {
    version: 1,
    skills: { include: ['**/SKILL.md'], defaults: { publish: defaultPublish } },
    claude: { marketplaces: { m: { owner: { name: 'Owner' }, plugins: [{ name: FIXTURE_PLUGIN, skills: [] }] } } },
  };
}
