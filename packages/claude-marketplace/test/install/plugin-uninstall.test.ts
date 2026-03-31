// packages/claude-marketplace/test/install/plugin-uninstall.test.ts

/* eslint-disable security/detect-non-literal-fs-filename */
// Test helper — file paths are controlled by test code, not user input

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { findPluginsByPackage, uninstallPlugin } from '../../src/install/plugin-uninstall.js';
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
  const mpPluginDir = join(paths.marketplacesDir, marketplace, 'plugins', pluginName);
  mkdirSyncReal(mpPluginDir, { recursive: true });
  writeFileSync(join(mpPluginDir, 'SKILL.md'), `# ${pluginName}`);

  // Artifact 2: cache dir
  const cacheDir = join(paths.pluginsCacheDir, marketplace, pluginName, version);
  mkdirSyncReal(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'SKILL.md'), `# ${pluginName}`);

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
    expect(existsSync(join(paths.marketplacesDir, 'my-market', 'plugins', 'my-skill'))).toBe(false);
    expect(existsSync(join(paths.pluginsCacheDir, 'my-market', 'my-skill'))).toBe(false);
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
    const pluginBDir = join(paths.marketplacesDir, 'shared-market', 'plugins', 'skill-b');
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
    expect(existsSync(join(paths.marketplacesDir, 'my-market', 'plugins', 'my-skill'))).toBe(true);
  });

  it('warns and cleans if plugin dir exists but not in registry', async () => {
    const paths = getPaths();
    // Only artifact 1 (dir) exists — not VAT-installed
    const mpPluginDir = join(paths.marketplacesDir, 'my-market', 'plugins', 'orphan');
    mkdirSyncReal(mpPluginDir, { recursive: true });
    const result = await uninstallPlugin({ pluginKey: 'orphan@my-market', paths });
    expect(result.removed).toBe(true);
    expect(result.warning).toContain('not installed via VAT');
    expect(existsSync(mpPluginDir)).toBe(false);
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
});
