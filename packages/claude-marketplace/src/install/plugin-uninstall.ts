/**
 * Plugin uninstall — reverses all 5 artifacts written by installPlugin().
 *
 * Idempotent: exits cleanly if plugin is not found.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';

import type { ClaudeUserPaths } from '../paths/claude-paths.js';

import type { InstalledPlugins } from './plugin-registry.js';
import {
  readInstalledPlugins,
  readKnownMarketplaces,
  readUserSettings,
  writeInstalledPlugins,
  writeKnownMarketplaces,
} from './plugin-registry.js';

export interface UninstallPluginOptions {
  /** "<pluginName>@<marketplace>" */
  pluginKey: string;
  paths: ClaudeUserPaths;
  dryRun?: boolean;
}

export interface UninstallPluginResult {
  /** true if plugin was found (and removed, or would remove in dryRun) */
  removed: boolean;
  /** set if directory existed but was not in the VAT registry */
  warning?: string;
  artifacts: {
    pluginDir: boolean;
    cacheDir: boolean;
    installedPlugins: boolean;
    knownMarketplaces: boolean;
    settings: boolean;
  };
}

function parsePluginKey(pluginKey: string): { pluginName: string; marketplace: string } {
  const atIdx = pluginKey.lastIndexOf('@');
  if (atIdx <= 0) throw new Error(`Invalid pluginKey: "${pluginKey}" — expected "<name>@<marketplace>"`);
  return { pluginName: pluginKey.slice(0, atIdx), marketplace: pluginKey.slice(atIdx + 1) };
}

function marketplaceHasOtherPlugins(plugins: Record<string, unknown>, pluginKey: string, marketplace: string): boolean {
  return Object.keys(plugins).some(key => key !== pluginKey && key.endsWith(`@${marketplace}`));
}

interface RemoveDirsResult {
  pluginDir: boolean;
  cacheDir: boolean;
}

async function removePluginDirs(
  paths: ClaudeUserPaths,
  pluginName: string,
  marketplace: string,
  mpPluginDir: string,
  mpPluginExists: boolean,
  dryRun: boolean,
): Promise<RemoveDirsResult> {
  let pluginDir = false;
  if (mpPluginExists) {
    if (!dryRun) await rm(mpPluginDir, { recursive: true, force: true });
    pluginDir = true;
  }

  const cachePluginDir = join(paths.pluginsCacheDir, marketplace, pluginName);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths from ClaudeUserPaths
  const cacheDir = existsSync(cachePluginDir);
  if (cacheDir && !dryRun) await rm(cachePluginDir, { recursive: true, force: true });

  return { pluginDir, cacheDir };
}

async function removeRegistryEntries(
  paths: ClaudeUserPaths,
  pluginKey: string,
  marketplace: string,
  inRegistry: boolean,
  dryRun: boolean,
  installedPluginsData: InstalledPlugins,
): Promise<{ installedPlugins: boolean; knownMarketplaces: boolean }> {
  let installedPluginsRemoved = false;

  if (inRegistry) {
    if (!dryRun) {
      delete installedPluginsData.plugins[pluginKey];
      writeInstalledPlugins(paths, installedPluginsData);
    }
    installedPluginsRemoved = true;
  }

  const knownMarketplacesData = readKnownMarketplaces(paths);
  const hasOthers = marketplaceHasOtherPlugins(installedPluginsData.plugins, pluginKey, marketplace);
  let knownMarketplacesRemoved = false;
  if (!hasOthers && Object.prototype.hasOwnProperty.call(knownMarketplacesData, marketplace)) {
    if (!dryRun) {
      delete knownMarketplacesData[marketplace];
      writeKnownMarketplaces(paths, knownMarketplacesData);
    }
    knownMarketplacesRemoved = true;
  }

  return { installedPlugins: installedPluginsRemoved, knownMarketplaces: knownMarketplacesRemoved };
}

/**
 * Uninstall a plugin installed via the file-based method.
 * Reverses all 5 artifacts written by installPlugin().
 * Idempotent — exits cleanly if plugin is not found.
 */
export async function uninstallPlugin(opts: UninstallPluginOptions): Promise<UninstallPluginResult> {
  const { pluginKey, paths, dryRun = false } = opts;
  const { pluginName, marketplace } = parsePluginKey(pluginKey);

  const emptyArtifacts = { pluginDir: false, cacheDir: false, installedPlugins: false, knownMarketplaces: false, settings: false };

  const mpPluginDir = join(paths.marketplacesDir, marketplace, 'plugins', pluginName);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths from ClaudeUserPaths
  const mpPluginExists = existsSync(mpPluginDir);

  const installedPlugins = readInstalledPlugins(paths);
  const inRegistry = Object.prototype.hasOwnProperty.call(installedPlugins.plugins, pluginKey);

  if (!mpPluginExists && !inRegistry) {
    await removeFromSettings(paths, pluginKey, dryRun);
    return { removed: false, artifacts: emptyArtifacts };
  }

  const isOrphan = mpPluginExists && !inRegistry;

  const { pluginDir, cacheDir } = await removePluginDirs(paths, pluginName, marketplace, mpPluginDir, mpPluginExists, dryRun);
  const { installedPlugins: installedPluginsRemoved, knownMarketplaces } = await removeRegistryEntries(paths, pluginKey, marketplace, inRegistry, dryRun, installedPlugins);
  const settings = await removeFromSettings(paths, pluginKey, dryRun);

  const artifacts = { pluginDir, cacheDir, installedPlugins: installedPluginsRemoved, knownMarketplaces, settings };

  if (isOrphan) {
    return { removed: true, warning: `Plugin "${pluginKey}" directory exists but was not installed via VAT — cleaning up`, artifacts };
  }

  return { removed: true, artifacts };
}

/**
 * Find all plugin keys (name@marketplace) installed from a given npm package.
 * Uses known_marketplaces.json source.package to match.
 */
export function findPluginsByPackage(npmPackage: string, paths: ClaudeUserPaths): string[] {
  const knownMarketplaces = readKnownMarketplaces(paths);
  const installedPlugins = readInstalledPlugins(paths);

  const matchingMarketplaces = new Set(
    Object.entries(knownMarketplaces)
      .filter(([, entry]) => {
        const src = entry.source;
        if (src.source !== 'npm') return false;
        // MarketplaceSource uses [key: string]: unknown for npm-specific fields
        const pkg = src['package'];
        return typeof pkg === 'string' && pkg === npmPackage;
      })
      .map(([name]) => name),
  );

  return Object.keys(installedPlugins.plugins).filter(key => {
    const atIdx = key.lastIndexOf('@');
    if (atIdx <= 0) return false;
    return matchingMarketplaces.has(key.slice(atIdx + 1));
  });
}

async function removeFromSettings(paths: ClaudeUserPaths, pluginKey: string, dryRun: boolean): Promise<boolean> {
  const settingsData = readUserSettings(paths);
  const enabled = settingsData['enabledPlugins'];
  if (enabled === null || typeof enabled !== 'object' || Array.isArray(enabled)) return false;
  const ep = enabled as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(ep, pluginKey)) return false;

  if (!dryRun) {
    delete ep[pluginKey];
    settingsData['enabledPlugins'] = ep;
    mkdirSyncReal(dirname(paths.userSettingsPath), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths from ClaudeUserPaths
    writeFileSync(paths.userSettingsPath, JSON.stringify(settingsData, null, 2));
  }
  return true;
}
