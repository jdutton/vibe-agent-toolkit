/* eslint-disable security/detect-non-literal-fs-filename -- test sandbox paths derived from controlled tmp dirs */
import { writeFileSync } from 'node:fs';

import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  computeTreeCopiedSkillLocations,
  findDistributedSkillLocationBySource,
  getPluginOutputDir,
  getPluginSourceDir,
  listPluginSourceSkillDirs,
  skillNameToFsPath,
  type DistributedSkillLocation,
} from '../src/plugin-distribution-layout.js';

import { setupTempDir } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const MARKET = 'prod';
const POOL_PLUGIN = 'pool-plugin';
const TREE_PLUGIN = 'tree-plugin';
const TREE_SOURCE = 'vendors/tree';
const SKILL_ONE = 'skill-one';
const SKILL_TWO = 'skill-two';
const REAL_SKILL = 'real-skill';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a two-plugin ProjectConfig for computeTreeCopiedSkillLocations tests. */
function makeTwoPluginConfig(): ProjectConfig {
  return {
    version: 1,
    claude: {
      marketplaces: {
        [MARKET]: {
          owner: { name: 'Test Owner' },
          plugins: [
            {
              name: POOL_PLUGIN,
              skills: '*',
              // No source → uses plugins/<name>; no skills/ dir created in tests
            },
            {
              name: TREE_PLUGIN,
              skills: [],
              source: TREE_SOURCE,
            },
          ],
        },
      },
    },
  };
}

/** Create a skill directory (its `SKILL.md` is what MAKES it a skill). */
function writeSkillDir(skillsDir: string, dirPath: string): void {
  const dir = safePath.join(skillsDir, dirPath);
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(safePath.join(dir, 'SKILL.md'), `# ${dirPath}\n`);
}

/**
 * Create a plugin source directory structure under tempDir.
 *
 * Creates:
 *   <tempDir>/<sourceRelPath>/skills/<skillDirPaths[i]>/SKILL.md
 *   <tempDir>/<sourceRelPath>/skills/README.md             (stray file — must be excluded)
 */
function createPluginSourceTree(
  tempDir: string,
  sourceRelPath: string,
  skillDirPaths: string[],
): void {
  const skillsDir = safePath.join(tempDir, sourceRelPath, 'skills');
  mkdirSyncReal(skillsDir, { recursive: true });
  writeFileSync(safePath.join(skillsDir, 'README.md'), '# skills\n');
  for (const dirPath of skillDirPaths) {
    writeSkillDir(skillsDir, dirPath);
  }
}

/** Pool-plugin dir + a source tree carrying `skills`; returns the temp root + config. */
function setupTreeFixture(
  getTempDir: () => string,
  skills: string[] = [SKILL_ONE],
): { tempDir: string; config: ProjectConfig } {
  const tempDir = getTempDir();
  const config = makeTwoPluginConfig();
  mkdirSyncReal(safePath.join(tempDir, 'plugins', POOL_PLUGIN), { recursive: true });
  createPluginSourceTree(tempDir, TREE_SOURCE, skills);
  return { tempDir, config };
}

// ---------------------------------------------------------------------------
// getPluginOutputDir
// ---------------------------------------------------------------------------

describe('getPluginOutputDir', () => {
  it('constructs the expected dist path with forward slashes', () => {
    const result = getPluginOutputDir('/project', 'my-market', 'my-plugin');
    expect(toForwardSlash(result)).toBe(
      '/project/dist/.claude/plugins/marketplaces/my-market/plugins/my-plugin',
    );
  });

  it('handles multi-segment configDir correctly', () => {
    const result = getPluginOutputDir('/home/user/project', 'acme', 'core-plugin');
    expect(toForwardSlash(result)).toBe(
      '/home/user/project/dist/.claude/plugins/marketplaces/acme/plugins/core-plugin',
    );
  });
});

// ---------------------------------------------------------------------------
// getPluginSourceDir
// ---------------------------------------------------------------------------

describe('getPluginSourceDir', () => {
  it('defaults to plugins/<name> when source is absent', () => {
    const result = getPluginSourceDir('/project', { name: 'my-plugin' });
    expect(toForwardSlash(result)).toBe('/project/plugins/my-plugin');
  });

  it('uses plugin.source when provided', () => {
    const result = getPluginSourceDir('/project', {
      name: 'my-plugin',
      source: 'vendors/custom-src',
    });
    expect(toForwardSlash(result)).toBe('/project/vendors/custom-src');
  });

  it('handles a deeply nested source path', () => {
    const result = getPluginSourceDir('/project', { name: 'x', source: 'nested/deep/src' });
    expect(toForwardSlash(result)).toBe('/project/nested/deep/src');
  });
});

// ---------------------------------------------------------------------------
// listPluginSourceSkillDirs
// ---------------------------------------------------------------------------

describe('listPluginSourceSkillDirs', () => {
  const { getTempDir } = setupTempDir('vat-plugin-layout-list-');

  it('returns [] when the plugin source dir has no skills/ subdirectory', () => {
    const pluginSourceDir = safePath.join(getTempDir(), 'no-skills-plugin');
    mkdirSyncReal(pluginSourceDir, { recursive: true });

    expect(listPluginSourceSkillDirs(pluginSourceDir)).toEqual([]);
  });

  it('returns [] when the plugin source dir does not exist at all', () => {
    const pluginSourceDir = safePath.join(getTempDir(), 'nonexistent-plugin');
    expect(listPluginSourceSkillDirs(pluginSourceDir)).toEqual([]);
  });

  it('returns only skill directories, skipping stray files', () => {
    const pluginSourceDir = safePath.join(getTempDir(), 'multi-skill-plugin');
    const skillsDir = safePath.join(pluginSourceDir, 'skills');
    writeSkillDir(skillsDir, 'skill-alpha');
    writeSkillDir(skillsDir, 'skill-beta');
    writeFileSync(safePath.join(skillsDir, 'README.md'), '# skills\n');
    writeFileSync(safePath.join(skillsDir, 'index.json'), '{}');

    const result = listPluginSourceSkillDirs(pluginSourceDir);
    expect([...result].sort((a, b) => a.localeCompare(b))).toEqual(['skill-alpha', 'skill-beta']);
  });

  it('returns a single skill dir when only one is present', () => {
    const pluginSourceDir = safePath.join(getTempDir(), 'single-skill-plugin');
    writeSkillDir(safePath.join(pluginSourceDir, 'skills'), 'only-skill');

    expect(listPluginSourceSkillDirs(pluginSourceDir)).toEqual(['only-skill']);
  });

  it('omits directories that hold no SKILL.md — they are not skills', () => {
    const pluginSourceDir = safePath.join(getTempDir(), 'helper-dirs-plugin');
    const skillsDir = safePath.join(pluginSourceDir, 'skills');
    writeSkillDir(skillsDir, REAL_SKILL);
    // A shared helper dir and a template dir: no packager produces these, so the
    // plugin build's tree-copy is their only route into the bundle. Listing them
    // here is what once got them excluded from the tree-copy AND skipped by the
    // packager — shipping nowhere.
    mkdirSyncReal(safePath.join(skillsDir, 'shared'), { recursive: true });
    writeFileSync(safePath.join(skillsDir, 'shared', 'helper.md'), '# helper\n');
    mkdirSyncReal(safePath.join(skillsDir, '_templates'), { recursive: true });

    expect(listPluginSourceSkillDirs(pluginSourceDir)).toEqual([REAL_SKILL]);
  });

  it('finds NESTED skills and reports them as paths, not bare names', () => {
    const pluginSourceDir = safePath.join(getTempDir(), 'nested-skill-plugin');
    const skillsDir = safePath.join(pluginSourceDir, 'skills');
    writeSkillDir(skillsDir, 'flat');
    writeSkillDir(skillsDir, 'group/nested');

    // Claude Code loads `skills/<group>/<skill>/SKILL.md`, so it is a real skill and
    // must be packaged. A non-recursive listing left it to the verbatim tree-copy,
    // which shipped its eval suite (answer key included) and produced it twice when
    // the same skill was also selected from the pool.
    expect([...listPluginSourceSkillDirs(pluginSourceDir)].sort((a, b) => a.localeCompare(b)))
      .toEqual(['flat', 'group/nested']);
  });

  it('returns only the OUTERMOST skill when one skill dir contains another', () => {
    const pluginSourceDir = safePath.join(getTempDir(), 'skill-in-skill-plugin');
    const skillsDir = safePath.join(pluginSourceDir, 'skills');
    writeSkillDir(skillsDir, 'outer');
    writeSkillDir(skillsDir, 'outer/inner');

    // The inner dir is part of the outer skill's own tree; packaging both would have
    // the inner packager write into a directory the outer packager owns.
    expect(listPluginSourceSkillDirs(pluginSourceDir)).toEqual(['outer']);
  });

  it('ignores a SKILL.md sitting directly in skills/ rather than treating the whole tree as one skill', () => {
    const pluginSourceDir = safePath.join(getTempDir(), 'stray-skillmd-plugin');
    const skillsDir = safePath.join(pluginSourceDir, 'skills');
    writeSkillDir(skillsDir, REAL_SKILL);
    mkdirSyncReal(skillsDir, { recursive: true });
    writeFileSync(safePath.join(skillsDir, 'SKILL.md'), '# stray\n');

    expect(listPluginSourceSkillDirs(pluginSourceDir)).toEqual([REAL_SKILL]);
  });
});

// ---------------------------------------------------------------------------
// computeTreeCopiedSkillLocations
// ---------------------------------------------------------------------------

describe('computeTreeCopiedSkillLocations', () => {
  const { getTempDir } = setupTempDir('vat-plugin-layout-compute-');

  it('returns [] when config has no claude section', () => {
    const config: ProjectConfig = { version: 1 };
    expect(computeTreeCopiedSkillLocations(config, getTempDir())).toEqual([]);
  });

  it('returns [] when config has no marketplaces', () => {
    const config: ProjectConfig = { version: 1, claude: {} };
    expect(computeTreeCopiedSkillLocations(config, getTempDir())).toEqual([]);
  });

  it('pool-only plugin with no source skills/ dir contributes no locations', () => {
    const tempDir = getTempDir();
    const config = makeTwoPluginConfig();

    // Create pool plugin source dir without skills/ subdir
    mkdirSyncReal(safePath.join(tempDir, 'plugins', POOL_PLUGIN), { recursive: true });
    // Do NOT create vendors/tree/skills/ → tree-plugin also contributes nothing

    const result = computeTreeCopiedSkillLocations(config, tempDir);
    expect(result).toEqual([]);
  });

  it('tree-copy plugin with two source skill dirs emits two locations', () => {
    const tempDir = getTempDir();
    const config = makeTwoPluginConfig();

    // Pool plugin: source dir exists but no skills/ → no locations
    mkdirSyncReal(safePath.join(tempDir, 'plugins', POOL_PLUGIN), { recursive: true });

    // Tree-copy plugin: source dir with two skill dirs + stray file
    createPluginSourceTree(tempDir, TREE_SOURCE, [SKILL_ONE, SKILL_TWO]);

    const result = computeTreeCopiedSkillLocations(config, tempDir);
    expect(result).toHaveLength(2);

    const expectedOutputBase = toForwardSlash(
      safePath.join(
        tempDir, 'dist', '.claude', 'plugins', 'marketplaces', MARKET, 'plugins', TREE_PLUGIN,
      ),
    );

    const expectedSourceBase = toForwardSlash(safePath.join(tempDir, TREE_SOURCE));

    const one = result.find(loc => loc.skillDirPath === SKILL_ONE) as DistributedSkillLocation;
    expect(one).toBeDefined();
    expect(one.marketplaceName).toBe(MARKET);
    expect(one.pluginName).toBe(TREE_PLUGIN);
    expect(toForwardSlash(one.skillOutputDir)).toBe(`${expectedOutputBase}/skills/${SKILL_ONE}`);
    expect(toForwardSlash(one.skillSourceDir)).toBe(`${expectedSourceBase}/skills/${SKILL_ONE}`);

    const two = result.find(loc => loc.skillDirPath === SKILL_TWO) as DistributedSkillLocation;
    expect(two).toBeDefined();
    expect(two.marketplaceName).toBe(MARKET);
    expect(two.pluginName).toBe(TREE_PLUGIN);
    expect(toForwardSlash(two.skillOutputDir)).toBe(`${expectedOutputBase}/skills/${SKILL_TWO}`);
    expect(toForwardSlash(two.skillSourceDir)).toBe(`${expectedSourceBase}/skills/${SKILL_TWO}`);
  });

  it('stray files under skills/ are excluded from locations', () => {
    const tempDir = getTempDir();
    const config: ProjectConfig = {
      version: 1,
      claude: {
        marketplaces: {
          test: {
            owner: { name: 'Tester' },
            plugins: [{ name: 'my-plugin', skills: [], source: 'src/my-plugin' }],
          },
        },
      },
    };

    // One skill dir + one stray file; only the skill should yield a location
    const skillsDir = safePath.join(tempDir, 'src', 'my-plugin', 'skills');
    writeSkillDir(skillsDir, REAL_SKILL);
    writeFileSync(safePath.join(skillsDir, 'NOTES.md'), '# notes\n');

    const result = computeTreeCopiedSkillLocations(config, tempDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.skillDirPath).toBe(REAL_SKILL);
  });
});

// ---------------------------------------------------------------------------
// skillNameToFsPath
// ---------------------------------------------------------------------------

describe('skillNameToFsPath', () => {
  it('replaces colons with double underscores', () => {
    expect(skillNameToFsPath('pkg:sub')).toBe('pkg__sub');
  });

  it('replaces every colon in a multi-segment name', () => {
    expect(skillNameToFsPath('a:b:c')).toBe('a__b__c');
  });

  it('leaves a plain name unchanged', () => {
    expect(skillNameToFsPath('plain')).toBe('plain');
  });
});

// ---------------------------------------------------------------------------
// findDistributedSkillLocationBySource
// ---------------------------------------------------------------------------

describe('findDistributedSkillLocationBySource', () => {
  const { getTempDir } = setupTempDir('vat-plugin-layout-by-source-');

  it('returns the matching location for a known source skill dir', () => {
    const { tempDir, config } = setupTreeFixture(getTempDir, [SKILL_ONE, SKILL_TWO]);

    const skillSourceDir = safePath.join(tempDir, TREE_SOURCE, 'skills', SKILL_ONE);
    const match = findDistributedSkillLocationBySource(config, tempDir, skillSourceDir);

    expect(match).toBeDefined();
    expect(match?.skillDirPath).toBe(SKILL_ONE);
    expect(match?.pluginName).toBe(TREE_PLUGIN);
    expect(toForwardSlash(match?.skillSourceDir ?? '')).toBe(
      toForwardSlash(skillSourceDir),
    );
  });

  it('matches across path forms (resolves before comparing)', () => {
    const { tempDir, config } = setupTreeFixture(getTempDir);

    const unnormalized = safePath.join(tempDir, TREE_SOURCE, 'skills', '.', SKILL_ONE);
    const match = findDistributedSkillLocationBySource(config, tempDir, unnormalized);

    expect(match?.skillDirPath).toBe(SKILL_ONE);
  });

  it('returns undefined for a source dir not declared in any plugin', () => {
    const { tempDir, config } = setupTreeFixture(getTempDir);

    const unknown = safePath.join(tempDir, TREE_SOURCE, 'skills', 'not-a-skill');
    expect(findDistributedSkillLocationBySource(config, tempDir, unknown)).toBeUndefined();
  });

  it('returns undefined when no tree-copied locations exist (pool-only)', () => {
    const tempDir = getTempDir();
    const config = makeTwoPluginConfig();

    mkdirSyncReal(safePath.join(tempDir, 'plugins', POOL_PLUGIN), { recursive: true });

    const anyPath = safePath.join(tempDir, 'plugins', POOL_PLUGIN, 'skills', 'x');
    expect(findDistributedSkillLocationBySource(config, tempDir, anyPath)).toBeUndefined();
  });
});
