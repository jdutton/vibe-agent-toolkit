/**
 * The consistency check over PLUGIN-LOCAL skills, against a real project on disk.
 *
 * A plugin-local skill is judged by what the plugin build ships — the git-visible,
 * outermost skill directories under a plugin's `skills/` dir — so these cases write a
 * project to a temp dir (each skill in a directory NOT named after it) and, where
 * tracking matters, a real git repository. The same decisions over an in-memory index
 * are unit tests (`test/commands/consistency-check.test.ts`).
 */

import { indexPluginLocalSkills } from '@vibe-agent-toolkit/agent-skills';
import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveAssignedSkills, runConsistencyChecks } from '../../src/commands/consistency-check.js';
import type { DiscoveredSkill } from '../../src/commands/skills/command-helpers.js';
import { marketplaceConfig, writeSkillProject, type FixtureSkill } from '../helpers/plugin-local-fixture.js';
import { createTempDirTracker } from '../system/test-common.js';

const TREE_PLUGIN = 'tree-plugin';
const OTHER_PLUGIN = 'other-plugin';
const BUNDLED_SKILL = 'bundled-skill';
const UNPUBLISHED = 'SKILL_UNPUBLISHED';
const NOT_IN_PLUGIN = 'PUBLISHED_SKILL_NOT_IN_PLUGIN';
const UNKNOWN_SKILL = 'PLUGIN_REFERENCES_UNKNOWN_SKILL';

const tempDirs = createTempDirTracker('vat-cc-plugin-local-');

/** One marketplace carrying `plugins`, discovering every `SKILL.md`. */
function buildConfig(
  plugins: Parameters<typeof marketplaceConfig>[0],
  options: { defaultPublish?: boolean; publish?: Record<string, boolean> } = {},
): ProjectConfig {
  return marketplaceConfig(plugins, { include: '**/SKILL.md', ...options });
}

/** `plugins/<plugin>/<skillsDir>/<leaf>` — a directory under a plugin source dir. */
const underPlugin = (plugin: string, leaf: string, skillsDir = 'skills'): string => `plugins/${plugin}/${skillsDir}/${leaf}`;

/** The skill `name`, in `<name>-dir` under `plugin`'s `skills/` (or `skillsDir`). */
const pluginSkill = (name: string, plugin = TREE_PLUGIN, skillsDir = 'skills'): FixtureSkill =>
  ({ dir: underPlugin(plugin, `${name}-dir`, skillsDir), name });

/**
 * Write `skills` under a fresh temp root. `untracked` (directories) turns the root into
 * a git repository with every OTHER skill `git add`ed; omitted, the root is outside git.
 */
function project(skills: readonly FixtureSkill[], untracked?: readonly string[]): { root: string; discovered: DiscoveredSkill[] } {
  const root = tempDirs.createTempDir();
  const discovered = writeSkillProject(root, skills, untracked === undefined ? 'none' : { untracked });
  return { root, discovered };
}

/** A skill that lives outside every plugin source tree, under `root`. */
function externalSkill(name: string, root: string): DiscoveredSkill {
  return { name, sourcePath: safePath.join(root, 'standalone-skills', name, 'SKILL.md') };
}

function assigned(config: ProjectConfig, skills: DiscoveredSkill[], root: string): Set<string> {
  return resolveAssignedSkills(config, skills, indexPluginLocalSkills(config, root));
}

function issuesOf(config: ProjectConfig, discovered: DiscoveredSkill[], root: string): ReturnType<typeof runConsistencyChecks>['issues'] {
  return runConsistencyChecks(discovered, config, root, indexPluginLocalSkills(config, root)).issues;
}

const withCode = (issues: Array<{ code: string }>, code: string): number => issues.filter((i) => i.code === code).length;

/**
 * The consistency issues for ONE plugin-local skill ({@link BUNDLED_SKILL} in {@link TREE_PLUGIN}),
 * selected by `selector` (none by default), optionally left untracked by git.
 */
function checkBundledSkill(options: { selector?: string[]; defaultPublish?: boolean; untracked?: boolean } = {}): ReturnType<typeof issuesOf> {
  const skill = pluginSkill(BUNDLED_SKILL);
  const config = buildConfig([{ name: TREE_PLUGIN, skills: options.selector ?? [] }], {
    ...(options.defaultPublish === undefined ? {} : { defaultPublish: options.defaultPublish }),
  });
  const { root, discovered } = project([skill], options.untracked === true ? [skill.dir] : undefined);
  return issuesOf(config, discovered, root);
}

describe('resolveAssignedSkills — plugin-local assignment by what the plugin build ships', () => {
  afterEach(() => tempDirs.cleanupTempDirs());

  it('assigns a published skill whose source dir is a plugin skill dir', () => {
    const { root, discovered } = project([pluginSkill(BUNDLED_SKILL)]);

    expect(assigned(buildConfig([{ name: TREE_PLUGIN, skills: [] }]), discovered, root).has(BUNDLED_SKILL)).toBe(true);
  });

  it('enforces the path-separator boundary: a skill under skills-extra/ is not matched', () => {
    const { root, discovered } = project([pluginSkill('look-alike', TREE_PLUGIN, 'skills-extra')]);

    expect(assigned(buildConfig([{ name: TREE_PLUGIN, skills: [] }]), discovered, root).has('look-alike')).toBe(false);
  });

  it('does NOT assign an UNTRACKED skill under a plugin skills/ dir — the plugin build does not ship it', () => {
    const skill = pluginSkill(BUNDLED_SKILL);
    const { root, discovered } = project([skill], [skill.dir]);

    expect(assigned(buildConfig([{ name: TREE_PLUGIN, skills: [] }]), discovered, root).has(BUNDLED_SKILL)).toBe(false);
  });

  it('assigns a publish: false skill under the plugin source dir — plugin-local assignment is by location', () => {
    const { root, discovered } = project([pluginSkill('private-skill')]);
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], { publish: { 'private-skill': false } });

    expect(assigned(config, discovered, root).has('private-skill')).toBe(true);
  });

  it('is additive: a pool selector and a plugin-local skill both contribute', () => {
    const { root, discovered } = project([pluginSkill('skill-b', 'hybrid-plugin')]);
    const config = buildConfig([{ name: 'hybrid-plugin', skills: ['skill-a'] }]);

    const result = assigned(config, [externalSkill('skill-a', root), ...discovered], root);

    expect([result.has('skill-a'), result.has('skill-b')]).toEqual([true, true]);
  });
});

describe('PUBLISHED_SKILL_NOT_IN_PLUGIN — the fix says what is true of the skill', () => {
  afterEach(() => tempDirs.cleanupTempDirs());

  it('does NOT flag a published skill that resides in the plugin source skills dir', () => {
    expect(withCode(checkBundledSkill(), NOT_IN_PLUGIN)).toBe(0);
  });

  it('an UNTRACKED skill under a plugin skills/ dir: the fix names the plugin and says git add', () => {
    const flagged = checkBundledSkill({ untracked: true }).filter((i) => i.code === NOT_IN_PLUGIN);

    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.fix).toContain(`plugin "${TREE_PLUGIN}"`);
    expect(flagged[0]?.fix).toContain('git does not track it');
    expect(flagged[0]?.fix).toContain('git add');
  });

  it('a TRACKED skill nested inside another plugin-local skill: the fix names the outer skill, never git add', () => {
    const outer = pluginSkill('outer');
    const inner: FixtureSkill = { dir: `${outer.dir}/inner-dir`, name: 'inner' };
    const { root, discovered } = project([outer, inner], []);

    const flagged = issuesOf(buildConfig([{ name: TREE_PLUGIN, skills: [] }]), discovered, root)
      .filter((i) => i.code === NOT_IN_PLUGIN);

    expect(flagged.map((i) => i.message)).toEqual([expect.stringContaining('"inner"')]);
    expect(flagged[0]?.fix).toContain('nested inside skill "outer"');
    expect(flagged[0]?.fix).toContain('outermost');
    expect(flagged[0]?.fix).not.toContain('git add');
  });
});

describe('publish: false and plugin-local skills', () => {
  afterEach(() => tempDirs.cleanupTempDirs());

  it('a plugin-local skill under a false default is neither unassigned nor SKILL_UNPUBLISHED — it ships with its plugin', () => {
    const issues = checkBundledSkill({ defaultPublish: false });

    expect([withCode(issues, NOT_IN_PLUGIN), withCode(issues, UNPUBLISHED)]).toEqual([0, 0]);
  });

  it('an UNTRACKED skill under a plugin skills/ dir under a false default IS SKILL_UNPUBLISHED — it ships nowhere', () => {
    const issues = checkBundledSkill({ defaultPublish: false, untracked: true });

    expect(issues.filter((i) => i.code === UNPUBLISHED).map((i) => i.message)).toEqual([expect.stringContaining(BUNDLED_SKILL)]);
  });

  it('a repo-only skill sharing its declared name with a plugin-local one still gets SKILL_UNPUBLISHED', () => {
    const { root, discovered } = project([pluginSkill(BUNDLED_SKILL)]);
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], { defaultPublish: false });

    expect(withCode(issuesOf(config, [externalSkill(BUNDLED_SKILL, root), ...discovered], root), UNPUBLISHED)).toBe(1);
  });

  it('control: a selector in the SAME plugin naming its own plugin-local publish: false skill is not flagged', () => {
    expect(withCode(checkBundledSkill({ selector: [BUNDLED_SKILL], defaultPublish: false }), UNKNOWN_SKILL)).toBe(0);
  });

  it('a selector in ANOTHER plugin naming a plugin-local publish: false skill is PLUGIN_REFERENCES_UNKNOWN_SKILL naming the owner', () => {
    // `vat build` builds the other plugin without it: the skill is not in dist/skills,
    // and only its own plugin packages it.
    const { root, discovered } = project([pluginSkill(BUNDLED_SKILL)]);
    const config = buildConfig(
      [{ name: TREE_PLUGIN, skills: [] }, { name: OTHER_PLUGIN, skills: [BUNDLED_SKILL] }],
      { defaultPublish: false },
    );

    const refs = issuesOf(config, discovered, root).filter((i) => i.code === UNKNOWN_SKILL);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.message).toContain(`Plugin "${OTHER_PLUGIN}"`);
    expect(refs[0]?.message).toContain(`"${TREE_PLUGIN}"`);
  });
});
