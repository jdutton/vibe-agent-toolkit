/* eslint-disable security/detect-non-literal-fs-filename -- test sandbox paths derived from controlled tmp dirs */
import { writeFileSync } from 'node:fs';

import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  computeTreeCopiedSkillLocations,
  getPluginOutputDir,
  getPluginSourceDir,
  listPluginSourceSkillDirs,
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

/**
 * Create a source-tree-copy plugin directory structure under tempDir.
 *
 * Creates:
 *   <tempDir>/<sourceRelPath>/skills/<skillDirNames[i]>/  (dirs)
 *   <tempDir>/<sourceRelPath>/skills/README.md             (stray file — must be excluded)
 */
function createPluginSourceTree(
  tempDir: string,
  sourceRelPath: string,
  skillDirNames: string[],
): void {
  const skillsDir = safePath.join(tempDir, sourceRelPath, 'skills');
  mkdirSyncReal(skillsDir, { recursive: true });
  writeFileSync(safePath.join(skillsDir, 'README.md'), '# skills\n');
  for (const name of skillDirNames) {
    mkdirSyncReal(safePath.join(skillsDir, name), { recursive: true });
  }
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

  it('returns only directory names, skipping stray files', () => {
    const pluginSourceDir = safePath.join(getTempDir(), 'multi-skill-plugin');
    const skillsDir = safePath.join(pluginSourceDir, 'skills');
    mkdirSyncReal(safePath.join(skillsDir, 'skill-alpha'), { recursive: true });
    mkdirSyncReal(safePath.join(skillsDir, 'skill-beta'), { recursive: true });
    writeFileSync(safePath.join(skillsDir, 'README.md'), '# skills\n');
    writeFileSync(safePath.join(skillsDir, 'index.json'), '{}');

    const result = listPluginSourceSkillDirs(pluginSourceDir);
    expect([...result].sort((a, b) => a.localeCompare(b))).toEqual(['skill-alpha', 'skill-beta']);
  });

  it('returns a single skill dir when only one is present', () => {
    const pluginSourceDir = safePath.join(getTempDir(), 'single-skill-plugin');
    mkdirSyncReal(safePath.join(pluginSourceDir, 'skills', 'only-skill'), { recursive: true });

    expect(listPluginSourceSkillDirs(pluginSourceDir)).toEqual(['only-skill']);
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

    const one = result.find(loc => loc.skillDirName === SKILL_ONE) as DistributedSkillLocation;
    expect(one).toBeDefined();
    expect(one.marketplaceName).toBe(MARKET);
    expect(one.pluginName).toBe(TREE_PLUGIN);
    expect(toForwardSlash(one.skillOutputDir)).toBe(`${expectedOutputBase}/skills/${SKILL_ONE}`);

    const two = result.find(loc => loc.skillDirName === SKILL_TWO) as DistributedSkillLocation;
    expect(two).toBeDefined();
    expect(two.marketplaceName).toBe(MARKET);
    expect(two.pluginName).toBe(TREE_PLUGIN);
    expect(toForwardSlash(two.skillOutputDir)).toBe(`${expectedOutputBase}/skills/${SKILL_TWO}`);
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

    // One dir + one stray file; only the dir should yield a location
    const skillsDir = safePath.join(tempDir, 'src', 'my-plugin', 'skills');
    mkdirSyncReal(safePath.join(skillsDir, 'real-skill'), { recursive: true });
    writeFileSync(safePath.join(skillsDir, 'NOTES.md'), '# notes\n');

    const result = computeTreeCopiedSkillLocations(config, tempDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.skillDirName).toBe('real-skill');
  });
});
