/**
 * Unit tests for resolveAssignedSkills and runConsistencyChecks in consistency-check.ts.
 *
 * Every case is in memory: which skills are plugin-local (and why the others under a
 * plugin's `skills/` are not) is handed in as a fake index, so these pin what the
 * check does with that answer. The index against a real project and git repository is
 * `test/integration/consistency-check-plugin-local.integration.test.ts`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type { PluginLocalSkillIndex, PluginSkillExclusion } from '@vibe-agent-toolkit/agent-skills';
import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterAll, describe, expect, it } from 'vitest';

import {
  readVatSkillsFromPackageJson,
  resolveAssignedSkills,
  runConsistencyChecks,
} from '../../src/commands/consistency-check.js';
import type { DiscoveredSkill } from '../../src/commands/skills/command-helpers.js';
import { fakePluginLocalIndex, marketplaceConfig } from '../helpers/plugin-local-fixture.js';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

/** Fake project root — nothing is ever read under it. */
const PROJECT_ROOT = safePath.join(normalizedTmpdir(), 'no-such-project-cc');

// Reusable string constants to satisfy sonarjs/no-duplicate-string (3+ occurrences trigger it).
const TREE_PLUGIN = 'tree-plugin';
const BUNDLED_SKILL = 'bundled-skill';
const UNPUBLISHED = 'SKILL_UNPUBLISHED';
const NOT_IN_PLUGIN = 'PUBLISHED_SKILL_NOT_IN_PLUGIN';
const UNKNOWN_SKILL = 'PLUGIN_REFERENCES_UNKNOWN_SKILL';
const ORPHAN = 'orphan-skill';
const IN_PLACE = 'in-place';

/** The original remedy text, for a skill nowhere near a plugin. */
const CONFIG_ONLY_FIX = `Either add "${ORPHAN}" to a plugin's skills array in vibe-agent-toolkit.config.yaml: claude.marketplaces.<marketplace>.plugins[].skills, or opt out of publishing by setting publish: false in vibe-agent-toolkit.config.yaml: skills.config.${ORPHAN}.publish: false`;

/** Build a minimal ProjectConfig with one marketplace and a given plugin list. */
function buildConfig(
  plugins: Array<{ name: string; skills: '*' | string[] }>,
  skillPublishOverrides?: Record<string, boolean>,
  defaultPublish?: boolean,
): ProjectConfig {
  return marketplaceConfig(plugins, { include: 'skills/**/SKILL.md', defaultPublish, publish: skillPublishOverrides });
}

/** A discovered skill in its own directory `<group>/<name>-dir/` under the fake root. */
function skillAt(name: string, group = 'standalone-skills'): DiscoveredSkill {
  return { name, sourcePath: safePath.join(PROJECT_ROOT, group, `${name}-dir`, 'SKILL.md') };
}

/** The same skill, under `plugin`'s `skills/` dir. */
function pluginSkill(name: string, plugin = TREE_PLUGIN): DiscoveredSkill {
  return skillAt(name, `plugins/${plugin}/skills`);
}

/** Every listed skill is plugin-local to {@link TREE_PLUGIN}, listed through marketplace `test`. */
function indexOf(pluginLocal: readonly DiscoveredSkill[], exclusions: Record<string, PluginSkillExclusion> = {}): PluginLocalSkillIndex {
  return fakePluginLocalIndex(
    pluginLocal.map((s) => ({ sourcePath: s.sourcePath, pluginName: TREE_PLUGIN, marketplaceName: 'test' })),
    exclusions,
  );
}

function check(
  discovered: DiscoveredSkill[],
  config: ProjectConfig,
  pluginLocal: PluginLocalSkillIndex = indexOf([]),
): ReturnType<typeof runConsistencyChecks> {
  return runConsistencyChecks(discovered, config, PROJECT_ROOT, pluginLocal);
}

const codesFor = (issues: Array<{ code: string }>, code: string): number =>
  issues.filter((i) => i.code === code).length;

const withCode = <T extends { code: string }>(issues: T[], code: string): T[] => issues.filter((i) => i.code === code);

// ---------------------------------------------------------------------------
// resolveAssignedSkills
// ---------------------------------------------------------------------------

describe('resolveAssignedSkills', () => {
  it('returns an empty set when no marketplaces are configured', () => {
    expect(resolveAssignedSkills({ version: 1 }, [skillAt('foo')], indexOf([])).size).toBe(0);
  });

  it('assigns a skill matched by a pool name selector', () => {
    const config = buildConfig([{ name: 'pool-plugin', skills: ['my-skill'] }]);

    expect(resolveAssignedSkills(config, [skillAt('my-skill')], indexOf([])).has('my-skill')).toBe(true);
  });

  it('assigns all published skills when pool selector is "*"', () => {
    const result = resolveAssignedSkills(buildConfig([{ name: 'pool-plugin', skills: '*' }]), [skillAt('skill-a'), skillAt('skill-b')], indexOf([]));

    expect([result.has('skill-a'), result.has('skill-b')]).toEqual([true, true]);
  });

  it('assigns a skill the index says is plugin-local, whatever publish says, and nothing it does not', () => {
    const local = pluginSkill('private-skill');
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], { 'private-skill': false });

    const result = resolveAssignedSkills(config, [local, pluginSkill('untracked-skill'), skillAt('unassigned')], indexOf([local]));

    expect([...result]).toEqual(['private-skill']);
  });

  it('does NOT let a pool selector pick up a publish: false skill — it is not in the pool', () => {
    const config = buildConfig([{ name: 'pool-plugin', skills: '*' }], { [IN_PLACE]: false });
    const result = resolveAssignedSkills(config, [skillAt(IN_PLACE), skillAt('pooled')], indexOf([]));
    expect([result.has(IN_PLACE), result.has('pooled')]).toEqual([false, true]);
  });

  it('is additive: pool selector and a plugin-local skill both contribute to the assigned set', () => {
    const local = pluginSkill('skill-b', 'hybrid-plugin');
    const result = resolveAssignedSkills(buildConfig([{ name: 'hybrid-plugin', skills: ['skill-a'] }]), [skillAt('skill-a'), local], indexOf([local]));

    expect([result.has('skill-a'), result.has('skill-b')]).toEqual([true, true]);
  });
});

// ---------------------------------------------------------------------------
// PUBLISHED_SKILL_NOT_IN_PLUGIN check (via runConsistencyChecks)
// ---------------------------------------------------------------------------

describe('PUBLISHED_SKILL_NOT_IN_PLUGIN check', () => {
  const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);

  it('does NOT flag a published plugin-local skill', () => {
    const local = pluginSkill(BUNDLED_SKILL);

    expect(codesFor(check([local], config, indexOf([local])).issues, NOT_IN_PLUGIN)).toBe(0);
  });

  it('a skill nowhere near a plugin gets the config remedies alone — no git add hint', () => {
    const flagged = withCode(check([skillAt(ORPHAN)], config).issues, NOT_IN_PLUGIN);

    expect(flagged.map((i) => [i.message, i.fix])).toEqual([[expect.stringContaining(ORPHAN), CONFIG_ONLY_FIX]]);
  });

  it('an untracked skill under a plugin skills/ dir: the fix names the plugin and the directory to git add', () => {
    const skill = pluginSkill(ORPHAN);
    const skillSourceDir = safePath.join(PROJECT_ROOT, 'plugins', TREE_PLUGIN, 'skills', `${ORPHAN}-dir`);
    const exclusion: PluginSkillExclusion = { kind: 'untracked', pluginName: TREE_PLUGIN, skillSourceDir };

    const [issue] = withCode(check([skill], config, indexOf([], { [skill.sourcePath]: exclusion })).issues, NOT_IN_PLUGIN);

    expect(issue?.fix).toContain(`plugin "${TREE_PLUGIN}"'s skills/ directory, but git does not track it`);
    expect(issue?.fix).toContain(`git add plugins/${TREE_PLUGIN}/skills/${ORPHAN}-dir.`);
  });

  it('a skill nested inside a plugin-local skill: the fix names the outer skill by its declared name, never git add', () => {
    const outer = pluginSkill('outer');
    const outerIndex = indexOf([outer]);
    const outerLocation = outerIndex.locations[0];
    if (outerLocation === undefined) throw new Error('fake index lost the outer skill');
    const inner: DiscoveredSkill = { name: 'inner', sourcePath: safePath.join(outerLocation.skillSourceDir, 'inner-dir', 'SKILL.md') };
    const index = indexOf([outer], { [inner.sourcePath]: { kind: 'nested', outer: { pluginName: outerLocation.pluginName, skillSourceDir: outerLocation.skillSourceDir } } });

    const flagged = withCode(check([outer, inner], config, index).issues, NOT_IN_PLUGIN);

    expect(flagged.map((i) => i.message)).toEqual([expect.stringContaining('"inner"')]);
    expect(flagged[0]?.fix).toContain('nested inside skill "outer"');
    expect(flagged[0]?.fix).toContain('ships only the outermost skill directory');
    expect(flagged[0]?.fix).not.toContain('git add');
  });
});

// ---------------------------------------------------------------------------
// publish is read off the MERGED config: skills.defaults.publish counts
// ---------------------------------------------------------------------------

describe('publish is read through the merged packaging config', () => {
  it('positive control: with no publish anywhere, an unassigned pool skill is PUBLISHED_SKILL_NOT_IN_PLUGIN', () => {
    const { issues, summary } = check([skillAt(ORPHAN)], buildConfig([{ name: TREE_PLUGIN, skills: [] }]));
    expect([codesFor(issues, NOT_IN_PLUGIN), codesFor(issues, UNPUBLISHED)]).toEqual([1, 0]);
    expect(summary).toMatchObject({ publishedSkills: 1, unpublishedSkills: 0 });
  });

  it('honours skills.defaults.publish: false — the same skill is in-place, not an unassigned published one', () => {
    // This was red: the check read `skills.config.<name>.publish` alone, so a
    // project-wide default parsed, validated and changed nothing.
    const { issues, summary } = check([skillAt(ORPHAN)], buildConfig([{ name: TREE_PLUGIN, skills: [] }], undefined, false));
    expect([codesFor(issues, NOT_IN_PLUGIN), codesFor(issues, UNPUBLISHED)]).toEqual([0, 1]);
    expect(summary).toMatchObject({ publishedSkills: 0, unpublishedSkills: 1 });
  });

  it('lets skills.config.<name>.publish: true opt one skill back in over a false default', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], { [ORPHAN]: true }, false);
    const { issues } = check([skillAt(ORPHAN), skillAt('stays-in-place')], config);
    expect(withCode(issues, NOT_IN_PLUGIN).map((i) => i.message)).toEqual([expect.stringContaining(ORPHAN)]);
    expect(withCode(issues, UNPUBLISHED).map((i) => i.message)).toEqual([expect.stringContaining('stays-in-place')]);
  });

  it('a plugin-local skill under a false default is neither unassigned nor SKILL_UNPUBLISHED; a same-named repo-only one is in place', () => {
    const local = pluginSkill(BUNDLED_SKILL);
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], undefined, false);

    const { issues, summary } = check([skillAt(BUNDLED_SKILL), local], config, indexOf([local]));

    expect([codesFor(issues, NOT_IN_PLUGIN), codesFor(issues, UNPUBLISHED)]).toEqual([0, 1]);
    expect(summary).toMatchObject({ publishedSkills: 0, unpublishedSkills: 2 });
  });

  it('SKILL_UNPUBLISHED names the in-place meaning, not "not distributed"', () => {
    const { issues } = check([skillAt(IN_PLACE)], buildConfig([{ name: TREE_PLUGIN, skills: [] }], { [IN_PLACE]: false }));
    const info = issues.find((i) => i.code === UNPUBLISHED);
    expect(info?.severity).toBe('info');
    expect(info?.message).toContain(IN_PLACE);
    expect(info?.message).toContain('dist/skills');
  });
});

// ---------------------------------------------------------------------------
// PLUGIN_REFERENCES_UNKNOWN_SKILL — what a selector can actually select
// ---------------------------------------------------------------------------

describe('plugin selectors and publish: false skills', () => {
  it('a selector that matches ONLY in-place skills selects nothing from the pool — naming publish', () => {
    // An in-place skill is never built, so the claude phase (which selects from
    // dist/skills) would silently ship the plugin without it.
    const config = buildConfig([{ name: 'pool-plugin', skills: [IN_PLACE, 'pooled'] }], { [IN_PLACE]: false });
    const refs = withCode(check([skillAt(IN_PLACE), skillAt('pooled')], config).issues, UNKNOWN_SKILL);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.message).toContain(`"${IN_PLACE}"`);
    expect(refs[0]?.message).toContain('matches only in-place skills (publish: false)');
    expect(refs[0]?.fix).toContain('skills.config.<name>.publish');
  });

  it('control: a selector naming a publish: false skill plugin-local to ITS OWN plugin is not flagged', () => {
    const local = pluginSkill(BUNDLED_SKILL);
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [BUNDLED_SKILL] }], undefined, false);

    expect(codesFor(check([local], config, indexOf([local])).issues, UNKNOWN_SKILL)).toBe(0);
  });

  it('a selector in ANOTHER plugin naming a publish: false plugin-local skill is flagged, naming the plugin that ships it', () => {
    const local = pluginSkill(BUNDLED_SKILL);
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }, { name: 'other-plugin', skills: [BUNDLED_SKILL] }], undefined, false);

    const refs = withCode(check([local], config, indexOf([local])).issues, UNKNOWN_SKILL);

    expect(refs.map((i) => i.message)).toEqual([
      expect.stringContaining(`Plugin "other-plugin" in marketplace "test" references skill selector "${BUNDLED_SKILL}", which matches only publish: false skills plugin-local to "${TREE_PLUGIN}"`),
    ]);
  });

  it('a PUBLISHED plugin-local skill is selectable by any plugin — it is in dist/skills', () => {
    const local = pluginSkill(BUNDLED_SKILL);
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }, { name: 'other-plugin', skills: [BUNDLED_SKILL] }]);

    expect(codesFor(check([local], config, indexOf([local])).issues, UNKNOWN_SKILL)).toBe(0);
  });
});

describe('readVatSkillsFromPackageJson', () => {
  const workDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-cc-pkg-'));
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns the declared list', () => {
    writeFileSync(safePath.join(workDir, 'package.json'), '{"vat":{"skills":["a","b"]}}');

    expect(readVatSkillsFromPackageJson(workDir)).toEqual(['a', 'b']);
  });

  it('returns undefined when there is no package.json — nothing declared', () => {
    expect(readVatSkillsFromPackageJson(safePath.join(workDir, 'nowhere'))).toBeUndefined();
  });

  it('refuses a package.json that is not JSON rather than reading it as "nothing declared"', () => {
    // "Nothing declared" skips the cross-check. A broken manifest used to skip
    // it the same way, so `vat verify` verified nothing and reported nothing.
    writeFileSync(safePath.join(workDir, 'package.json'), '{"vat":');

    expect(() => readVatSkillsFromPackageJson(workDir)).toThrow(/package\.json is not valid JSON/);
  });
});
