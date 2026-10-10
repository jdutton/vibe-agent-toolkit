// packages/claude-marketplace/test/install/plugin-list.test.ts

// Test helper — file paths are controlled by test code, not user input

import { writeFileSync } from 'node:fs';


import { FS_FAULT_CODE, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { refuseSyncFs } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { listLocalPlugins } from '../../src/install/plugin-list.js';
import { setupPluginTestPaths } from '../test-helpers.js';

describe('listLocalPlugins', () => {
  const { getPaths } = setupPluginTestPaths({ withSkillsDir: true });

  it('returns empty lists when nothing installed', () => {
    const result = listLocalPlugins(getPaths());
    expect(result.pluginRegistry).toBe(0);
    expect(result.legacySkillsDir).toBe(0);
    expect(result.plugins).toHaveLength(0);
    expect(result.legacySkills).toHaveLength(0);
  });

  it('lists plugins from installed_plugins.json', () => {
    const paths = getPaths();
    const now = new Date().toISOString();
    writeFileSync(paths.installedPluginsPath, JSON.stringify({
      version: 2,
      plugins: {
        'my-skill@my-market': [{ scope: 'user', installPath: '/path', version: '1.2.3', installedAt: now, lastUpdated: now }],
      },
    }));
    writeFileSync(paths.knownMarketplacesPath, JSON.stringify({
      'my-market': { source: { source: 'npm', package: '@test/pkg' }, installLocation: '', lastUpdated: now },
    }));

    const result = listLocalPlugins(paths);
    expect(result.pluginRegistry).toBe(1);
    expect(result.plugins[0]).toMatchObject({
      name: 'my-skill',
      marketplace: 'my-market',
      version: '1.2.3',
      installedAt: now,
      source: 'npm',
    });
  });

  it('lists multiple plugins from installed_plugins.json', () => {
    const paths = getPaths();
    const now = new Date().toISOString();
    writeFileSync(paths.installedPluginsPath, JSON.stringify({
      version: 2,
      plugins: {
        'skill-a@market-a': [{ scope: 'user', installPath: '/path/a', version: '1.0.0', installedAt: now, lastUpdated: now }],
        'skill-b@market-b': [{ scope: 'user', installPath: '/path/b', version: '2.0.0', installedAt: now, lastUpdated: now }],
      },
    }));
    writeFileSync(paths.knownMarketplacesPath, JSON.stringify({
      'market-a': { source: { source: 'npm', package: '@test/a' }, installLocation: '', lastUpdated: now },
      'market-b': { source: { source: 'github', repo: 'org/repo' }, installLocation: '', lastUpdated: now },
    }));

    const result = listLocalPlugins(paths);
    expect(result.pluginRegistry).toBe(2);
    const names = result.plugins.map(p => p.name);
    expect(names).toContain('skill-a');
    expect(names).toContain('skill-b');
    const skillB = result.plugins.find(p => p.name === 'skill-b');
    expect(skillB?.source).toBe('github');
  });

  it('lists legacy skills from skillsDir (directories)', () => {
    const paths = getPaths();
    const skillDir = safePath.join(paths.skillsDir, 'old-skill');
    mkdirSyncReal(skillDir, { recursive: true });
    writeFileSync(safePath.join(skillDir, 'SKILL.md'), '# old-skill');

    const result = listLocalPlugins(paths);
    expect(result.legacySkillsDir).toBe(1);
    expect(result.legacySkills[0]).toMatchObject({
      name: 'old-skill',
      type: 'directory',
    });
    expect(result.legacySkills[0]?.path).toBe(skillDir);
  });

  // A parked or staged tree the tree-change primitive left beside a skill is not a skill.
  it('never lists a tree-change leftover in skillsDir as a legacy skill', () => {
    const paths = getPaths();
    for (const name of ['old-skill', '.old-skill.vat-staged-deadbeef', '.old-skill.vat-staged-0a1b2c3d.previous']) {
      mkdirSyncReal(safePath.join(paths.skillsDir, name), { recursive: true });
    }

    expect(listLocalPlugins(paths).legacySkills.map((skill) => skill.name)).toEqual(['old-skill']);
  });

  it('skips non-directory/non-symlink entries in skillsDir', () => {
    const paths = getPaths();
    // Write a plain file (not a skill dir)
    writeFileSync(safePath.join(paths.skillsDir, 'not-a-skill.txt'), 'text');

    const result = listLocalPlugins(paths);
    expect(result.legacySkillsDir).toBe(0);
    expect(result.legacySkills).toHaveLength(0);
  });

  it('propagates a skillsDir the OS refuses to list instead of reporting no legacy skills', () => {
    const paths = getPaths();
    mkdirSyncReal(safePath.join(paths.skillsDir, 'present-skill'));

    const restore = refuseSyncFs('readdirSync', paths.skillsDir, 'EACCES');
    try {
      expect(() => listLocalPlugins(paths)).toThrow(/EACCES/);
      // Classified, so a caller can tell the user's unreadable state from a VAT defect:
      // a listing only reads Claude's state, so it is this verb's input.
      let thrown: unknown;
      try {
        listLocalPlugins(paths);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'refused', path: paths.skillsDir });
    } finally {
      restore();
    }
  });

  it('returns empty when installed_plugins.json missing', () => {
    const result = listLocalPlugins(getPaths());
    expect(result.plugins).toHaveLength(0);
  });

  it('defaults source to npm when marketplace not in known_marketplaces', () => {
    const paths = getPaths();
    const now = new Date().toISOString();
    writeFileSync(paths.installedPluginsPath, JSON.stringify({
      version: 2,
      plugins: {
        'orphan-skill@unknown-market': [{ scope: 'user', installPath: '/path', version: '1.0.0', installedAt: now, lastUpdated: now }],
      },
    }));
    // No known_marketplaces.json written

    const result = listLocalPlugins(paths);
    expect(result.pluginRegistry).toBe(1);
    expect(result.plugins[0]?.source).toBe('npm');
  });

  it('skips malformed plugin keys missing the @ separator', () => {
    const paths = getPaths();
    const now = new Date().toISOString();
    writeFileSync(paths.installedPluginsPath, JSON.stringify({
      version: 2,
      plugins: {
        'no-at-sign': [{ scope: 'user', installPath: '/path', version: '1.0.0', installedAt: now, lastUpdated: now }],
        'valid-skill@market': [{ scope: 'user', installPath: '/path', version: '1.0.0', installedAt: now, lastUpdated: now }],
      },
    }));

    const result = listLocalPlugins(paths);
    expect(result.pluginRegistry).toBe(1);
    expect(result.plugins[0]?.name).toBe('valid-skill');
  });
});
