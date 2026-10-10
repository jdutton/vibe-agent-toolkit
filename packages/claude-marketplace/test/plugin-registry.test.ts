/**
 * Unit tests for plugin-registry.ts
 * Verifies the registry reads, and a plugin install's registry edit and trees (`planPackageInstall`, one plugin).
 */

// Test helper — file paths are controlled by test code, not user input

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';


import { createSymlink, FS_FAULT_CODE, isVatError, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability, toForwardSlash, TREE_CLEANUP_INCOMPLETE_CODE, TREE_DEST_HOLDS_SOURCE_CODE, TREE_ROLLBACK_INCOMPLETE_CODE } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, diffSnapshots, type FaultRule, snapshotTree } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_USER_STATE_UNREADABLE_CODE,
  type InstallPluginOptions,
  PLUGIN_KEY_INVALID_CODE,
  readInstalledPlugins,
  readKnownMarketplaces,
  readUserSettings,
  VAT_MARKETPLACE_MARKER,
  writeUserState,
} from '../src/install/plugin-registry.js';

import { buildTestPaths, installOnePlugin, refusedRegistryWrite, rejectionOf, stagedWriteOf, underFaults, useScratchTmpdir } from './test-helpers.js';

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
  useScratchTmpdir(`${prefix}tmp-`);
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
    const result = readKnownMarketplaces(buildTestPaths(getDir()), 'destination');
    expect(result).toEqual({});
  });

  it('throws, naming the file, when the registry is present but not JSON', () => {
    const paths = buildTestPaths(getDir());
    plantFile(paths.knownMarketplacesPath, NOT_JSON);
    expect(() => readKnownMarketplaces(paths, 'destination')).toThrow(paths.knownMarketplacesPath);
  });

  it.each(['destination', 'source'] as const)('classifies a registry the OS will not read as a filesystem fault on the caller\'s side (%s), naming the file', (side) => {
    const paths = buildTestPaths(getDir());
    // A directory where the file should be: present, and not readable as a file.
    mkdirSyncReal(paths.knownMarketplacesPath, { recursive: true });
    expect(thrownBy(() => readKnownMarketplaces(paths, side))).toMatchObject({
      code: FS_FAULT_CODE,
      side,
      faultClass: 'wrong-type',
      errno: 'EISDIR',
      path: paths.knownMarketplacesPath,
    });
  });

  it('reads back the entries the file holds', () => {
    const paths = buildTestPaths(getDir());
    const data = {
      [MARKETPLACE_NAME]: {
        source: { source: 'npm' as const, package: NPM_PACKAGE, version: VERSION },
        installLocation: toForwardSlash(safePath.join(paths.marketplacesDir, MARKETPLACE_NAME)),
        lastUpdated: FIXED_TIMESTAMP,
      },
    };

    plantFile(paths.knownMarketplacesPath, JSON.stringify(data));
    const result = readKnownMarketplaces(paths, 'destination');

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
    const result = readInstalledPlugins(buildTestPaths(getDir()), 'destination');
    expect(result).toEqual({ version: 2, plugins: {} });
  });

  it('throws, naming the file, when the registry is present but not JSON', () => {
    const paths = buildTestPaths(getDir());
    plantFile(paths.installedPluginsPath, NOT_JSON);
    expect(() => readInstalledPlugins(paths, 'destination')).toThrow(paths.installedPluginsPath);
    expect(thrownBy(() => readInstalledPlugins(paths, 'destination'))).toSatisfy((error: unknown) => isVatError(error, CLAUDE_USER_STATE_UNREADABLE_CODE));
  });

  it('reads back the plugins the file holds', () => {
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

    plantFile(paths.installedPluginsPath, JSON.stringify(data));
    const result = readInstalledPlugins(paths, 'destination');

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
    expect(readUserSettings(buildTestPaths(getDir()), 'destination')).toEqual({});
  });

  // Every read here is followed by a write of the same file: a file that is there but is not the shape
  // Claude Code writes must refuse, never read as empty (the write would replace it) nor crash.
  it.each([
    ['a JSON array', '[1, 2]'],
    ['an enabledPlugins that is not an object', '{"enabledPlugins": ["a@b"]}'],
  ])('refuses settings.json holding %s as unreadable user state, naming the file', (_label, content) => {
    const paths = buildTestPaths(getDir());
    plantFile(paths.userSettingsPath, content);
    expect(() => readUserSettings(paths, 'destination')).toThrow(expect.objectContaining({ code: CLAUDE_USER_STATE_UNREADABLE_CODE, message: expect.stringContaining(paths.userSettingsPath) as unknown }) as Error);
  });
});

describe('a registry file of the wrong shape', () => {
  const { getDir } = setupTempDir(REGISTRY_TEST_PREFIX);

  it.each([
    ['no plugins object', '{}'],
    ['plugins as an array', '{"version": 2, "plugins": []}'],
    ['a key whose value is not a list', '{"version": 2, "plugins": {"a@b": {"scope": "user"}}}'],
    ['a list holding something that is not a record', '{"version": 2, "plugins": {"a@b": ["x"]}}'],
    ['a JSON array', '[]'],
  ])('refuses installed_plugins.json with %s as unreadable user state — never a TypeError', (_label, content) => {
    const paths = buildTestPaths(getDir());
    plantFile(paths.installedPluginsPath, content);
    expect(() => readInstalledPlugins(paths, 'source')).toThrow(expect.objectContaining({ code: CLAUDE_USER_STATE_UNREADABLE_CODE, message: expect.stringContaining(paths.installedPluginsPath) as unknown }) as Error);
  });

  it.each([
    ['a JSON array', '[]'],
    ['an entry with no source', '{"mp": {"installLocation": ""}}'],
    ['an entry that is not an object', '{"mp": "x"}'],
    ['a source that names no kind', '{"mp": {"source": {"repo": "o/r"}}}'],
  ])('refuses known_marketplaces.json with %s as unreadable user state', (_label, content) => {
    const paths = buildTestPaths(getDir());
    plantFile(paths.knownMarketplacesPath, content);
    expect(() => readKnownMarketplaces(paths, 'source')).toThrow(expect.objectContaining({ code: CLAUDE_USER_STATE_UNREADABLE_CODE, message: expect.stringContaining(paths.knownMarketplacesPath) as unknown }) as Error);
  });

  it('throws, naming the file, when settings.json is present but not JSON', () => {
    const paths = buildTestPaths(getDir());
    plantFile(paths.userSettingsPath, NOT_JSON);
    expect(() => readUserSettings(paths, 'destination')).toThrow(paths.userSettingsPath);
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

/** The suite's names for the one plugin it installs. */
const NAMES: InstallPluginOptions = { marketplaceName: MARKETPLACE_NAME, pluginName: PLUGIN_NAME, version: VERSION, source: { source: 'npm', package: NPM_PACKAGE, version: VERSION } };

/** Install the plugin at `pluginDir` into `paths` under the suite's names. */
function installAt(pluginDir: string, paths: ReturnType<typeof buildTestPaths>): ReturnType<typeof installOnePlugin> {
  return installOnePlugin(pluginDir, paths, NAMES);
}

/** A plugin built under `dir` and installed once into test paths there: the state a re-install starts from. */
async function installedOnce(dir: string): Promise<{ paths: ReturnType<typeof buildTestPaths>; pluginDir: string; versionsDir: string }> {
  const paths = buildTestPaths(dir);
  const pluginDir = builtPlugin(dir);
  await installAt(pluginDir, paths);
  return { paths, pluginDir, versionsDir: safePath.join(paths.pluginsCacheDir, MARKETPLACE_NAME, PLUGIN_NAME) };
}

/** Register a plugin built under `dir` into `paths`, returning what it threw (or undefined). */
async function registrationError(
  dir: string,
  paths: ReturnType<typeof buildTestPaths>,
  names: Partial<Pick<InstallPluginOptions, 'marketplaceName' | 'pluginName' | 'version'>> = {},
): Promise<unknown> {
  try {
    await installOnePlugin(builtPlugin(dir), paths, { ...NAMES, ...names });
    return undefined;
  } catch (error) {
    return error;
  }
}

/** What `writeUserState` rejects with when its mutation throws `thrown`. */
async function writeUserStateRejection(thrown: unknown): Promise<unknown> {
  try {
    await writeUserState('register plugin p@mp', () => {
      throw thrown;
    });
  } catch (error) {
    return error;
  }
  return undefined;
}

/** An errno-shaped error naming `path`, as a failed copy raises it (node names the SOURCE of a failed write). */
function errnoAt(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused, copyfile '${path}'`), { code, syscall: 'copyfile', path });
}

describe('writeUserState', () => {
  it('classifies a fault as the user state the run writes, whatever path the error names', async () => {
    // A copy whose write into ~/.claude failed names the SOURCE path: the side must not follow it.
    expect(await writeUserStateRejection(errnoAt('ENOSPC', '/pkg/plugins/p/SKILL.md'))).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'exhausted', action: 'register plugin p@mp' });
  });

  it('lets anything that is not a filesystem errno through untouched: a defect is never a refusal', async () => {
    const defect = new TypeError('x is not a function');

    expect(await writeUserStateRejection(defect)).toBe(defect);
  });
});

describe('installing one plugin (planPackageInstall)', () => {
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
  it('refuses a plugin source that is not there as a source fault found inside the package, before creating anything', async () => {
    const paths = buildTestPaths(getDir());
    const error = await rejectionOf(() => installOnePlugin(safePath.join(getDir(), 'never-built'), paths, NAMES));

    expect(error, String(error)).toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin: 'content', faultClass: 'absent' });
    expect(existsSync(paths.claudeDir)).toBe(false);
  });

  // Each name becomes a directory under ~/.claude that is replaced recursively: a
  // version of `../../../escape` (it comes from the package's own package.json) would land outside it.
  it.each([
    ['version', { version: '../../../../escape' }],
    ['plugin name', { pluginName: '../escape' }],
    ['marketplace name', { marketplaceName: 'a/b' }],
    // One segment, but dot-led: the cache's version directory would be hidden from inventory.
    ['dot-led version', { version: '.1' }],
  ])('refuses a %s that is not one path segment as PLUGIN_KEY_INVALID, before creating anything', async (_what, names) => {
    const paths = buildTestPaths(getDir());

    const error = await registrationError(getDir(), paths, names);

    expect(isVatError(error, PLUGIN_KEY_INVALID_CODE), String(error)).toBe(true);
    expect(existsSync(paths.claudeDir)).toBe(false);
    expect(existsSync(safePath.join(getDir(), 'escape'))).toBe(false);
  });

  it('classifies a registration it could not write as a destination fault, naming the plugin', async () => {
    const paths = buildTestPaths(getDir());
    // A FILE where the cache directory must go: the copy into it cannot happen.
    plantFile(paths.pluginsCacheDir, 'not a directory');

    const error = await registrationError(getDir(), paths);

    expect(error, String(error)).toMatchObject({ code: FS_FAULT_CODE, side: 'destination' });
    expect(String(error)).toContain(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  });

  // Needs a source file the OS refuses to read; Windows and root cannot deny a read by mode.
  it.skipIf(CANNOT_DENY_READS)('refuses a plugin with an unreadable file deep inside as a source fault, naming that file, and keeps the previous cache', async () => {
    const paths = buildTestPaths(getDir());
    const pluginDir = builtPlugin(getDir());
    // In the first install only: a partial second copy cannot put it back.
    const firstOnly = safePath.join(pluginDir, 'first-only.txt');
    writeFileSync(firstOnly, 'x');
    const register = (): Promise<unknown> => rejectionOf(() => installAt(pluginDir, paths));
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

    expect(error, String(error)).toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'refused', path: refused });
    expect(String(error)).toContain(refused);
    // The tree the registry still points at is the one the first install left.
    expect(readdirSync(safePath.join(versionsDir, VERSION)).toSorted((a, b) => a.localeCompare(b))).toEqual(firstInstall);
    // And no half-copied sibling is left beside it to read as another version.
    expect(readdirSync(versionsDir)).toEqual([VERSION]);
  });

  // The previous tree is removed only after the new one is in place. A removal the OS
  // refuses then (a Windows file handle, a filesystem refusing the delete) must not abort an
  // install whose files are already live: the registry and settings still get written, and the
  // leftover is a warning naming where it is.
  it('finishes a re-install whose previous tree cannot be removed, and leaves it where no inventory reads it as a version', async () => {
    const { paths, pluginDir, versionsDir } = await installedOnce(getDir());
    writeFileSync(safePath.join(pluginDir, 'second.txt'), 'v2');
    // Both removals of the parked previous version (the second is the retry after granting the owner rwx): a rule
    // that fires returns before a later rule counts the call, so each removal gets a rule (a distinct object) of its own.
    const parkedCache = (p: string): boolean => p.includes(`/.${VERSION}.vat-staged-`) && p.endsWith('.previous');
    const refuseRemoval = (): FaultRule => ({ family: 'remove', op: 'rm', path: parkedCache, errno: 'EACCES' });
    const result = await underFaults(getDir(), { faults: [refuseRemoval(), refuseRemoval()] }, () => installAt(pluginDir, paths));

    expect(readFileSync(safePath.join(versionsDir, VERSION, 'second.txt'), 'utf-8')).toBe('v2');
    expect(readInstalledPlugins(paths, 'destination').plugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`]).toHaveLength(1);
    expect(readUserSettings(paths, 'destination')['enabledPlugins']).toEqual({ [`${PLUGIN_NAME}@${MARKETPLACE_NAME}`]: true });
    expect(readdirSync(versionsDir).filter((entry) => !entry.startsWith('.'))).toEqual([VERSION]);
    const leftover = readdirSync(versionsDir).find((entry) => entry.startsWith('.'));
    expect(result).toEqual({ warnings: [{ code: TREE_CLEANUP_INCOMPLETE_CODE, path: safePath.join(versionsDir, leftover ?? 'missing'), message: expect.stringContaining('EACCES') as unknown }] });
  });

  // An older VAT build copied a read-only plugin's modes into the cache: a tree its owner could
  // not empty. A re-install must replace it whole, with no leftover and no warning.
  it.skipIf(CANNOT_DENY_READS)('replaces a read-only (0555) installed tree an older build left, whole', async () => {
    const { paths, pluginDir, versionsDir } = await installedOnce(getDir());
    const cached = safePath.join(versionsDir, VERSION);
    plantFile(safePath.join(cached, 'skills', 's', 'SKILL.md'), '# s\n');
    for (const dir of [safePath.join(cached, 'skills', 's'), safePath.join(cached, 'skills'), cached]) chmodSync(dir, 0o555);

    const result = await installAt(pluginDir, paths);

    expect(result).toEqual({ warnings: [] });
    expect(readdirSync(versionsDir)).toEqual([VERSION]);
    expect(readdirSync(cached)).toEqual([PLUGIN_JSON]);
  });

  // mkdtemp makes its directory 0700, and a copy into an existing directory keeps that mode.
  // 0750 is a mode no default umask produces, so only taking the source's own mode passes.
  it.skipIf(process.platform === 'win32')('gives the cached version directory the source directory\'s mode, not mkdtemp\'s 0700', async () => {
    const paths = buildTestPaths(getDir());
    const pluginDir = builtPlugin(getDir());
    chmodSync(pluginDir, 0o750);

    expect(await registrationError(getDir(), paths)).toBeUndefined();

    expect(statSync(safePath.join(paths.pluginsCacheDir, MARKETPLACE_NAME, PLUGIN_NAME, VERSION)).mode & 0o777).toBe(0o750);
  });

  // The source's mode used to be applied to the staging directory BEFORE the copy:
  // a read-only plugin left the copy nowhere to write, and Node's native copy
  // aborted the whole process (SIGABRT) with a read-only staging dir left behind.
  it.skipIf(CANNOT_DENY_READS)('installs a read-only plugin directory owner-writable, and leaves no staging directory', async () => {
    const paths = buildTestPaths(getDir());
    const pluginDir = builtPlugin(getDir());
    plantFile(safePath.join(pluginDir, 'skills', 's', 'SKILL.md'), '# s\n');
    chmodSync(pluginDir, 0o555);
    const versionsDir = safePath.join(paths.pluginsCacheDir, MARKETPLACE_NAME, PLUGIN_NAME);
    let error: unknown;
    let cachedMode: number | undefined;
    try {
      error = await registrationError(getDir(), paths);
      cachedMode = statSync(safePath.join(versionsDir, VERSION)).mode & 0o777;
    } finally {
      chmodSync(pluginDir, 0o755);
      // Restored even though the copies are owner-writable: a regression must not fail the teardown too.
      for (const tree of [safePath.join(versionsDir, VERSION), safePath.join(paths.marketplacesDir, MARKETPLACE_NAME, 'plugins', PLUGIN_NAME)]) {
        if (existsSync(tree)) chmodSync(tree, 0o755);
      }
    }

    expect(error).toBeUndefined();
    // The source's mode, plus the owner's write: a 0555 cache is one no uninstall can empty.
    expect(cachedMode).toBe(0o755);
    expect(readdirSync(versionsDir)).toEqual([VERSION]);
    expect(existsSync(safePath.join(versionsDir, VERSION, 'skills', 's', 'SKILL.md'))).toBe(true);
  });

  // A relative link used to be copied resolved to an absolute link into the source tree: the
  // installed plugin then read the developer's working copy, and dangled once that moved.
  it('copies a relative link verbatim into both trees, never resolved into the source', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip('this process cannot create symlinks');
    const paths = buildTestPaths(getDir());
    const pluginDir = builtPlugin(getDir());
    writeFileSync(safePath.join(pluginDir, 'real.md'), 'real\n');
    createSymlink(cap, 'real.md', safePath.join(pluginDir, 'alias.md'), 'file');

    await installAt(pluginDir, paths);

    for (const tree of [safePath.join(paths.marketplacesDir, MARKETPLACE_NAME, 'plugins', PLUGIN_NAME), safePath.join(paths.pluginsCacheDir, MARKETPLACE_NAME, PLUGIN_NAME, VERSION)]) {
      expect(readlinkSync(safePath.join(tree, 'alias.md'))).toBe('real.md');
    }
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

  // The planner's holding check, by identity: replacing the cache would delete the very tree it copies.
  it('refuses a pluginDir that resolves to the cache destination through a link, and deletes nothing', async ({ skip }) => {
    const fixture = cacheLinkFixture(getDir(), skip);
    if (fixture === null) return;
    const { cap, paths, cacheDest } = fixture;
    plantFile(safePath.join(cacheDest, PLUGIN_JSON), JSON.stringify({ name: PLUGIN_NAME }));
    // Textually a different path; on disk, the cache destination itself.
    const pluginDir = safePath.join(getDir(), 'linked-plugin');
    createSymlink(cap, cacheDest, pluginDir, 'dir');

    const error = await rejectionOf(() => installAt(pluginDir, paths));

    expect(isVatError(error, TREE_DEST_HOLDS_SOURCE_CODE), String(error)).toBe(true);
    expect(existsSync(safePath.join(cacheDest, PLUGIN_JSON))).toBe(true);
  });

  it('re-install leaves no file the plugin deleted in the marketplace copy — replaced, like the cache', async () => {
    const paths = buildTestPaths(getDir());
    const pluginDir = builtPlugin(getDir());
    const oldFile = safePath.join(pluginDir, 'old.txt');
    writeFileSync(oldFile, 'stale');
    await installAt(pluginDir, paths);
    rmSync(oldFile);

    await installAt(pluginDir, paths);

    const marketplacePluginPath = safePath.join(paths.marketplacesDir, MARKETPLACE_NAME, 'plugins', PLUGIN_NAME);
    expect(readdirSync(marketplacePluginPath)).toStrictEqual([PLUGIN_JSON]);
    expect(readdirSync(safePath.join(paths.pluginsCacheDir, MARKETPLACE_NAME, PLUGIN_NAME, VERSION))).toStrictEqual([PLUGIN_JSON]);
  });

  // The marker is VAT's witness that it made the marketplace: an uninstall removes only a marked one.
  // It is a change of the install's own plan, so it lands exactly when the install does.
  it('writes VAT\'s marker into the marketplace directory, with the install and only with it', async () => {
    const paths = buildTestPaths(getDir());
    const pluginDir = builtPlugin(getDir());
    const marker = safePath.join(paths.marketplacesDir, MARKETPLACE_NAME, VAT_MARKETPLACE_MARKER);

    const refused = await underFaults(getDir(), { faults: [refusedRegistryWrite(paths.userSettingsPath, 'EACCES')] }, () =>
      rejectionOf(() => installAt(pluginDir, paths)));
    expect(refused).toBeDefined();
    expect(existsSync(marker)).toBe(false);

    await installAt(pluginDir, paths);
    expect(statSync(marker).isFile()).toBe(true);
  });

  it('full flow: creates dirs, writes registry files, updates settings.json', async () => {
    const paths = buildTestPaths(getDir());

    // Create a fake pluginDir with a dummy file
    const pluginDir = safePath.join(getDir(), 'dist', 'plugins', PLUGIN_NAME);
    mkdirSyncReal(pluginDir, { recursive: true });
    writeFileSync(safePath.join(pluginDir, PLUGIN_JSON), JSON.stringify({ name: PLUGIN_NAME }));

    await installAt(pluginDir, paths);

    // Verify plugin was copied to marketplacesDir
    const marketplacePluginPath = safePath.join(paths.marketplacesDir, MARKETPLACE_NAME, 'plugins', PLUGIN_NAME);
    expect(existsSync(marketplacePluginPath)).toBe(true);
    expect(existsSync(safePath.join(marketplacePluginPath, PLUGIN_JSON))).toBe(true);

    // Verify known_marketplaces.json was written
    expect(existsSync(paths.knownMarketplacesPath)).toBe(true);
    const knownMarketplaces = readKnownMarketplaces(paths, 'destination');
    expect(knownMarketplaces[MARKETPLACE_NAME]).toBeDefined();
    expect(knownMarketplaces[MARKETPLACE_NAME]?.source.source).toBe('npm');

    // Verify installed_plugins.json was written
    expect(existsSync(paths.installedPluginsPath)).toBe(true);
    const installedPlugins = readInstalledPlugins(paths, 'destination');
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

// Invariant I7: the trees are swapped in before the registry is written. A registry write that
// fails puts back every tree it swapped and every registry file it already wrote, byte for byte.
describe('a plugin install is one transaction with the registry', () => {
  const { getDir } = setupTempDir('vat-install-txn-');
  const KEY = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

  it.each(['knownMarketplacesPath', 'installedPluginsPath', 'userSettingsPath'] as const)(
    'a %s write it could not make on a re-install is a destination fault, every tree and registry file put back',
    async (file) => {
      const { paths, pluginDir } = await installedOnce(getDir());
      writeFileSync(safePath.join(pluginDir, 'second.txt'), 'v2');
      const before = snapshotTree(paths.claudeDir);

      const error = await underFaults(getDir(), { faults: [refusedRegistryWrite(paths[file], 'EACCES')] }, () =>
        rejectionOf(() => installAt(pluginDir, paths)));

      expect(error, String(error)).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'refused' });
      expect(String(error)).toContain(KEY);
      expect(diffSnapshots(before, snapshotTree(paths.claudeDir))).toEqual([]);
    },
  );

  it('a first install whose settings write fails leaves nothing under ~/.claude, not even the parents it made', async () => {
    const paths = buildTestPaths(getDir());
    const pluginDir = builtPlugin(getDir());

    const error = await underFaults(getDir(), { faults: [{ family: 'rename', path: stagedWriteOf(paths.userSettingsPath), errno: 'ENOSPC' }] }, () =>
      rejectionOf(() => installAt(pluginDir, paths)));

    expect(error, String(error)).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'exhausted' });
    expect(existsSync(paths.claudeDir)).toBe(false);
  });

  it('names a registry file it could not put back as TREE_ROLLBACK_INCOMPLETE', async () => {
    const { paths, pluginDir } = await installedOnce(getDir());

    const error = await underFaults(getDir(), { faults: [
      refusedRegistryWrite(paths.userSettingsPath, 'EACCES'),
      // The second write of known_marketplaces.json is its restore.
      refusedRegistryWrite(paths.knownMarketplacesPath, 'EACCES', 2),
    ] }, () => rejectionOf(() => installAt(pluginDir, paths)));

    expect(isVatError(error, TREE_ROLLBACK_INCOMPLETE_CODE), String(error)).toBe(true);
    expect(String(error)).toContain(paths.knownMarketplacesPath);
  });

  // A registry read refused with ENOENT while the file IS there used to read as an empty
  // registry: the write after it dropped every other plugin the user had installed.
  it('refuses a registry file that is there but whose read answers ENOENT, changing nothing', async () => {
    const { paths, pluginDir } = await installedOnce(getDir());
    const before = snapshotTree(paths.claudeDir);

    const error = await underFaults(getDir(), { faults: [{ family: 'read', path: (p) => p === paths.installedPluginsPath, errno: 'ENOENT' }] }, () =>
      rejectionOf(() => installAt(pluginDir, paths)));

    expect(error, String(error)).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', path: paths.installedPluginsPath });
    expect(diffSnapshots(before, snapshotTree(paths.claudeDir))).toEqual([]);
  });
});
