/**
 * Plugin uninstall — reverses all 5 artifacts written by installPlugin().
 *
 * Idempotent: exits cleanly if plugin is not found.
 */

import type { BigIntStats } from 'node:fs';
import { existsSync, lstatSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { isPathAbsentError, isVatError, mkdirSyncReal, normalizePath, safePath, VatError } from '@vibe-agent-toolkit/utils';

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

/**
 * Which directory an entry is: its device + inode, or — where the filesystem
 * reports none (0) — its real path, case-folded so that the fallback can only
 * err towards "the same directory", which keeps.
 */
interface DirIdentity {
  readonly id: string | undefined;
  readonly path: () => string;
}

function identityOf(stats: BigIntStats, realPath: () => string): DirIdentity {
  const known = stats.ino !== 0n && stats.dev !== 0n;
  return { id: known ? `${stats.dev}:${stats.ino}` : undefined, path: () => realPath().toLowerCase() };
}

function sameDirectory(a: DirIdentity, b: DirIdentity): boolean {
  return a.id !== undefined && b.id !== undefined ? a.id === b.id : a.path() === b.path();
}

/**
 * Every identity the entry at `path` answers to — the entry itself (a link not
 * followed: removing a link removes only the link) and, for a link, where it
 * leads — or none when nothing is there. A refusal is thrown, never read as "none".
 */
function identitiesAt(path: string): DirIdentity[] {
  let own: BigIntStats;
  try {
    own = lstatSync(path, { bigint: true });
  } catch (error) {
    if (isPathAbsentError(error)) return [];
    throw error;
  }
  const identities = [identityOf(own, () => safePath.join(normalizePath(dirname(path)), basename(path)))];
  if (!own.isSymbolicLink()) return identities;
  try {
    identities.push(identityOf(statSync(path, { bigint: true }), () => normalizePath(path)));
  } catch (error) {
    if (!isPathAbsentError(error)) throw error;
  }
  return identities;
}

/**
 * Why `dir` must be kept: another registered plugin's directory IS it on disk —
 * a case-insensitive filesystem makes `plugins/Old` and `plugins/old` one
 * directory, and a linked marketplace or plugin directory does the same — or
 * another plugin's directory could not be examined, so that cannot be ruled out.
 * `undefined` when `dir` may go. Decided by identity, never by comparing names.
 *
 * Only `dir`'s OWN refusal is thrown (the uninstall cannot proceed). A sibling's
 * keeps `dir` and never blocks: an unrelated plugin's unreadable directory must
 * not stop this uninstall, and uncertainty must not delete.
 */
function keepReason(
  dir: string,
  pluginKey: string,
  installed: InstalledPlugins,
  dirOf: (pluginName: string, marketplace: string) => string,
): string | undefined {
  const [target] = identitiesAt(dir);
  if (target === undefined) return undefined;
  for (const key of Object.keys(installed.plugins)) {
    const atIdx = key.lastIndexOf('@');
    if (key === pluginKey || atIdx <= 0) continue;
    // Read-only: an ill-formed key only names a path to examine, never one to remove.
    const other = dirOf(key.slice(0, atIdx), key.slice(atIdx + 1));
    try {
      if (identitiesAt(other).some((identity) => sameDirectory(target, identity))) return `${dir} (it is where ${key} is installed)`;
    } catch (error) {
      return `${dir} (${other}, where ${key} is installed, could not be examined to rule out that it is the same directory: ${String(error)})`;
    }
  }
  return undefined;
}

async function removePluginDirs(
  paths: ClaudeUserPaths,
  target: { pluginKey: string; pluginName: string; marketplace: string; installed: InstalledPlugins },
  mpPluginDir: string,
  mpPluginExists: boolean,
  dryRun: boolean,
): Promise<RemoveDirsResult & { kept: string[] }> {
  const { pluginKey, pluginName, marketplace, installed } = target;
  const mpDirOf = (name: string, mp: string): string => safePath.join(paths.marketplacesDir, mp, 'plugins', name);
  const cacheDirOf = (name: string, mp: string): string => safePath.join(paths.pluginsCacheDir, mp, name);
  const cachePluginDir = cacheDirOf(pluginName, marketplace);

  // Every verdict before the first removal: a refusal must stop the run with nothing removed.
  const verdicts = [
    { dir: mpPluginDir, present: mpPluginExists, dirOf: mpDirOf },
    { dir: cachePluginDir, present: existsSync(cachePluginDir), dirOf: cacheDirOf },
  ].map(({ dir, present, dirOf }) => ({ dir, present, keep: present ? keepReason(dir, pluginKey, installed, dirOf) : undefined }));

  const kept = verdicts.flatMap(({ keep }) => (keep === undefined ? [] : [keep]));
  const [pluginDir = false, cacheDir = false] = verdicts.map(({ present, keep }) => present && keep === undefined);
  if (!dryRun) {
    if (pluginDir) await rm(mpPluginDir, { recursive: true, force: true });
    if (cacheDir) await rm(cachePluginDir, { recursive: true, force: true });
  }
  return { pluginDir, cacheDir, kept };
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

  const { pluginDir, cacheDir, kept, installedPluginsRemoved, knownMarketplaces, settings } = await codedUserStateWrite(what, async () => {
    const dirs = await removePluginDirs(paths, { pluginKey, pluginName, marketplace, installed: installedPlugins }, mpPluginDir, mpPluginExists, dryRun);
    const entries = removeRegistryEntries(paths, pluginKey, marketplace, inRegistry, dryRun, installedPlugins);
    return { ...dirs, installedPluginsRemoved: entries.installedPlugins, knownMarketplaces: entries.knownMarketplaces, settings: removeFromSettings(paths, pluginKey, dryRun) };
  });

  const artifacts = { pluginDir, cacheDir, installedPlugins: installedPluginsRemoved, knownMarketplaces, settings };
  const warnings: string[] = [];
  if (isOrphan && kept.length === 0) {
    const action = dryRun ? 'it would be removed' : 'cleaning up';
    warnings.push(`Plugin "${pluginKey}" directory exists but was not installed via VAT — ${action}`);
  }
  if (kept.length > 0) {
    const keptList = kept.join('; ');
    warnings.push(dryRun
      ? `Plugin "${pluginKey}" would be removed from the registry, but these would be kept: ${keptList}`
      : `Plugin "${pluginKey}" was removed from the registry, but these were kept: ${keptList}`);
  }

  return warnings.length === 0 ? { removed: true, artifacts } : { removed: true, warning: warnings.join(' '), artifacts };
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
