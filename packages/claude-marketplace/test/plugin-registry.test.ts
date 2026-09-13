/**
 * Unit tests for plugin-registry.ts
 * Verifies read/write of known_marketplaces.json, installed_plugins.json, and installPlugin flow.
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// Test helper — file paths are controlled by test code, not user input

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';


import { mkdirSyncReal, normalizedTmpdir, toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installPlugin,
  readInstalledPlugins,
  readKnownMarketplaces,
  readUserSettings,
  writeInstalledPlugins,
  writeKnownMarketplaces,
} from '../src/install/plugin-registry.js';

import { buildTestPaths } from './test-helpers.js';

// String constants to avoid sonarjs/no-duplicate-string
const MARKETPLACE_NAME = 'my-marketplace';
const PLUGIN_NAME = 'acme-tools';
const VERSION = '1.0.0';
const NPM_PACKAGE = '@acme/tools';
const FIXED_TIMESTAMP = '2026-02-26T00:00:00.000Z';
const NOT_JSON = '{ "plugins": ';
const REGISTRY_TEST_PREFIX = 'vat-registry-test-';
const PLUGIN_JSON = 'plugin.json';

/**
 * Plant `content` at `filePath`, creating the directory. A registry file that
 * is present but unparseable is the case every reader used to answer "empty"
 * for — and the very next write then replaced the user's file with that empty.
 */
function plantFile(filePath: string, content: string): void {
  mkdirSyncReal(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/**
 * Set up a fresh temp directory for a test suite and clean up after each test.
 */
function setupTempDir(prefix: string): { getDir: () => string } {
  let tempDir = '';
  beforeEach(() => {
    tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });
  return { getDir: () => tempDir };
}

describe('readKnownMarketplaces', () => {
  const { getDir } = setupTempDir(REGISTRY_TEST_PREFIX);

  it('returns {} when file does not exist', () => {
    const result = readKnownMarketplaces(buildTestPaths(getDir()));
    expect(result).toEqual({});
  });

  it('throws, naming the file, when the registry is present but not JSON', () => {
    const paths = buildTestPaths(getDir());
    plantFile(paths.knownMarketplacesPath, NOT_JSON);
    expect(() => readKnownMarketplaces(paths)).toThrow(paths.knownMarketplacesPath);
  });

  it('round-trips with writeKnownMarketplaces', () => {
    const paths = buildTestPaths(getDir());
    const data = {
      [MARKETPLACE_NAME]: {
        source: { source: 'npm' as const, package: NPM_PACKAGE, version: VERSION },
        installLocation: toForwardSlash(safePath.join(paths.marketplacesDir, MARKETPLACE_NAME)),
        lastUpdated: FIXED_TIMESTAMP,
      },
    };

    writeKnownMarketplaces(paths, data);
    const result = readKnownMarketplaces(paths);

    expect(result[MARKETPLACE_NAME]).toBeDefined();
    expect(result[MARKETPLACE_NAME]?.source.source).toBe('npm');
    expect(result[MARKETPLACE_NAME]?.installLocation).toBe(
      toForwardSlash(safePath.join(paths.marketplacesDir, MARKETPLACE_NAME))
    );
  });
});

describe('readInstalledPlugins', () => {
  const { getDir } = setupTempDir(REGISTRY_TEST_PREFIX);

  it('returns { version: 2, plugins: {} } when file does not exist', () => {
    const result = readInstalledPlugins(buildTestPaths(getDir()));
    expect(result).toEqual({ version: 2, plugins: {} });
  });

  it('throws, naming the file, when the registry is present but not JSON', () => {
    const paths = buildTestPaths(getDir());
    plantFile(paths.installedPluginsPath, NOT_JSON);
    expect(() => readInstalledPlugins(paths)).toThrow(paths.installedPluginsPath);
  });

  it('round-trips with writeInstalledPlugins', () => {
    const paths = buildTestPaths(getDir());
    const pluginKey = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
    const cacheInstallPath = toForwardSlash(safePath.join(paths.pluginsCacheDir, MARKETPLACE_NAME, PLUGIN_NAME, VERSION));
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

describe('readUserSettings', () => {
  const { getDir } = setupTempDir(REGISTRY_TEST_PREFIX);

  it('returns {} when settings.json does not exist', () => {
    expect(readUserSettings(buildTestPaths(getDir()))).toEqual({});
  });

  it('returns {} when settings.json is JSON but not an object', () => {
    const paths = buildTestPaths(getDir());
    plantFile(paths.userSettingsPath, '[1, 2]');
    expect(readUserSettings(paths)).toEqual({});
  });

  it('throws, naming the file, when settings.json is present but not JSON', () => {
    const paths = buildTestPaths(getDir());
    plantFile(paths.userSettingsPath, NOT_JSON);
    expect(() => readUserSettings(paths)).toThrow(paths.userSettingsPath);
  });
});

describe('installPlugin', () => {
  const { getDir } = setupTempDir('vat-install-test-');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves an unparseable settings.json untouched and says why on stderr', async () => {
    const paths = buildTestPaths(getDir());
    const pluginDir = safePath.join(getDir(), 'dist', 'plugins', PLUGIN_NAME);
    mkdirSyncReal(pluginDir, { recursive: true });
    writeFileSync(safePath.join(pluginDir, PLUGIN_JSON), JSON.stringify({ name: PLUGIN_NAME }));
    plantFile(paths.userSettingsPath, NOT_JSON);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await installPlugin({
      marketplaceName: MARKETPLACE_NAME,
      pluginName: PLUGIN_NAME,
      pluginDir,
      version: VERSION,
      source: { source: 'npm', package: NPM_PACKAGE, version: VERSION },
      paths,
    });

    // The user's file is what it was — not replaced by `{ enabledPlugins: {…} }`.
    expect(readFileSync(paths.userSettingsPath, 'utf-8')).toBe(NOT_JSON);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(paths.userSettingsPath);
  });

  it('full flow: creates dirs, writes registry files, updates settings.json', async () => {
    const paths = buildTestPaths(getDir());

    // Create a fake pluginDir with a dummy file
    const pluginDir = safePath.join(getDir(), 'dist', 'plugins', PLUGIN_NAME);
    mkdirSyncReal(pluginDir, { recursive: true });
    writeFileSync(safePath.join(pluginDir, PLUGIN_JSON), JSON.stringify({ name: PLUGIN_NAME }));

    await installPlugin({
      marketplaceName: MARKETPLACE_NAME,
      pluginName: PLUGIN_NAME,
      pluginDir,
      version: VERSION,
      source: { source: 'npm', package: NPM_PACKAGE, version: VERSION },
      paths,
    });

    // Verify plugin was copied to marketplacesDir
    const marketplacePluginPath = safePath.join(paths.marketplacesDir, MARKETPLACE_NAME, 'plugins', PLUGIN_NAME);
    expect(existsSync(marketplacePluginPath)).toBe(true);
    expect(existsSync(safePath.join(marketplacePluginPath, PLUGIN_JSON))).toBe(true);

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
