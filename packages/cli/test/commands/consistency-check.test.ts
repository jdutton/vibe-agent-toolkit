/**
 * Unit tests for resolveAssignedSkills and the PUBLISHED_SKILL_NOT_IN_PLUGIN
 * check in consistency-check.ts.
 *
 * All tests are in-memory — no file system access required because
 * resolveAssignedSkills performs only path-string comparisons against
 * the pre-computed DiscoveredSkill.sourcePath values.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

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

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

/** Fake project root — a plausible absolute path with no real files. */
const PROJECT_ROOT = '/testroot-cc';

// Reusable string constants to satisfy sonarjs/no-duplicate-string (3+ occurrences trigger it).
const TREE_PLUGIN = 'tree-plugin';
const BUNDLED_SKILL = 'bundled-skill';
const LOOK_ALIKE = 'look-alike';

/** Build a minimal ProjectConfig with one marketplace and a given plugin list. */
function buildConfig(
  plugins: Array<{ name: string; source?: string; skills: '*' | string[] }>,
  skillPublishOverrides?: Record<string, boolean>,
  defaultPublish?: boolean,
): ProjectConfig {
  const skillsSection = skillPublishOverrides || defaultPublish !== undefined
    ? {
        skills: {
          include: ['skills/**/SKILL.md'],
          ...(defaultPublish === undefined ? {} : { defaults: { publish: defaultPublish } }),
          config: Object.fromEntries(
            Object.entries(skillPublishOverrides ?? {}).map(([k, v]) => [k, { publish: v }])
          ),
        },
      }
    : {};

  return {
    version: 1,
    ...skillsSection,
    claude: {
      marketplaces: {
        test: {
          owner: { name: 'Test Owner' },
          plugins,
        },
      },
    },
  };
}

/**
 * Build a DiscoveredSkill whose sourcePath sits inside a plugin's source skills dir.
 *
 * Convention: skills are at `<PROJECT_ROOT>/plugins/<pluginName>/skills/<skillName>/SKILL.md`
 * (using the default source path convention, i.e. no explicit `source` override).
 */
function makeSourceSkill(skillName: string, pluginName: string): DiscoveredSkill {
  return {
    name: skillName,
    sourcePath: safePath.join(
      PROJECT_ROOT,
      'plugins',
      pluginName,
      'skills',
      skillName,
      'SKILL.md',
    ),
  };
}

/**
 * Build a DiscoveredSkill that lives completely outside any plugin source tree.
 */
function makeExternalSkill(skillName: string): DiscoveredSkill {
  return {
    name: skillName,
    sourcePath: safePath.join(PROJECT_ROOT, 'standalone-skills', skillName, 'SKILL.md'),
  };
}

// ---------------------------------------------------------------------------
// resolveAssignedSkills
// ---------------------------------------------------------------------------

describe('resolveAssignedSkills', () => {
  it('returns an empty set when no marketplaces are configured', () => {
    const config: ProjectConfig = { version: 1 };
    const result = resolveAssignedSkills(config, [makeExternalSkill('foo')], PROJECT_ROOT);
    expect(result.size).toBe(0);
  });

  it('assigns a skill matched by a pool name selector', () => {
    const config = buildConfig([{ name: 'pool-plugin', skills: ['my-skill'] }]);
    const skill = makeExternalSkill('my-skill');

    const result = resolveAssignedSkills(config, [skill], PROJECT_ROOT);

    expect(result.has('my-skill')).toBe(true);
  });

  it('assigns all published skills when pool selector is "*"', () => {
    const config = buildConfig([{ name: 'pool-plugin', skills: '*' }]);
    const skills = [makeExternalSkill('skill-a'), makeExternalSkill('skill-b')];

    const result = resolveAssignedSkills(config, skills, PROJECT_ROOT);

    expect(result.has('skill-a')).toBe(true);
    expect(result.has('skill-b')).toBe(true);
  });

  it('assigns a published skill whose sourcePath is under the plugin source skills dir', () => {
    // Tree-copy plugin: source declared, skills: [] (no pool selectors)
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);
    const skill = makeSourceSkill(BUNDLED_SKILL, TREE_PLUGIN);

    const result = resolveAssignedSkills(config, [skill], PROJECT_ROOT);

    expect(result.has(BUNDLED_SKILL)).toBe(true);
  });

  it('does NOT assign a skill whose sourcePath is outside every plugin source skills dir', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);
    const skill = makeExternalSkill('unassigned-skill');

    const result = resolveAssignedSkills(config, [skill], PROJECT_ROOT);

    expect(result.has('unassigned-skill')).toBe(false);
  });

  it('enforces path-separator boundary: skill under skills-extra/ is not matched', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);
    // sourcePath is under /skills-extra/ (common prefix with /skills/ but different directory)
    const skill: DiscoveredSkill = {
      name: LOOK_ALIKE,
      sourcePath: safePath.join(
        PROJECT_ROOT,
        'plugins',
        TREE_PLUGIN,
        'skills-extra',
        LOOK_ALIKE,
        'SKILL.md',
      ),
    };

    const result = resolveAssignedSkills(config, [skill], PROJECT_ROOT);

    expect(result.has(LOOK_ALIKE)).toBe(false);
  });

  it('assigns a publish: false skill under the plugin source dir — plugin-local assignment is by LOCATION, outside publish\'s scope', () => {
    // `publish` scopes the pool only. A plugin-local skill ships with its plugin
    // whatever the flag says (the claude phase packages it, verify expects it), so
    // it is assigned by where it sits — not left unassigned by a flag about a
    // bundle it never had.
    const config = buildConfig(
      [{ name: TREE_PLUGIN, skills: [] }],
      { 'private-skill': false },
    );
    const skill = makeSourceSkill('private-skill', TREE_PLUGIN);

    const result = resolveAssignedSkills(config, [skill], PROJECT_ROOT);

    expect(result.has('private-skill')).toBe(true);
  });

  it('does NOT let a pool selector pick up a publish: false skill — it is not in the pool', () => {
    const config = buildConfig([{ name: 'pool-plugin', skills: '*' }], { 'in-place': false });
    const result = resolveAssignedSkills(config, [makeExternalSkill('in-place'), makeExternalSkill('pooled')], PROJECT_ROOT);
    expect(result.has('in-place')).toBe(false);
    expect(result.has('pooled')).toBe(true);
  });

  it('is additive: pool selector and source tree-copy both contribute to the assigned set', () => {
    // Plugin uses pool selector for skill-a and has tree-copy skill-b in its source dir
    const config = buildConfig([{ name: 'hybrid-plugin', skills: ['skill-a'] }]);
    const poolSkill = makeExternalSkill('skill-a');
    const treeSkill = makeSourceSkill('skill-b', 'hybrid-plugin');

    const result = resolveAssignedSkills(config, [poolSkill, treeSkill], PROJECT_ROOT);

    expect(result.has('skill-a')).toBe(true);
    expect(result.has('skill-b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PUBLISHED_SKILL_NOT_IN_PLUGIN check (via runConsistencyChecks)
// ---------------------------------------------------------------------------

describe('PUBLISHED_SKILL_NOT_IN_PLUGIN check', () => {
  it('does NOT flag a published skill that resides in the plugin source skills dir', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);
    const skill = makeSourceSkill(BUNDLED_SKILL, TREE_PLUGIN);

    const { issues } = runConsistencyChecks([skill], config, PROJECT_ROOT);

    const flagged = issues.filter((i) => i.code === 'PUBLISHED_SKILL_NOT_IN_PLUGIN');
    expect(flagged).toHaveLength(0);
  });

  it('STILL flags a published skill that is not assigned to any plugin', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);
    const skill = makeExternalSkill('orphan-skill');

    const { issues } = runConsistencyChecks([skill], config, PROJECT_ROOT);

    const flagged = issues.filter((i) => i.code === 'PUBLISHED_SKILL_NOT_IN_PLUGIN');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain('orphan-skill');
  });
});

// ---------------------------------------------------------------------------
// publish is read off the MERGED config: skills.defaults.publish counts
// ---------------------------------------------------------------------------

describe('publish is read through the merged packaging config', () => {
  const codesFor = (issues: Array<{ code: string }>, code: string): number =>
    issues.filter((i) => i.code === code).length;

  it('positive control: with no publish anywhere, an unassigned pool skill is PUBLISHED_SKILL_NOT_IN_PLUGIN', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);
    const { issues, summary } = runConsistencyChecks([makeExternalSkill('orphan-skill')], config, PROJECT_ROOT);
    expect(codesFor(issues, 'PUBLISHED_SKILL_NOT_IN_PLUGIN')).toBe(1);
    expect(codesFor(issues, 'SKILL_UNPUBLISHED')).toBe(0);
    expect(summary).toMatchObject({ publishedSkills: 1, unpublishedSkills: 0 });
  });

  it('honours skills.defaults.publish: false — the same skill is in-place, not an unassigned published one', () => {
    // This was red: the check read `skills.config.<name>.publish` alone, so a
    // project-wide default parsed, validated and changed nothing.
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], undefined, false);
    const { issues, summary } = runConsistencyChecks([makeExternalSkill('orphan-skill')], config, PROJECT_ROOT);
    expect(codesFor(issues, 'PUBLISHED_SKILL_NOT_IN_PLUGIN')).toBe(0);
    expect(codesFor(issues, 'SKILL_UNPUBLISHED')).toBe(1);
    expect(summary).toMatchObject({ publishedSkills: 0, unpublishedSkills: 1 });
  });

  it('lets skills.config.<name>.publish: true opt one skill back in over a false default', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], { 'orphan-skill': true }, false);
    const { issues } = runConsistencyChecks(
      [makeExternalSkill('orphan-skill'), makeExternalSkill('stays-in-place')],
      config,
      PROJECT_ROOT,
    );
    expect(issues.filter((i) => i.code === 'PUBLISHED_SKILL_NOT_IN_PLUGIN').map((i) => i.message)).toEqual([
      expect.stringContaining('orphan-skill'),
    ]);
    expect(issues.filter((i) => i.code === 'SKILL_UNPUBLISHED').map((i) => i.message)).toEqual([
      expect.stringContaining('stays-in-place'),
    ]);
  });

  it('a plugin-local skill under a false default is neither unassigned nor SKILL_UNPUBLISHED — it ships with its plugin', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], undefined, false);
    const { issues } = runConsistencyChecks([makeSourceSkill(BUNDLED_SKILL, TREE_PLUGIN)], config, PROJECT_ROOT);
    expect(codesFor(issues, 'PUBLISHED_SKILL_NOT_IN_PLUGIN')).toBe(0);
    expect(codesFor(issues, 'SKILL_UNPUBLISHED')).toBe(0);
  });

  it('a plugin selector that matches ONLY in-place skills selects nothing from the pool — PLUGIN_REFERENCES_UNKNOWN_SKILL naming publish', () => {
    // An in-place skill is never built, so the claude phase (which selects from
    // dist/skills) would silently ship the plugin without it.
    const config = buildConfig([{ name: 'pool-plugin', skills: ['in-place', 'pooled'] }], { 'in-place': false });
    const { issues } = runConsistencyChecks([makeExternalSkill('in-place'), makeExternalSkill('pooled')], config, PROJECT_ROOT);
    const refs = issues.filter((i) => i.code === 'PLUGIN_REFERENCES_UNKNOWN_SKILL');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.message).toContain('"in-place"');
    expect(refs[0]?.message).toContain('publish: false');
    expect(refs[0]?.fix).toContain('skills.config.<name>.publish');
  });

  it('a selector naming a plugin-local skill under publish: false is not flagged — it ships by location', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [BUNDLED_SKILL] }], undefined, false);
    const { issues } = runConsistencyChecks([makeSourceSkill(BUNDLED_SKILL, TREE_PLUGIN)], config, PROJECT_ROOT);
    expect(codesFor(issues, 'PLUGIN_REFERENCES_UNKNOWN_SKILL')).toBe(0);
  });

  it('SKILL_UNPUBLISHED names the in-place meaning, not "not distributed"', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], { 'in-place': false });
    const { issues } = runConsistencyChecks([makeExternalSkill('in-place')], config, PROJECT_ROOT);
    const info = issues.find((i) => i.code === 'SKILL_UNPUBLISHED');
    expect(info?.severity).toBe('info');
    expect(info?.message).toContain('in-place');
    expect(info?.message).toContain('dist/skills');
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
