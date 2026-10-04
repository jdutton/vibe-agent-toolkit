/**
 * Plugin registry — read/write Claude's plugin registry files and install plugins.
 *
 * Manages:
 * - known_marketplaces.json: Registry of known marketplace sources
 * - installed_plugins.json: Registry of installed plugins
 *
 * Follows Postel's Law: reads with fallbacks (liberal), writes with structured data.
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { isPathAbsentError, isUnderRoot, isVatError, mkdirSyncReal, normalizePath, safePath, toForwardSlash, VatError } from '@vibe-agent-toolkit/utils';

import type { ClaudeUserPaths } from '../paths/claude-paths.js';

export interface MarketplaceSource {
  source: 'npm' | 'github' | 'url' | 'hostPattern';
  [key: string]: unknown;
}

export interface KnownMarketplaceEntry {
  source: MarketplaceSource;
  installLocation: string;
  lastUpdated: string;
}

export type KnownMarketplaces = Record<string, KnownMarketplaceEntry>;

export interface InstalledPluginEntry {
  scope: 'user' | 'project';
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
}

export interface InstalledPlugins {
  version: 2;
  plugins: Record<string, InstalledPluginEntry[]>;
}

export type InstallPluginSource =
  | { source: 'npm'; package: string; version?: string }
  | { source: 'github'; repo: string }
  | { source: 'url'; url: string };

export interface InstallPluginOptions {
  marketplaceName: string;
  pluginName: string;
  /** Absolute path to dist/plugins/<name>/ */
  pluginDir: string;
  version: string;
  source: InstallPluginSource;
  paths: ClaudeUserPaths;
}

/** A Claude Code registry, settings file or skills dir that is present and unreadable, or not JSON. */
export const CLAUDE_USER_STATE_UNREADABLE_CODE = 'CLAUDE_USER_STATE_UNREADABLE';

/** A copy, write or removal in Claude user state failed partway (install or uninstall). */
export const CLAUDE_USER_STATE_WRITE_FAILED_CODE = 'CLAUDE_USER_STATE_WRITE_FAILED';

/** The plugin directory to install is absent, not a directory, or one the OS will not list: the input, not Claude's state. */
export const PLUGIN_SOURCE_UNREADABLE_CODE = 'PLUGIN_SOURCE_UNREADABLE';

/**
 * Refuse a plugin source that cannot be listed, before anything is written for it.
 *
 * @throws VatError {@link PLUGIN_SOURCE_UNREADABLE_CODE}
 */
function requirePluginSource(pluginDir: string): void {
  try {
    readdirSync(pluginDir);
  } catch (error) {
    throw new VatError(PLUGIN_SOURCE_UNREADABLE_CODE, `Could not read the plugin to install at ${pluginDir}: ${String(error)}`, { cause: error });
  }
}

/**
 * Run a mutation of Claude user state; a failure that is not already coded is
 * rethrown as {@link CLAUDE_USER_STATE_WRITE_FAILED_CODE}, naming `what`.
 */
export async function codedUserStateWrite<T>(what: string, mutate: () => T | Promise<T>): Promise<T> {
  try {
    return await mutate();
  } catch (error) {
    if (isVatError(error)) throw error;
    throw new VatError(CLAUDE_USER_STATE_WRITE_FAILED_CODE, `Could not ${what}: ${String(error)}`, { cause: error });
  }
}

/** Whether `source` IS `dest` on disk, or lies inside it — copying there would copy a tree onto itself. */
function resolvesInto(source: string, dest: string): boolean {
  const real = (p: string): string => toForwardSlash(normalizePath(safePath.resolve(p)));
  return real(source) === real(dest) || isUnderRoot(dest, source) === 'inside';
}

/**
 * Make `dest` a copy of `source`, replacing whatever tree is there.
 *
 * Replaced, never copied into: a re-install's links would copy onto their own
 * targets. And never deleted first: the registry already points at `dest`, so a
 * copy that fails must leave the previous tree in place. The copy goes to a
 * sibling directory and is swapped in only once it is whole; a failure removes
 * the sibling and, if the swap itself failed, puts the previous tree back.
 */
function replaceDirectory(source: string, dest: string): void {
  const parent = dirname(dest);
  mkdirSyncReal(parent, { recursive: true });
  const staged = mkdtempSync(safePath.join(parent, `${basename(dest)}.tmp-`));
  try {
    cpSync(source, staged, { recursive: true });
    swapIn(staged, dest);
  } finally {
    // Gone already once swapped in; otherwise the half-copied sibling must not stay to read as a version.
    rmSync(staged, { recursive: true, force: true });
  }
}

/** Move the whole tree `staged` to `dest`; the tree `dest` held is removed only after `staged` is in its place. */
function swapIn(staged: string, dest: string): void {
  if (!existsSync(dest)) {
    renameSync(staged, dest);
    return;
  }
  const previous = `${staged}.previous`;
  renameSync(dest, previous);
  try {
    renameSync(staged, dest);
  } catch (error) {
    renameSync(previous, dest);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
}

/**
 * Parse a registry file that Claude Code owns, or `undefined` when it is not there.
 *
 * ⚠️ ONLY an absent file is "empty". Every reader here is followed by a WRITE of
 * the same file, so a file that is present but cannot be read — refused by the
 * OS, or not JSON after a half-written save — must not read as empty: the next
 * write would then replace the user's registry (or their whole `settings.json`)
 * with a document holding nothing but the plugin being installed. That refusal
 * is thrown coded {@link CLAUDE_USER_STATE_UNREADABLE_CODE}, naming the file.
 */
function readRegistryFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    throw new VatError(CLAUDE_USER_STATE_UNREADABLE_CODE, `Could not read ${filePath}: ${String(error)}`, { cause: error });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new VatError(CLAUDE_USER_STATE_UNREADABLE_CODE, `${filePath} is not valid JSON: ${String(error)}`, { cause: error });
  }
}

/**
 * Read known_marketplaces.json from the Claude plugins directory.
 * Returns an empty object if the file does not exist; throws if it is there but unreadable.
 */
export function readKnownMarketplaces(paths: ClaudeUserPaths): KnownMarketplaces {
  return (readRegistryFile(paths.knownMarketplacesPath) as KnownMarketplaces | undefined) ?? {};
}

/**
 * Write known_marketplaces.json to the Claude plugins directory.
 * Creates parent directories if needed.
 */
export function writeKnownMarketplaces(paths: ClaudeUserPaths, data: KnownMarketplaces): void {
  mkdirSyncReal(dirname(paths.knownMarketplacesPath), { recursive: true });
  writeFileSync(paths.knownMarketplacesPath, JSON.stringify(data, null, 2));
}

/**
 * Read installed_plugins.json from the Claude plugins directory.
 * Returns empty registry if the file does not exist; throws if it is there but unreadable.
 */
export function readInstalledPlugins(paths: ClaudeUserPaths): InstalledPlugins {
  return (readRegistryFile(paths.installedPluginsPath) as InstalledPlugins | undefined)
    ?? { version: 2, plugins: {} };
}

/**
 * Write installed_plugins.json to the Claude plugins directory.
 * Creates parent directories if needed.
 */
export function writeInstalledPlugins(paths: ClaudeUserPaths, data: InstalledPlugins): void {
  mkdirSyncReal(dirname(paths.installedPluginsPath), { recursive: true });
  writeFileSync(paths.installedPluginsPath, JSON.stringify(data, null, 2));
}

/**
 * Install a plugin into the Claude user plugin registry.
 *
 * The source is read first: one that is not there is refused
 * ({@link PLUGIN_SOURCE_UNREADABLE_CODE}) with nothing created. Then 5 steps in
 * order; a failure throws, coded (see the two user-state codes above).
 * 1. Copy plugin files to marketplacesDir
 * 2. Update known_marketplaces.json
 * 3. Copy plugin files to pluginsCacheDir
 * 4. Update installed_plugins.json
 * 5. Enable plugin in user settings.json
 */
export async function installPlugin(opts: InstallPluginOptions): Promise<void> {
  const { marketplaceName, pluginName, pluginDir, version, source, paths } = opts;

  const pluginKey = `${pluginName}@${marketplaceName}`;
  requirePluginSource(pluginDir);
  await codedUserStateWrite(`register plugin ${pluginKey}`, () => {
    const now = new Date().toISOString();
    // The directory itself, not a link to it: a copied link would collide with the directory it lands on.
    const realPluginDir = normalizePath(safePath.resolve(pluginDir));

    // Step 1: Copy plugin to marketplacesDir/<marketplaceName>/plugins/<pluginName>/
    // Skip if pluginDir is already at the destination (e.g. copyPluginTree already did the copy)
    const marketplacePluginDest = safePath.join(paths.marketplacesDir, marketplaceName, 'plugins', pluginName);
    if (!resolvesInto(pluginDir, marketplacePluginDest)) {
      mkdirSyncReal(marketplacePluginDest, { recursive: true });
      cpSync(realPluginDir, marketplacePluginDest, { recursive: true });
    }

    // Step 2: Update known_marketplaces.json
    const knownMarketplaces = readKnownMarketplaces(paths);
    knownMarketplaces[marketplaceName] = {
      source: source as MarketplaceSource,
      installLocation: safePath.join(paths.marketplacesDir, marketplaceName),
      lastUpdated: now,
    };
    writeKnownMarketplaces(paths, knownMarketplaces);

    // Step 3: Copy plugin to pluginsCacheDir/<marketplaceName>/<pluginName>/<version>/
    // Skip when the source IS the destination on disk (or inside it) — replacing it would delete the source
    const cacheDest = safePath.join(paths.pluginsCacheDir, marketplaceName, pluginName, version);
    if (!resolvesInto(pluginDir, cacheDest)) {
      replaceDirectory(realPluginDir, cacheDest);
    }

    // Step 4: Update installed_plugins.json
    const installedPlugins = readInstalledPlugins(paths);
    installedPlugins.plugins[pluginKey] = [
      {
        scope: 'user',
        installPath: safePath.join(paths.pluginsCacheDir, marketplaceName, pluginName, version),
        version,
        installedAt: now,
        lastUpdated: now,
      },
    ];
    writeInstalledPlugins(paths, installedPlugins);

    // Step 5: Enable plugin in user settings.json
    updateUserSettings(paths, pluginKey);
  });
}

/**
 * Read user settings.json as a plain object.
 * Returns an empty object if the file does not exist or holds JSON that is not an
 * object; throws if it is there but cannot be read or parsed (see `readRegistryFile`).
 */
export function readUserSettings(paths: ClaudeUserPaths): Record<string, unknown> {
  const parsed = readRegistryFile(paths.userSettingsPath);
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function updateUserSettings(paths: ClaudeUserPaths, pluginKey: string): void {
  const settingsData = readUserSettings(paths);

  const existingEnabled =
    settingsData['enabledPlugins'] !== null &&
    typeof settingsData['enabledPlugins'] === 'object' &&
    !Array.isArray(settingsData['enabledPlugins'])
      ? (settingsData['enabledPlugins'] as Record<string, boolean>)
      : {};

  settingsData['enabledPlugins'] = { ...existingEnabled, [pluginKey]: true };

  mkdirSyncReal(dirname(paths.userSettingsPath), { recursive: true });
  writeFileSync(paths.userSettingsPath, JSON.stringify(settingsData, null, 2));
}
