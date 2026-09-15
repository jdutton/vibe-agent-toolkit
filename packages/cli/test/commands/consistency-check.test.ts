/**
 * Unit tests for resolveAssignedSkills and the PUBLISHED_SKILL_NOT_IN_PLUGIN
 * check in consistency-check.ts.
 *
 * A pool skill is judged by name and config alone, so those cases stay in memory.
 * A PLUGIN-LOCAL skill is judged by what the plugin build ships — the git-visible
 * skill directories under a plugin's `skills/` dir — so those cases write a real
 * project to a temp dir (each skill in a directory NOT named after it).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { indexPluginLocalSkills } from '@vibe-agent-toolkit/agent-skills';
import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  readVatSkillsFromPackageJson,
  resolveAssignedSkills,
  runConsistencyChecks,
} from '../../src/commands/consistency-check.js';
import type { DiscoveredSkill } from '../../src/commands/skills/command-helpers.js';
import { writeSkillProject } from '../helpers/plugin-local-fixture.js';
import { createTempDirTracker } from '../system/test-common.js';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

/** Fake project root for the in-memory (pool-only) cases — nothing is listed under it. */
const PROJECT_ROOT = safePath.join(normalizedTmpdir(), 'no-such-project-cc');

// Reusable string constants to satisfy sonarjs/no-duplicate-string (3+ occurrences trigger it).
const TREE_PLUGIN = 'tree-plugin';
const BUNDLED_SKILL = 'bundled-skill';
const LOOK_ALIKE = 'look-alike';
const UNPUBLISHED = 'SKILL_UNPUBLISHED';
const NOT_IN_PLUGIN = 'PUBLISHED_SKILL_NOT_IN_PLUGIN';

const tempDirs = createTempDirTracker('vat-cc-plugin-local-');

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

/** A skill under `<root>/plugins/<plugin>/<skillsDir>/<name>-dir/`, as `writeSkillProject` wants it. */
interface SourceSkill {
  name: string;
  plugin: string;
  /** The directory under the plugin source dir — `skills` unless a test says otherwise. */
  skillsDir?: string;
}

/**
 * Write each skill under a fresh temp root — its directory is `<name>-dir`, never its
 * name — and return the root plus the skills as discovery would report them.
 * `untracked` names skills to leave un-`git add`ed in a real repository.
 */
function sourceProject(
  skills: readonly SourceSkill[],
  untracked: readonly string[] = [],
): { root: string; discovered: DiscoveredSkill[] } {
  const root = tempDirs.createTempDir();
  const dirOf = (s: SourceSkill): string => `plugins/${s.plugin}/${s.skillsDir ?? 'skills'}/${s.name}-dir`;
  const git = untracked.length === 0
    ? 'none'
    : { untracked: skills.filter((s) => untracked.includes(s.name)).map((s) => dirOf(s)) };
  const discovered = writeSkillProject(root, skills.map((s) => ({ dir: dirOf(s), name: s.name })), git);
  return { root, discovered };
}

/**
 * Build a DiscoveredSkill that lives completely outside any plugin source tree.
 */
function makeExternalSkill(skillName: string, root: string = PROJECT_ROOT): DiscoveredSkill {
  return {
    name: skillName,
    sourcePath: safePath.join(root, 'standalone-skills', skillName, 'SKILL.md'),
  };
}

/** `resolveAssignedSkills` against the plugin-local index the consistency check itself builds. */
function assigned(config: ProjectConfig, skills: DiscoveredSkill[], root: string = PROJECT_ROOT): Set<string> {
  return resolveAssignedSkills(config, skills, indexPluginLocalSkills(config, root));
}

const codesFor = (issues: Array<{ code: string }>, code: string): number =>
  issues.filter((i) => i.code === code).length;

/**
 * Run the consistency check over ONE plugin-local skill ({@link BUNDLED_SKILL} in
 * {@link TREE_PLUGIN}), selected by `selector` (none by default), under
 * `skills.defaults.publish: defaultPublish`, optionally left untracked by git.
 */
function checkBundledSkill(
  options: { selector?: string[]; defaultPublish?: boolean; untracked?: boolean } = {},
): ReturnType<typeof runConsistencyChecks>['issues'] {
  const config = buildConfig([{ name: TREE_PLUGIN, skills: options.selector ?? [] }], undefined, options.defaultPublish);
  const { root, discovered } = sourceProject(
    [{ name: BUNDLED_SKILL, plugin: TREE_PLUGIN }],
    options.untracked === true ? [BUNDLED_SKILL] : [],
  );
  return runConsistencyChecks(discovered, config, root).issues;
}

// ---------------------------------------------------------------------------
// resolveAssignedSkills
// ---------------------------------------------------------------------------

describe('resolveAssignedSkills', () => {
  afterEach(() => tempDirs.cleanupTempDirs());

  it('returns an empty set when no marketplaces are configured', () => {
    const config: ProjectConfig = { version: 1 };
    expect(assigned(config, [makeExternalSkill('foo')]).size).toBe(0);
  });

  it('assigns a skill matched by a pool name selector', () => {
    const config = buildConfig([{ name: 'pool-plugin', skills: ['my-skill'] }]);

    expect(assigned(config, [makeExternalSkill('my-skill')]).has('my-skill')).toBe(true);
  });

  it('assigns all published skills when pool selector is "*"', () => {
    const config = buildConfig([{ name: 'pool-plugin', skills: '*' }]);

    const result = assigned(config, [makeExternalSkill('skill-a'), makeExternalSkill('skill-b')]);

    expect(result.has('skill-a')).toBe(true);
    expect(result.has('skill-b')).toBe(true);
  });

  it('assigns a published skill whose source dir is a plugin skill dir', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);
    const { root, discovered } = sourceProject([{ name: BUNDLED_SKILL, plugin: TREE_PLUGIN }]);

    expect(assigned(config, discovered, root).has(BUNDLED_SKILL)).toBe(true);
  });

  it('does NOT assign a skill whose sourcePath is outside every plugin source skills dir', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);

    expect(assigned(config, [makeExternalSkill('unassigned-skill')]).has('unassigned-skill')).toBe(false);
  });

  it('enforces path-separator boundary: skill under skills-extra/ is not matched', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);
    const { root, discovered } = sourceProject([{ name: LOOK_ALIKE, plugin: TREE_PLUGIN, skillsDir: 'skills-extra' }]);

    expect(assigned(config, discovered, root).has(LOOK_ALIKE)).toBe(false);
  });

  it('does NOT assign an UNTRACKED skill under a plugin skills/ dir — the plugin build does not ship it', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);
    const { root, discovered } = sourceProject([{ name: BUNDLED_SKILL, plugin: TREE_PLUGIN }], [BUNDLED_SKILL]);

    expect(assigned(config, discovered, root).has(BUNDLED_SKILL)).toBe(false);
  });

  it('assigns a publish: false skill under the plugin source dir — plugin-local assignment is by LOCATION, outside publish\'s scope', () => {
    // `publish` scopes the pool only. A plugin-local skill ships with its plugin
    // whatever the flag says (the claude phase packages it, verify expects it), so
    // it is assigned by where it sits — not left unassigned by a flag about a
    // bundle it never had.
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], { 'private-skill': false });
    const { root, discovered } = sourceProject([{ name: 'private-skill', plugin: TREE_PLUGIN }]);

    expect(assigned(config, discovered, root).has('private-skill')).toBe(true);
  });

  it('does NOT let a pool selector pick up a publish: false skill — it is not in the pool', () => {
    const config = buildConfig([{ name: 'pool-plugin', skills: '*' }], { 'in-place': false });
    const result = assigned(config, [makeExternalSkill('in-place'), makeExternalSkill('pooled')]);
    expect(result.has('in-place')).toBe(false);
    expect(result.has('pooled')).toBe(true);
  });

  it('is additive: pool selector and source tree-copy both contribute to the assigned set', () => {
    const config = buildConfig([{ name: 'hybrid-plugin', skills: ['skill-a'] }]);
    const { root, discovered } = sourceProject([{ name: 'skill-b', plugin: 'hybrid-plugin' }]);

    const result = assigned(config, [makeExternalSkill('skill-a', root), ...discovered], root);

    expect(result.has('skill-a')).toBe(true);
    expect(result.has('skill-b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PUBLISHED_SKILL_NOT_IN_PLUGIN check (via runConsistencyChecks)
// ---------------------------------------------------------------------------

describe('PUBLISHED_SKILL_NOT_IN_PLUGIN check', () => {
  afterEach(() => tempDirs.cleanupTempDirs());

  it('does NOT flag a published skill that resides in the plugin source skills dir', () => {
    expect(codesFor(checkBundledSkill(), NOT_IN_PLUGIN)).toBe(0);
  });

  it('STILL flags a published skill that is not assigned to any plugin', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);

    const { issues } = runConsistencyChecks([makeExternalSkill('orphan-skill')], config, PROJECT_ROOT);

    const flagged = issues.filter((i) => i.code === NOT_IN_PLUGIN);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain('orphan-skill');
  });

  it('flags a published UNTRACKED skill under a plugin skills/ dir, and the fix names git add', () => {
    const flagged = checkBundledSkill({ untracked: true }).filter((i) => i.code === NOT_IN_PLUGIN);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.fix).toContain('git add');
  });
});

// ---------------------------------------------------------------------------
// publish is read off the MERGED config: skills.defaults.publish counts
// ---------------------------------------------------------------------------

describe('publish is read through the merged packaging config', () => {
  afterEach(() => tempDirs.cleanupTempDirs());

  it('positive control: with no publish anywhere, an unassigned pool skill is PUBLISHED_SKILL_NOT_IN_PLUGIN', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }]);
    const { issues, summary } = runConsistencyChecks([makeExternalSkill('orphan-skill')], config, PROJECT_ROOT);
    expect(codesFor(issues, NOT_IN_PLUGIN)).toBe(1);
    expect(codesFor(issues, UNPUBLISHED)).toBe(0);
    expect(summary).toMatchObject({ publishedSkills: 1, unpublishedSkills: 0 });
  });

  it('honours skills.defaults.publish: false — the same skill is in-place, not an unassigned published one', () => {
    // This was red: the check read `skills.config.<name>.publish` alone, so a
    // project-wide default parsed, validated and changed nothing.
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], undefined, false);
    const { issues, summary } = runConsistencyChecks([makeExternalSkill('orphan-skill')], config, PROJECT_ROOT);
    expect(codesFor(issues, NOT_IN_PLUGIN)).toBe(0);
    expect(codesFor(issues, UNPUBLISHED)).toBe(1);
    expect(summary).toMatchObject({ publishedSkills: 0, unpublishedSkills: 1 });
  });

  it('lets skills.config.<name>.publish: true opt one skill back in over a false default', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], { 'orphan-skill': true }, false);
    const { issues } = runConsistencyChecks(
      [makeExternalSkill('orphan-skill'), makeExternalSkill('stays-in-place')],
      config,
      PROJECT_ROOT,
    );
    expect(issues.filter((i) => i.code === NOT_IN_PLUGIN).map((i) => i.message)).toEqual([
      expect.stringContaining('orphan-skill'),
    ]);
    expect(issues.filter((i) => i.code === UNPUBLISHED).map((i) => i.message)).toEqual([
      expect.stringContaining('stays-in-place'),
    ]);
  });

  it('a plugin-local skill under a false default is neither unassigned nor SKILL_UNPUBLISHED — it ships with its plugin', () => {
    const issues = checkBundledSkill({ defaultPublish: false });

    expect(codesFor(issues, NOT_IN_PLUGIN)).toBe(0);
    expect(codesFor(issues, UNPUBLISHED)).toBe(0);
  });

  it('an UNTRACKED skill under a plugin skills/ dir under a false default IS SKILL_UNPUBLISHED — it ships nowhere', () => {
    const issues = checkBundledSkill({ defaultPublish: false, untracked: true });

    expect(issues.filter((i) => i.code === UNPUBLISHED).map((i) => i.message)).toEqual([
      expect.stringContaining(BUNDLED_SKILL),
    ]);
  });

  it('a repo-only skill sharing its declared name with a plugin-local one still gets SKILL_UNPUBLISHED', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], undefined, false);
    const { root, discovered } = sourceProject([{ name: BUNDLED_SKILL, plugin: TREE_PLUGIN }]);

    const { issues } = runConsistencyChecks([makeExternalSkill(BUNDLED_SKILL, root), ...discovered], config, root);

    expect(codesFor(issues, UNPUBLISHED)).toBe(1);
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
    const issues = checkBundledSkill({ selector: [BUNDLED_SKILL], defaultPublish: false });

    expect(codesFor(issues, 'PLUGIN_REFERENCES_UNKNOWN_SKILL')).toBe(0);
  });

  it('SKILL_UNPUBLISHED names the in-place meaning, not "not distributed"', () => {
    const config = buildConfig([{ name: TREE_PLUGIN, skills: [] }], { 'in-place': false });
    const { issues } = runConsistencyChecks([makeExternalSkill('in-place')], config, PROJECT_ROOT);
    const info = issues.find((i) => i.code === UNPUBLISHED);
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
