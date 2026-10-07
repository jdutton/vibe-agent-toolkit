/**
 * Plugin uninstall — reverses all 5 artifacts written by installPlugin().
 *
 * Idempotent: exits cleanly if plugin is not found.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isVatError, mkdirSyncReal, safePath, VatError } from '@vibe-agent-toolkit/utils';

import type { ClaudeUserPaths } from '../paths/claude-paths.js';

import type { InstalledPlugins } from './plugin-registry.js';
import {
  CLAUDE_USER_STATE_UNREADABLE_CODE,
  codedUserStateWrite,
  PLUGIN_KEY_INVALID_CODE,
  readInstalledPlugins,
  readKnownMarketplaces,
  readUserSettings,
  requirePluginPathSegment,
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

/**
 * Split a plugin key at its LAST `@`.
 *
 * @throws VatError {@link PLUGIN_KEY_INVALID_CODE} when either half is empty or
 *   is not a single path segment
 */
export function parsePluginKey(pluginKey: string): { pluginName: string; marketplace: string } {
  const atIdx = pluginKey.lastIndexOf('@');
  if (atIdx <= 0 || atIdx === pluginKey.length - 1) {
    throw new VatError(PLUGIN_KEY_INVALID_CODE, `Invalid plugin key "${pluginKey}" — expected "<plugin>@<marketplace>".`);
  }
  const pluginName = pluginKey.slice(0, atIdx);
  const marketplace = pluginKey.slice(atIdx + 1);
  requirePluginPathSegment(pluginName, 'plugin name', pluginKey);
  requirePluginPathSegment(marketplace, 'marketplace name', pluginKey);
  return { pluginName, marketplace };
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

  const cachePluginDir = safePath.join(paths.pluginsCacheDir, marketplace, pluginName);
  const cacheDir = existsSync(cachePluginDir);
  if (cacheDir && !dryRun) await rm(cachePluginDir, { recursive: true, force: true });

  return { pluginDir, cacheDir };
}

function removeRegistryEntries(
  paths: ClaudeUserPaths,
  pluginKey: string,
  marketplace: string,
  inRegistry: boolean,
  dryRun: boolean,
  installedPluginsData: InstalledPlugins,
): { installedPlugins: boolean; knownMarketplaces: boolean } {
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
  if (!hasOthers && Object.hasOwn(knownMarketplacesData, marketplace)) {
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

  const mpPluginDir = safePath.join(paths.marketplacesDir, marketplace, 'plugins', pluginName);
  const mpPluginExists = existsSync(mpPluginDir);

  const installedPlugins = readInstalledPlugins(paths);
  const inRegistry = Object.hasOwn(installedPlugins.plugins, pluginKey);

  const what = `uninstall plugin ${pluginKey}`;
  if (!mpPluginExists && !inRegistry) {
    await codedUserStateWrite(what, () => removeFromSettings(paths, pluginKey, dryRun));
    return { removed: false, artifacts: emptyArtifacts };
  }

  const isOrphan = mpPluginExists && !inRegistry;

  const { pluginDir, cacheDir, installedPluginsRemoved, knownMarketplaces, settings } = await codedUserStateWrite(what, async () => {
    const dirs = await removePluginDirs(paths, pluginName, marketplace, mpPluginDir, mpPluginExists, dryRun);
    const entries = removeRegistryEntries(paths, pluginKey, marketplace, inRegistry, dryRun, installedPlugins);
    return { ...dirs, installedPluginsRemoved: entries.installedPlugins, knownMarketplaces: entries.knownMarketplaces, settings: removeFromSettings(paths, pluginKey, dryRun) };
  });

  const artifacts = { pluginDir, cacheDir, installedPlugins: installedPluginsRemoved, knownMarketplaces, settings };

  if (isOrphan) {
    const action = dryRun ? 'it would be removed' : 'cleaning up';
    return { removed: true, warning: `Plugin "${pluginKey}" directory exists but was not installed via VAT — ${action}`, artifacts };
  }

  return { removed: true, artifacts };
}

/**
 * Find all plugin keys (name@marketplace) installed from a given npm package.
 * Uses known_marketplaces.json source.package to match.
 *
 * Every key returned is a valid plugin key: one in the registry that is not
 * would aim the removal outside ~/.claude, and it was READ, not typed — so it is
 * the registry's fault, refused before the caller uninstalls anything.
 *
 * @throws VatError {@link CLAUDE_USER_STATE_UNREADABLE_CODE} naming the key and the registry
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

  const keys = Object.keys(installedPlugins.plugins).filter(key => {
    const atIdx = key.lastIndexOf('@');
    if (atIdx <= 0) return false;
    return matchingMarketplaces.has(key.slice(atIdx + 1));
  });
  for (const key of keys) {
    try {
      parsePluginKey(key);
    } catch (error) {
      if (!isVatError(error, PLUGIN_KEY_INVALID_CODE)) throw error;
      throw new VatError(
        CLAUDE_USER_STATE_UNREADABLE_CODE,
        `${paths.installedPluginsPath} holds "${key}", which is not a plugin key (${error.message}); nothing was uninstalled. Remove that entry from the file, or uninstall the others one key at a time.`,
        { cause: error },
      );
    }
  }
  return keys;
}

function removeFromSettings(paths: ClaudeUserPaths, pluginKey: string, dryRun: boolean): boolean {
  const settingsData = readUserSettings(paths);
  const enabled = settingsData['enabledPlugins'];
  if (enabled === null || typeof enabled !== 'object' || Array.isArray(enabled)) return false;
  const ep = enabled as Record<string, unknown>;
  if (!Object.hasOwn(ep, pluginKey)) return false;

  if (!dryRun) {
    delete ep[pluginKey];
    settingsData['enabledPlugins'] = ep;
    mkdirSyncReal(dirname(paths.userSettingsPath), { recursive: true });
    writeFileSync(paths.userSettingsPath, JSON.stringify(settingsData, null, 2));
  }
  return true;
}
