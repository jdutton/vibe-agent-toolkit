/**
 * Unit tests for plugin-registry.ts
 * Verifies read/write of known_marketplaces.json, installed_plugins.json, and installPlugin flow.
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// Test helper — file paths are controlled by test code, not user input

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installPlugin,
  readInstalledPlugins,
  readKnownMarketplaces,
  writeInstalledPlugins,
  writeKnownMarketplaces,
} from '../src/install/plugin-registry.js';
import type { ClaudeUserPaths } from '../src/paths/claude-paths.js';

// String constants to avoid sonarjs/no-duplicate-string
const MARKETPLACE_NAME = 'my-marketplace';
const PLUGIN_NAME = 'acme-tools';
const VERSION = '1.0.0';
const NPM_PACKAGE = '@acme/tools';
const FIXED_TIMESTAMP = '2026-02-26T00:00:00.000Z';

/**
 * Build test ClaudeUserPaths rooted in a temp base directory.
 * Uses a flat structure: base/.claude/plugins/... to avoid duplicating getClaudeUserPaths.
 */
function buildTestPaths(base: string): ClaudeUserPaths {
  const root = join(base, '.claude');
  const plugins = join(root, 'plugins');
  return {
    claudeDir: root,
    pluginsDir: plugins,
    skillsDir: join(root, 'skills'),
    marketplacesDir: join(plugins, 'marketplaces'),
    pluginsCacheDir: join(plugins, 'cache'),
    knownMarketplacesPath: join(plugins, 'known_marketplaces.json'),
    installedPluginsPath: join(plugins, 'installed_plugins.json'),
    userSettingsPath: join(root, 'settings.json'),
    userDotJsonPath: join(base, '.claude.json'),
  };
}

/**
 * Set up a fresh temp directory for a test suite and clean up after each test.
 */
function setupTempDir(prefix: string): { getDir: () => string } {
  let tempDir = '';
  beforeEach(() => {
    tempDir = mkdtempSync(join(normalizedTmpdir(), prefix));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });
  return { getDir: () => tempDir };
}

describe('readKnownMarketplaces', () => {
  const { getDir } = setupTempDir('vat-registry-test-');

  it('returns {} when file does not exist', () => {
    const result = readKnownMarketplaces(buildTestPaths(getDir()));
    expect(result).toEqual({});
  });

  it('round-trips with writeKnownMarketplaces', () => {
    const paths = buildTestPaths(getDir());
    const data = {
      [MARKETPLACE_NAME]: {
        source: { source: 'npm' as const, package: NPM_PACKAGE, version: VERSION },
        installLocation: toForwardSlash(join(paths.marketplacesDir, MARKETPLACE_NAME)),
        lastUpdated: FIXED_TIMESTAMP,
      },
    };

    writeKnownMarketplaces(paths, data);
    const result = readKnownMarketplaces(paths);

    expect(result[MARKETPLACE_NAME]).toBeDefined();
    expect(result[MARKETPLACE_NAME]?.source.source).toBe('npm');
    expect(result[MARKETPLACE_NAME]?.installLocation).toBe(
      toForwardSlash(join(paths.marketplacesDir, MARKETPLACE_NAME))
    );
  });
});

describe('readInstalledPlugins', () => {
  const { getDir } = setupTempDir('vat-registry-test-');

  it('returns { version: 2, plugins: {} } when file does not exist', () => {
    const result = readInstalledPlugins(buildTestPaths(getDir()));
    expect(result).toEqual({ version: 2, plugins: {} });
  });

  it('round-trips with writeInstalledPlugins', () => {
    const paths = buildTestPaths(getDir());
    const pluginKey = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
    const cacheInstallPath = toForwardSlash(join(paths.pluginsCacheDir, MARKETPLACE_NAME, PLUGIN_NAME, VERSION));
    const data = {
      version: 2 as const,
      plugins: {
        [pluginKey]: [
          {
            scope: 'user' as const,
            installPath: cacheInstallPath,
            version: VERSION,
            installedAt: FIXED_TIMESTAMP,
            lastUpdated: FIXED_TIMESTAMP,
          },
        ],
      },
    };

    writeInstalledPlugins(paths, data);
    const result = readInstalledPlugins(paths);

    expect(result.version).toBe(2);
    const entry = result.plugins[pluginKey]?.[0];
    expect(entry).toBeDefined();
    expect(entry?.scope).toBe('user');
    expect(entry?.version).toBe(VERSION);
  });
});

describe('installPlugin', () => {
  const { getDir } = setupTempDir('vat-install-test-');

  it('full flow: creates dirs, writes registry files, updates settings.json', async () => {
    const paths = buildTestPaths(getDir());

    // Create a fake pluginDir with a dummy file
    const pluginDir = join(getDir(), 'dist', 'plugins', PLUGIN_NAME);
    mkdirSyncReal(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: PLUGIN_NAME }));

    await installPlugin({
      marketplaceName: MARKETPLACE_NAME,
      pluginName: PLUGIN_NAME,
      pluginDir,
      version: VERSION,
      source: { source: 'npm', package: NPM_PACKAGE, version: VERSION },
      paths,
    });

    // Verify plugin was copied to marketplacesDir
    const marketplacePluginPath = join(paths.marketplacesDir, MARKETPLACE_NAME, 'plugins', PLUGIN_NAME);
    expect(existsSync(marketplacePluginPath)).toBe(true);
    expect(existsSync(join(marketplacePluginPath, 'plugin.json'))).toBe(true);

    // Verify known_marketplaces.json was written
    expect(existsSync(paths.knownMarketplacesPath)).toBe(true);
    const knownMarketplaces = readKnownMarketplaces(paths);
    expect(knownMarketplaces[MARKETPLACE_NAME]).toBeDefined();
    expect(knownMarketplaces[MARKETPLACE_NAME]?.source.source).toBe('npm');

    // Verify installed_plugins.json was written
    expect(existsSync(paths.installedPluginsPath)).toBe(true);
    const installedPlugins = readInstalledPlugins(paths);
    const pluginKey = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
    const entry = installedPlugins.plugins[pluginKey]?.[0];
    expect(entry).toBeDefined();
    expect(entry?.scope).toBe('user');
    expect(entry?.version).toBe(VERSION);

    // Verify settings.json has enabledPlugins set
    expect(existsSync(paths.userSettingsPath)).toBe(true);
    const settingsRaw = readFileSync(paths.userSettingsPath, 'utf-8');
    const settings = JSON.parse(settingsRaw) as Record<string, unknown>;
    const enabledPlugins = settings['enabledPlugins'] as Record<string, boolean>;
    expect(enabledPlugins[pluginKey]).toBe(true);
  });
});
