/**
 * Unit tests for plugin-registry.ts
 * Verifies read/write of known_marketplaces.json, installed_plugins.json, and installPlugin flow.
 */

// Test helper — file paths are controlled by test code, not user input

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';


import { createSymlink, isVatError, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_USER_STATE_UNREADABLE_CODE,
  installPlugin,
  type InstallPluginOptions,
  CLAUDE_USER_STATE_WRITE_FAILED_CODE,
  PLUGIN_KEY_INVALID_CODE,
  PLUGIN_SOURCE_UNREADABLE_CODE,
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

/** What `fn` threw, or `undefined` when it returned. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
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

  it('codes a registry it cannot read as CLAUDE_USER_STATE_UNREADABLE', () => {
    const paths = buildTestPaths(getDir());
    // A directory where the file should be: present, and not readable as a file.
    mkdirSyncReal(paths.knownMarketplacesPath, { recursive: true });
    expect(thrownBy(() => readKnownMarketplaces(paths))).toSatisfy((error: unknown) => isVatError(error, CLAUDE_USER_STATE_UNREADABLE_CODE));
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
    expect(thrownBy(() => readInstalledPlugins(paths))).toSatisfy((error: unknown) => isVatError(error, CLAUDE_USER_STATE_UNREADABLE_CODE));
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

/** A built plugin directory under `dir`, ready to register. */
function builtPlugin(dir: string): string {
  const pluginDir = safePath.join(dir, 'dist', 'plugins', PLUGIN_NAME);
  mkdirSyncReal(pluginDir, { recursive: true });
  writeFileSync(safePath.join(pluginDir, PLUGIN_JSON), JSON.stringify({ name: PLUGIN_NAME }));
  return pluginDir;
}

/**
 * A link-capable process's test paths and the cache version path, or `null`
 * once `skip` has been called because this process cannot create symlinks.
 */
function cacheLinkFixture(
  dir: string,
  skip: (note?: string) => void,
): { cap: NonNullable<ReturnType<typeof symlinkCapability>>; paths: ReturnType<typeof buildTestPaths>; cacheDest: string } | null {
  const cap = symlinkCapability();
  if (cap === null) {
    skip('this process cannot create symlinks');
    return null;
  }
  const paths = buildTestPaths(dir);
  return { cap, paths, cacheDest: safePath.join(paths.pluginsCacheDir, MARKETPLACE_NAME, PLUGIN_NAME, VERSION) };
}

/** Install the plugin at `pluginDir` into `paths` under the suite's names. */
function installAt(pluginDir: string, paths: ReturnType<typeof buildTestPaths>): ReturnType<typeof installPlugin> {
  return installPlugin({
    marketplaceName: MARKETPLACE_NAME,
    pluginName: PLUGIN_NAME,
    pluginDir,
    version: VERSION,
    source: { source: 'npm', package: NPM_PACKAGE, version: VERSION },
    paths,
  });
}

/** Register a plugin built under `dir` into `paths`, returning what it threw (or undefined). */
async function registrationError(
  dir: string,
  paths: ReturnType<typeof buildTestPaths>,
  names: Partial<Pick<InstallPluginOptions, 'marketplaceName' | 'pluginName' | 'version'>> = {},
): Promise<unknown> {
  try {
    await installPlugin({
      marketplaceName: MARKETPLACE_NAME,
      pluginName: PLUGIN_NAME,
      pluginDir: builtPlugin(dir),
      version: VERSION,
      source: { source: 'npm', package: NPM_PACKAGE, version: VERSION },
      paths,
      ...names,
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('installPlugin', () => {
  const { getDir } = setupTempDir('vat-install-test-');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses an unparseable settings.json, coded, and leaves it untouched', async () => {
    const paths = buildTestPaths(getDir());
    plantFile(paths.userSettingsPath, NOT_JSON);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const error = await registrationError(getDir(), paths);

    // The failure reaches the caller — a registration that did not happen is never "installed".
    expect(isVatError(error, CLAUDE_USER_STATE_UNREADABLE_CODE), String(error)).toBe(true);
    expect(String(error)).toContain(paths.userSettingsPath);
    // The user's file is what it was — not replaced by `{ enabledPlugins: {…} }`.
    expect(readFileSync(paths.userSettingsPath, 'utf-8')).toBe(NOT_JSON);
    expect(warn).not.toHaveBeenCalled();
  });

  // The plugin to install is the INPUT. A source that is not there is not a failed
  // write to Claude's state — and nothing may be created for it: an empty plugin
  // directory under marketplaces/ is what uninstall later reports as an orphan.
  it('refuses a plugin source that is not there as PLUGIN_SOURCE_UNREADABLE, before creating anything', async () => {
    const paths = buildTestPaths(getDir());
    let error: unknown;
    try {
      await installPlugin({
        marketplaceName: MARKETPLACE_NAME,
        pluginName: PLUGIN_NAME,
        pluginDir: safePath.join(getDir(), 'never-built'),
        version: VERSION,
        source: { source: 'npm', package: NPM_PACKAGE, version: VERSION },
        paths,
      });
    } catch (caught) {
      error = caught;
    }

    expect(isVatError(error, PLUGIN_SOURCE_UNREADABLE_CODE), String(error)).toBe(true);
    expect(existsSync(paths.claudeDir)).toBe(false);
  });

  // Each name becomes a directory under ~/.claude that is replaced recursively: a
  // version of `../../../escape` (it comes from the package's own package.json) would land outside it.
  it.each([
    ['version', { version: '../../../../escape' }],
    ['plugin name', { pluginName: '../escape' }],
    ['marketplace name', { marketplaceName: 'a/b' }],
  ])('refuses a %s that is not one path segment as PLUGIN_KEY_INVALID, before creating anything', async (_what, names) => {
    const paths = buildTestPaths(getDir());

    const error = await registrationError(getDir(), paths, names);

    expect(isVatError(error, PLUGIN_KEY_INVALID_CODE), String(error)).toBe(true);
    expect(existsSync(paths.claudeDir)).toBe(false);
    expect(existsSync(safePath.join(getDir(), 'escape'))).toBe(false);
  });

  it('codes a registration it could not write as CLAUDE_USER_STATE_WRITE_FAILED', async () => {
    const paths = buildTestPaths(getDir());
    // A FILE where the cache directory must go: the copy into it cannot happen.
    plantFile(paths.pluginsCacheDir, 'not a directory');

    const error = await registrationError(getDir(), paths);

    expect(isVatError(error, CLAUDE_USER_STATE_WRITE_FAILED_CODE), String(error)).toBe(true);
    expect(String(error)).toContain(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  });

  it('re-registers a plugin whose skills are links (a --dev re-install) — the cache is replaced, not copied into', async ({ skip }) => {
    const cap = symlinkCapability();
    if (cap === null) {
      skip('this process cannot create symlinks');
      return;
    }
    const paths = buildTestPaths(getDir());
    const build = safePath.join(getDir(), 'dist', 'skills', 'linked');
    plantFile(safePath.join(build, 'SKILL.md'), '# linked\n');
    // Registered in place, as `--dev` does: the plugin dir IS the marketplace destination.
    const pluginDir = safePath.join(paths.marketplacesDir, MARKETPLACE_NAME, 'plugins', PLUGIN_NAME);
    plantFile(safePath.join(pluginDir, PLUGIN_JSON), JSON.stringify({ name: PLUGIN_NAME }));
    mkdirSyncReal(safePath.join(pluginDir, 'skills'), { recursive: true });
    createSymlink(cap, build, safePath.join(pluginDir, 'skills', 'linked'), 'dir');
    const register = (): Promise<unknown> => installAt(pluginDir, paths);

    await register();
    await expect(register()).resolves.toEqual({ warnings: [] });
    expect(existsSync(safePath.join(paths.pluginsCacheDir, MARKETPLACE_NAME, PLUGIN_NAME, VERSION, 'skills', 'linked', 'SKILL.md'))).toBe(true);
  });

  // Needs a source file the OS refuses to read; Windows and root cannot deny a read by mode.
  it.skipIf(CANNOT_DENY_READS)('refuses a plugin with an unreadable file deep inside as PLUGIN_SOURCE_UNREADABLE, naming that file, and keeps the previous cache', async () => {
    const paths = buildTestPaths(getDir());
    // Registered in place, so the cache copy (step 3) is the first copy to run.
    const pluginDir = safePath.join(paths.marketplacesDir, MARKETPLACE_NAME, 'plugins', PLUGIN_NAME);
    plantFile(safePath.join(pluginDir, PLUGIN_JSON), JSON.stringify({ name: PLUGIN_NAME }));
    // In the first install only: a partial second copy cannot put it back.
    const firstOnly = safePath.join(pluginDir, 'first-only.txt');
    writeFileSync(firstOnly, 'x');
    const register = async (): Promise<unknown> => {
      try {
        await installPlugin({
          marketplaceName: MARKETPLACE_NAME,
          pluginName: PLUGIN_NAME,
          pluginDir,
          version: VERSION,
          source: { source: 'npm', package: NPM_PACKAGE, version: VERSION },
          paths,
        });
        return undefined;
      } catch (error) {
        return error;
      }
    };
    expect(await register()).toBeUndefined();
    const versionsDir = safePath.join(paths.pluginsCacheDir, MARKETPLACE_NAME, PLUGIN_NAME);
    const firstInstall = ['first-only.txt', PLUGIN_JSON];
    expect(readdirSync(safePath.join(versionsDir, VERSION)).toSorted((a, b) => a.localeCompare(b))).toEqual(firstInstall);

    rmSync(firstOnly);
    // Below the top level, which is all the source check used to list: the copy then
    // failed inside ~/.claude and was reported as Claude's state, naming the destination.
    const refused = safePath.join(pluginDir, 'nested', 'deeper', 'refused.txt');
    plantFile(refused, 'x');
    chmodSync(refused, 0o000);
    const error = await register();
    chmodSync(refused, 0o644);

    expect(isVatError(error, PLUGIN_SOURCE_UNREADABLE_CODE), String(error)).toBe(true);
    expect(String(error)).toContain(refused);
    // The tree the registry still points at is the one the first install left.
    expect(readdirSync(safePath.join(versionsDir, VERSION)).toSorted((a, b) => a.localeCompare(b))).toEqual(firstInstall);
    // And no half-copied sibling is left beside it to read as another version.
    expect(readdirSync(versionsDir)).toEqual([VERSION]);
  });

  // The previous tree is removed only after the new one is in place. A removal the OS
  // refuses then (a read-only directory in the old tree, a Windows file handle) must not
  // abort an install whose files are already live: the registry and settings still get written.
  it.skipIf(CANNOT_DENY_READS)('finishes a re-install whose previous tree cannot be removed, and leaves it where no inventory reads it as a version', async () => {
    const paths = buildTestPaths(getDir());
    const pluginDir = builtPlugin(getDir());
    const install = (): Promise<unknown> => installAt(pluginDir, paths);
    await install();
    const versionsDir = safePath.join(paths.pluginsCacheDir, MARKETPLACE_NAME, PLUGIN_NAME);
    const locked = safePath.join(versionsDir, VERSION, 'locked');
    plantFile(safePath.join(locked, 'held.txt'), 'x');
    chmodSync(locked, 0o555);
    writeFileSync(safePath.join(pluginDir, 'second.txt'), 'v2');
    rmSync(paths.installedPluginsPath);
    rmSync(paths.userSettingsPath);

    let error: unknown;
    let result: unknown;
    try {
      result = await install();
    } catch (caught) {
      error = caught;
    } finally {
      for (const entry of readdirSync(versionsDir)) {
        const leftover = safePath.join(versionsDir, entry, 'locked');
        if (existsSync(leftover)) chmodSync(leftover, 0o755);
      }
    }

    expect(error).toBeUndefined();
    expect(readFileSync(safePath.join(versionsDir, VERSION, 'second.txt'), 'utf-8')).toBe('v2');
    expect(readInstalledPlugins(paths).plugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`]).toHaveLength(1);
    expect(readUserSettings(paths)['enabledPlugins']).toEqual({ [`${PLUGIN_NAME}@${MARKETPLACE_NAME}`]: true });
    expect(readdirSync(versionsDir).filter((entry) => !entry.startsWith('.'))).toEqual([VERSION]);
    expect(result).toEqual({ warnings: [expect.stringContaining('could not be removed')] });
  });

  // mkdtemp makes its directory 0700, and a copy into an existing directory keeps that mode.
  it.skipIf(process.platform === 'win32')('gives the cached version directory the source directory\'s mode, not mkdtemp\'s 0700', async () => {
    const paths = buildTestPaths(getDir());
    const pluginDir = builtPlugin(getDir());
    chmodSync(pluginDir, 0o755);

    await registrationError(getDir(), paths);

    expect(statSync(safePath.join(paths.pluginsCacheDir, MARKETPLACE_NAME, PLUGIN_NAME, VERSION)).mode & 0o777).toBe(0o755);
  });

  it('replaces a dangling link at the cache version path instead of refusing', async ({ skip }) => {
    const fixture = cacheLinkFixture(getDir(), skip);
    if (fixture === null) return;
    const { cap, paths, cacheDest } = fixture;
    mkdirSyncReal(dirname(cacheDest), { recursive: true });
    createSymlink(cap, safePath.join(getDir(), 'gone'), cacheDest, 'dir');

    expect(await registrationError(getDir(), paths)).toBeUndefined();
    expect(existsSync(safePath.join(cacheDest, PLUGIN_JSON))).toBe(true);
  });

  it('never deletes a pluginDir that resolves to the cache destination through a link', async ({ skip }) => {
    const fixture = cacheLinkFixture(getDir(), skip);
    if (fixture === null) return;
    const { cap, paths, cacheDest } = fixture;
    plantFile(safePath.join(cacheDest, PLUGIN_JSON), JSON.stringify({ name: PLUGIN_NAME }));
    // Textually a different path; on disk, the cache destination itself.
    const pluginDir = safePath.join(getDir(), 'linked-plugin');
    createSymlink(cap, cacheDest, pluginDir, 'dir');

    await installPlugin({
      marketplaceName: MARKETPLACE_NAME,
      pluginName: PLUGIN_NAME,
      pluginDir,
      version: VERSION,
      source: { source: 'npm', package: NPM_PACKAGE, version: VERSION },
      paths,
    });

    expect(existsSync(safePath.join(cacheDest, PLUGIN_JSON))).toBe(true);
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
