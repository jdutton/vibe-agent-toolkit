/**
 * Plugin registry — read/write Claude's plugin registry files and install plugins.
 *
 * Manages:
 * - known_marketplaces.json: Registry of known marketplace sources
 * - installed_plugins.json: Registry of installed plugins
 *
 * Follows Postel's Law: reads with fallbacks (liberal), writes with structured data.
 */

import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isPathAbsentError, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

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

/**
 * Parse a registry file that Claude Code owns, or `undefined` when it is not there.
 *
 * ⚠️ ONLY an absent file is "empty". Every reader here is followed by a WRITE of
 * the same file, so a file that is present but cannot be read — refused by the
 * OS, or not JSON after a half-written save — must not read as empty: the next
 * write would then replace the user's registry (or their whole `settings.json`)
 * with a document holding nothing but the plugin being installed. That refusal
 * is translated so the message names the file, and `installPlugin`'s own catch
 * turns it into the warning the operator sees.
 */
function readRegistryFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    throw new Error(`Could not read ${filePath}: ${String(error)}`, { cause: error });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${String(error)}`, { cause: error });
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
 * Performs 5 steps atomically (best-effort — failures warn but never throw):
 * 1. Copy plugin files to marketplacesDir
 * 2. Update known_marketplaces.json
 * 3. Copy plugin files to pluginsCacheDir
 * 4. Update installed_plugins.json
 * 5. Enable plugin in user settings.json
 */
export async function installPlugin(opts: InstallPluginOptions): Promise<void> {
  const { marketplaceName, pluginName, pluginDir, version, source, paths } = opts;

  try {
    const now = new Date().toISOString();
    const pluginKey = `${pluginName}@${marketplaceName}`;

    // Step 1: Copy plugin to marketplacesDir/<marketplaceName>/plugins/<pluginName>/
    // Skip if pluginDir is already at the destination (e.g. copyPluginTree already did the copy)
    const marketplacePluginDest = safePath.join(paths.marketplacesDir, marketplaceName, 'plugins', pluginName);
    if (safePath.resolve(pluginDir) !== safePath.resolve(marketplacePluginDest)) {
      mkdirSyncReal(marketplacePluginDest, { recursive: true });
      cpSync(pluginDir, marketplacePluginDest, { recursive: true });
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
    // Skip if source and destination are the same
    const cacheDest = safePath.join(paths.pluginsCacheDir, marketplaceName, pluginName, version);
    if (safePath.resolve(pluginDir) !== safePath.resolve(cacheDest)) {
      mkdirSyncReal(cacheDest, { recursive: true });
      cpSync(pluginDir, cacheDest, { recursive: true });
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
  } catch (error) {
    console.warn(`[vat] Warning: Could not register plugin ${opts.pluginName}@${opts.marketplaceName}: ${String(error)}`);
  }
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
