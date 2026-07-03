/**
 * Unit tests for resolveAssignedSkills and the PUBLISHED_SKILL_NOT_IN_PLUGIN
 * check in consistency-check.ts.
 *
 * All tests are in-memory — no file system access required because
 * resolveAssignedSkills performs only path-string comparisons against
 * the pre-computed DiscoveredSkill.sourcePath values.
 */

import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { resolveAssignedSkills, runConsistencyChecks } from '../../src/commands/consistency-check.js';
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
  skillPublishOverrides?: Record<string, boolean>
): ProjectConfig {
  const skillsSection = skillPublishOverrides
    ? {
        skills: {
          include: ['skills/**/SKILL.md'],
          config: Object.fromEntries(
            Object.entries(skillPublishOverrides).map(([k, v]) => [k, { publish: v }])
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

  it('does NOT assign an unpublished skill even when its sourcePath is under the plugin source dir', () => {
    const config = buildConfig(
      [{ name: TREE_PLUGIN, skills: [] }],
      { 'private-skill': false },
    );
    const skill = makeSourceSkill('private-skill', TREE_PLUGIN);

    const result = resolveAssignedSkills(config, [skill], PROJECT_ROOT);

    expect(result.has('private-skill')).toBe(false);
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
