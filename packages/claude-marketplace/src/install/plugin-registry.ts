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
import { dirname, join, resolve } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';

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
 * Read known_marketplaces.json from the Claude plugins directory.
 * Returns an empty object if the file does not exist.
 */
export function readKnownMarketplaces(paths: ClaudeUserPaths): KnownMarketplaces {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths from ClaudeUserPaths
    const raw = readFileSync(paths.knownMarketplacesPath, 'utf-8');
    return JSON.parse(raw) as KnownMarketplaces;
  } catch {
    return {};
  }
}

/**
 * Write known_marketplaces.json to the Claude plugins directory.
 * Creates parent directories if needed.
 */
export function writeKnownMarketplaces(paths: ClaudeUserPaths, data: KnownMarketplaces): void {
  mkdirSyncReal(dirname(paths.knownMarketplacesPath), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths from ClaudeUserPaths
  writeFileSync(paths.knownMarketplacesPath, JSON.stringify(data, null, 2));
}

/**
 * Read installed_plugins.json from the Claude plugins directory.
 * Returns empty registry if the file does not exist.
 */
export function readInstalledPlugins(paths: ClaudeUserPaths): InstalledPlugins {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths from ClaudeUserPaths
    const raw = readFileSync(paths.installedPluginsPath, 'utf-8');
    return JSON.parse(raw) as InstalledPlugins;
  } catch {
    return { version: 2, plugins: {} };
  }
}

/**
 * Write installed_plugins.json to the Claude plugins directory.
 * Creates parent directories if needed.
 */
export function writeInstalledPlugins(paths: ClaudeUserPaths, data: InstalledPlugins): void {
  mkdirSyncReal(dirname(paths.installedPluginsPath), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths from ClaudeUserPaths
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
    const marketplacePluginDest = join(paths.marketplacesDir, marketplaceName, 'plugins', pluginName);
    if (resolve(pluginDir) !== resolve(marketplacePluginDest)) {
      mkdirSyncReal(marketplacePluginDest, { recursive: true });
      cpSync(pluginDir, marketplacePluginDest, { recursive: true });
    }

    // Step 2: Update known_marketplaces.json
    const knownMarketplaces = readKnownMarketplaces(paths);
    knownMarketplaces[marketplaceName] = {
      source: source as MarketplaceSource,
      installLocation: join(paths.marketplacesDir, marketplaceName),
      lastUpdated: now,
    };
    writeKnownMarketplaces(paths, knownMarketplaces);

    // Step 3: Copy plugin to pluginsCacheDir/<marketplaceName>/<pluginName>/<version>/
    // Skip if source and destination are the same
    const cacheDest = join(paths.pluginsCacheDir, marketplaceName, pluginName, version);
    if (resolve(pluginDir) !== resolve(cacheDest)) {
      mkdirSyncReal(cacheDest, { recursive: true });
      cpSync(pluginDir, cacheDest, { recursive: true });
    }

    // Step 4: Update installed_plugins.json
    const installedPlugins = readInstalledPlugins(paths);
    installedPlugins.plugins[pluginKey] = [
      {
        scope: 'user',
        installPath: join(paths.pluginsCacheDir, marketplaceName, pluginName, version),
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

function updateUserSettings(paths: ClaudeUserPaths, pluginKey: string): void {
  let settingsData: Record<string, unknown> = {};
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths from ClaudeUserPaths
    const raw = readFileSync(paths.userSettingsPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settingsData = parsed as Record<string, unknown>;
    }
  } catch {
    // File does not exist or is invalid — start from empty
  }

  const existingEnabled =
    settingsData['enabledPlugins'] !== null &&
    typeof settingsData['enabledPlugins'] === 'object' &&
    !Array.isArray(settingsData['enabledPlugins'])
      ? (settingsData['enabledPlugins'] as Record<string, boolean>)
      : {};

  settingsData['enabledPlugins'] = { ...existingEnabled, [pluginKey]: true };

  mkdirSyncReal(dirname(paths.userSettingsPath), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths from ClaudeUserPaths
  writeFileSync(paths.userSettingsPath, JSON.stringify(settingsData, null, 2));
}
