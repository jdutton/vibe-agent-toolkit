// packages/claude-marketplace/test/install/plugin-uninstall.test.ts

// Test helper — file paths are controlled by test code, not user input

import { existsSync, readFileSync, writeFileSync } from 'node:fs';


import { isVatError, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { refuseSyncFs } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { CLAUDE_USER_STATE_UNREADABLE_CODE, CLAUDE_USER_STATE_WRITE_FAILED_CODE, PLUGIN_KEY_INVALID_CODE } from '../../src/install/plugin-registry.js';
import { findPluginsByPackage, parsePluginKey, uninstallPlugin } from '../../src/install/plugin-uninstall.js';
import type { ClaudeUserPaths } from '../../src/paths/claude-paths.js';
import { setupPluginTestPaths } from '../test-helpers.js';

function setupInstalledPlugin(
  paths: ClaudeUserPaths,
  pluginName: string,
  marketplace: string,
  npmPackage: string,
  version = '1.0.0',
): void {
  const pluginKey = `${pluginName}@${marketplace}`;

  // Artifact 1: marketplaces dir
  const mpPluginDir = safePath.join(paths.marketplacesDir, marketplace, 'plugins', pluginName);
  mkdirSyncReal(mpPluginDir, { recursive: true });
  writeFileSync(safePath.join(mpPluginDir, 'SKILL.md'), `# ${pluginName}`);

  // Artifact 2: cache dir
  const cacheDir = safePath.join(paths.pluginsCacheDir, marketplace, pluginName, version);
  mkdirSyncReal(cacheDir, { recursive: true });
  writeFileSync(safePath.join(cacheDir, 'SKILL.md'), `# ${pluginName}`);

  // Artifact 3: installed_plugins.json
  writeFileSync(paths.installedPluginsPath, JSON.stringify({
    version: 2,
    plugins: {
      [pluginKey]: [{ scope: 'user', installPath: cacheDir, version, installedAt: '', lastUpdated: '' }],
    },
  }));

  // Artifact 4: known_marketplaces.json
  writeFileSync(paths.knownMarketplacesPath, JSON.stringify({
    [marketplace]: { source: { source: 'npm', package: npmPackage, version }, installLocation: '', lastUpdated: '' },
  }));

  // Artifact 5: settings.json
  writeFileSync(paths.userSettingsPath, JSON.stringify({ enabledPlugins: { [pluginKey]: true } }));
}

describe('uninstallPlugin', () => {
  const { getPaths } = setupPluginTestPaths();

  it('removes all 5 artifacts for a registered plugin', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');
    const result = await uninstallPlugin({ pluginKey: 'my-skill@my-market', paths });

    expect(result.removed).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(existsSync(safePath.join(paths.marketplacesDir, 'my-market', 'plugins', 'my-skill'))).toBe(false);
    expect(existsSync(safePath.join(paths.pluginsCacheDir, 'my-market', 'my-skill'))).toBe(false);
    // installed_plugins.json: key removed
    const ip = JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8'));
    expect(ip.plugins['my-skill@my-market']).toBeUndefined();
    // known_marketplaces.json: removed (last plugin)
    const km = JSON.parse(readFileSync(paths.knownMarketplacesPath, 'utf-8'));
    expect(km['my-market']).toBeUndefined();
    // settings.json: enabledPlugins key removed
    const s = JSON.parse(readFileSync(paths.userSettingsPath, 'utf-8'));
    expect(s.enabledPlugins?.['my-skill@my-market']).toBeUndefined();
  });

  it('is idempotent: exits cleanly when plugin not installed', async () => {
    const result = await uninstallPlugin({ pluginKey: 'missing@market', paths: getPaths() });
    expect(result.removed).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it('preserves other plugins in known_marketplaces when marketplace has remaining plugins', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'skill-a', 'shared-market', '@test/pkg-a');
    // Add a second plugin to the same marketplace
    const pluginBDir = safePath.join(paths.marketplacesDir, 'shared-market', 'plugins', 'skill-b');
    mkdirSyncReal(pluginBDir, { recursive: true });
    const ip = JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8'));
    ip.plugins['skill-b@shared-market'] = [{ scope: 'user', installPath: '', version: '1.0.0', installedAt: '', lastUpdated: '' }];
    writeFileSync(paths.installedPluginsPath, JSON.stringify(ip));

    await uninstallPlugin({ pluginKey: 'skill-a@shared-market', paths });

    const km = JSON.parse(readFileSync(paths.knownMarketplacesPath, 'utf-8'));
    expect(km['shared-market']).toBeDefined(); // still has skill-b
  });

  it('dry-run: returns removed=true but does not touch filesystem', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');
    const result = await uninstallPlugin({ pluginKey: 'my-skill@my-market', paths, dryRun: true });
    expect(result.removed).toBe(true);
    expect(existsSync(safePath.join(paths.marketplacesDir, 'my-market', 'plugins', 'my-skill'))).toBe(true);
  });

  it.each(['installedPluginsPath', 'userSettingsPath'] as const)(
    'codes a %s write it could not make as CLAUDE_USER_STATE_WRITE_FAILED, never an uncoded throw',
    async (file) => {
      const paths = getPaths();
      setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');
      const restore = refuseSyncFs('writeFileSync', paths[file], 'EACCES');
      let thrown: unknown;
      try {
        await uninstallPlugin({ pluginKey: 'my-skill@my-market', paths });
      } catch (error) {
        thrown = error;
      } finally {
        restore();
      }
      expect(isVatError(thrown, CLAUDE_USER_STATE_WRITE_FAILED_CODE), String(thrown)).toBe(true);
      expect(String(thrown)).toContain('my-skill@my-market');
    },
  );

  it('warns and cleans if plugin dir exists but not in registry', async () => {
    const paths = getPaths();
    // Only artifact 1 (dir) exists — not VAT-installed
    const mpPluginDir = safePath.join(paths.marketplacesDir, 'my-market', 'plugins', 'orphan');
    mkdirSyncReal(mpPluginDir, { recursive: true });
    const result = await uninstallPlugin({ pluginKey: 'orphan@my-market', paths });
    expect(result.removed).toBe(true);
    expect(result.warning).toContain('not installed via VAT');
    expect(existsSync(mpPluginDir)).toBe(false);
  });

  it('a dry-run over an orphan says the directory WOULD be removed, never that it is cleaning up', async () => {
    const paths = getPaths();
    const mpPluginDir = safePath.join(paths.marketplacesDir, 'my-market', 'plugins', 'orphan');
    mkdirSyncReal(mpPluginDir, { recursive: true });
    const result = await uninstallPlugin({ pluginKey: 'orphan@my-market', paths, dryRun: true });
    expect(result.removed).toBe(true);
    expect(result.warning).toContain('not installed via VAT');
    expect(result.warning).toContain('would be removed');
    expect(result.warning).not.toContain('cleaning up');
    expect(existsSync(mpPluginDir)).toBe(true);
  });
});

describe('uninstallPlugin with a key that is not two path segments', () => {
  const { getPaths } = setupPluginTestPaths();

  it('refuses before removing anything outside the Claude config dir', async () => {
    const paths = getPaths();
    // marketplaces/../../../victim — a sibling of the Claude config dir's plugins tree.
    const victim = safePath.join(paths.marketplacesDir, 'x', 'plugins', '..', '..', '..', 'victim');
    mkdirSyncReal(victim, { recursive: true });
    writeFileSync(safePath.join(victim, 'data.txt'), 'precious');

    await expect(uninstallPlugin({ pluginKey: '../../../victim@x', paths })).rejects.toMatchObject({ code: PLUGIN_KEY_INVALID_CODE });
    expect(readFileSync(safePath.join(victim, 'data.txt'), 'utf8')).toBe('precious');
  });
});

describe('parsePluginKey', () => {
  it('splits at the LAST @, so a plugin name keeps its own', () => {
    expect(parsePluginKey('a@b@mp')).toStrictEqual({ pluginName: 'a@b', marketplace: 'mp' });
  });

  // Each half is joined into ~/.claude and removed recursively: `../../../../../victim@x`
  // used to resolve outside the Claude config dir and be deleted as an "orphan".
  it.each([
    'no-marketplace', '@mp', 'p@',
    '../../../../../victim@x', '..@x', '.@x', 'p@..', 'p@.', 'a/b@mp', String.raw`a\b@mp`, 'p@m/n', '/abs@mp', 'C:evil@mp', '@scope/p@mp',
  ])('refuses %s with PLUGIN_KEY_INVALID', (key) => {
    let thrown: unknown;
    try {
      parsePluginKey(key);
    } catch (error) {
      thrown = error;
    }
    expect(isVatError(thrown, PLUGIN_KEY_INVALID_CODE), String(thrown)).toBe(true);
  });
});

describe('findPluginsByPackage', () => {
  const { getPaths } = setupPluginTestPaths();

  it('returns all plugin keys whose source.package matches', () => {
    const myPkg = '@test/my-pkg';
    const paths = getPaths();
    setupInstalledPlugin(paths, 'skill-a', 'market-a', myPkg);
    // setupInstalledPlugin overwrites files, so set up skill-b manually
    const pluginBKey = 'skill-b@market-b';
    const ip = JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8'));
    ip.plugins[pluginBKey] = [{ scope: 'user', installPath: '', version: '1.0.0', installedAt: '', lastUpdated: '' }];
    writeFileSync(paths.installedPluginsPath, JSON.stringify(ip));
    const km = JSON.parse(readFileSync(paths.knownMarketplacesPath, 'utf-8'));
    km['market-b'] = { source: { source: 'npm', package: myPkg }, installLocation: '', lastUpdated: '' };
    writeFileSync(paths.knownMarketplacesPath, JSON.stringify(km));

    const keys = findPluginsByPackage(myPkg, paths);
    expect(keys).toHaveLength(2);
    expect(keys).toContain('skill-a@market-a');
    expect(keys).toContain('skill-b@market-b');
  });

  it('returns empty array when no plugins match', () => {
    const keys = findPluginsByPackage('@test/other-pkg', getPaths());
    expect(keys).toHaveLength(0);
  });

  // The key was READ from Claude's registry, not typed: the registry is the input
  // at fault, and it is refused before any plugin is uninstalled.
  it('refuses a registry key of the package that is not a plugin key, coded as unreadable user state', () => {
    const myPkg = '@test/my-pkg';
    const paths = getPaths();
    setupInstalledPlugin(paths, 'skill-a', 'market-a', myPkg);
    const ip = JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8'));
    ip.plugins['../../victim@market-a'] = [];
    writeFileSync(paths.installedPluginsPath, JSON.stringify(ip));

    let error: unknown;
    try {
      findPluginsByPackage(myPkg, paths);
    } catch (caught) {
      error = caught;
    }

    expect(isVatError(error, CLAUDE_USER_STATE_UNREADABLE_CODE), String(error)).toBe(true);
    expect(String(error)).toContain('../../victim@market-a');
    expect(String(error)).toContain(paths.installedPluginsPath);
  });
});
