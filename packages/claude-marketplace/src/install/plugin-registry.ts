/**
 * Plugin registry — read Claude's plugin registry files, and record an install in them (the
 * registry edit `planPackageInstall` applies beside its tree changes).
 *
 * Manages:
 * - known_marketplaces.json: Registry of known marketplace sources
 * - installed_plugins.json: Registry of installed plugins
 *
 * Follows Postel's Law: reads with fallbacks (liberal), writes with structured data.
 */

import { lstatSync, readFileSync } from 'node:fs';

import {
  classifyFsFault,
  type FsSide,
  isPathAbsentError,
  isSingleFsSegment,
  type OwnershipVerdict,
  requireConfirmedAbsent,
  safePath,
  VatError,
  withFsFault,
} from '@vibe-agent-toolkit/utils';

import type { ClaudeUserPaths } from '../paths/claude-paths.js';

import { type RegistryEdit, registryEdit, type RegistryFileChange } from './registry-edit.js';

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

/** One plugin of an install, as the registry records it: its two names, its version, and where it came from. */
export interface InstallPluginOptions {
  marketplaceName: string;
  pluginName: string;
  version: string;
  source: InstallPluginSource;
}

/**
 * A Claude Code registry or settings file whose CONTENT VAT cannot use: not JSON, the
 * wrong shape, or an entry that is not a plugin key. A file the OS refuses is not this:
 * it is a classified filesystem fault (`FS_FAULT`), decided by the refusal table.
 */
export const CLAUDE_USER_STATE_UNREADABLE_CODE = 'CLAUDE_USER_STATE_UNREADABLE';

/**
 * The code for a plugin key — or a plugin name, marketplace name or version
 * given to an install — that cannot name one entry under ~/.claude.
 */
export const PLUGIN_KEY_INVALID_CODE = 'PLUGIN_KEY_INVALID';

/**
 * Refuse a plugin name, marketplace name or version that is not ONE path
 * segment. Each is joined into a path under ~/.claude that is copied over or
 * removed recursively, so `..`, a separator or an absolute or drive-letter name
 * would reach outside it.
 *
 * @param value - The name or version, exactly as given
 * @param what - What it is, for the refusal's wording
 * @param context - The key or install it came from
 * @throws VatError {@link PLUGIN_KEY_INVALID_CODE} when it is not one segment
 */
export function requirePluginPathSegment(value: string, what: string, context: string): void {
  if (!isSingleFsSegment(value)) {
    throw new VatError(
      PLUGIN_KEY_INVALID_CODE,
      `Invalid ${what} "${value}" in "${context}": it must be a single path segment (no path separator, not "." or "..", not absolute).`,
    );
  }
}

/**
 * Refuse names and a version a plugin cannot be installed under: each
 * must be one path segment, and the version must not begin with `.` — the
 * cache's version directory would then be dot-named, which `vat inventory`
 * skips as a staging leftover, so the plugin would install and never be seen.
 * Pure: a caller validates every plugin a package ships before it mutates
 * anything for the first one.
 *
 * @throws VatError {@link PLUGIN_KEY_INVALID_CODE} naming what is wrong
 */
export function requirePluginInstallNames(names: Pick<InstallPluginOptions, 'marketplaceName' | 'pluginName' | 'version'>): void {
  const { marketplaceName, pluginName, version } = names;
  const pluginKey = `${pluginName}@${marketplaceName}`;
  requirePluginPathSegment(pluginName, 'plugin name', pluginKey);
  requirePluginPathSegment(marketplaceName, 'marketplace name', pluginKey);
  requirePluginPathSegment(version, 'version', pluginKey);
  if (version.startsWith('.')) {
    throw new VatError(
      PLUGIN_KEY_INVALID_CODE,
      `Invalid version "${version}" in "${pluginKey}": a version must not begin with "." (its cache directory would be hidden from inventory).`,
    );
  }
}

/**
 * Run a mutation of Claude user state: a filesystem fault is the user state the run
 * writes (`destination`); anything that is not a filesystem errno propagates as it was.
 *
 * The side is the mutation's, not decided by the path the OS named: node names the
 * SOURCE path of a copy whose WRITE failed, so a path-decided side would put a full or
 * read-only `~/.claude` on the input.
 *
 * @param action - A verb phrase for the message: `register plugin <key>`
 * @param mutate - The mutation
 */
export function writeUserState<T>(action: string, mutate: () => T | Promise<T>): Promise<T> {
  return withFsFault({ side: 'destination', action }, async () => await mutate());
}

/** A registry file as read: its bytes (`undefined`: no file there) and their parse. */
export interface RegistryRead {
  readonly prior: Buffer | undefined;
  readonly parsed: unknown;
}

const READ_REGISTRY = 'read a Claude Code registry file';

/**
 * Read and parse a registry file that Claude Code owns.
 *
 * `side` is the calling verb's: the registry is the user state an install or
 * uninstall WRITES (`destination`), and the input a listing only reads (`source`).
 *
 * ⚠️ ONLY an absent file is "empty". Every reader here is followed by a WRITE of
 * the same file, so a file that is present but cannot be read — refused by the
 * OS, or not JSON after a half-written save — must not read as empty: the next
 * write would then replace the user's registry (or their whole `settings.json`)
 * with a document holding nothing but the plugin being installed. A file the OS
 * refuses is a classified fault on `side`; one that is not JSON is coded
 * {@link CLAUDE_USER_STATE_UNREADABLE_CODE}, naming the file.
 */
function readRegistry(filePath: string, side: FsSide): RegistryRead {
  let prior: Buffer;
  try {
    prior = readFileSync(filePath);
  } catch (error) {
    const ctx = { side, origin: 'content', action: READ_REGISTRY, path: filePath } as const;
    if (!isPathAbsentError(error)) throw classifyFsFault(error, ctx);
    // Absent only when the directory's listing agrees: a refused read of a file that IS there
    // would read as an empty registry, and the write after it would drop every entry it held.
    requireConfirmedAbsent(filePath, error, ctx, { follows: true });
    return { prior: undefined, parsed: undefined };
  }
  try {
    return { prior, parsed: JSON.parse(prior.toString('utf-8')) as unknown };
  } catch (error) {
    throw new VatError(CLAUDE_USER_STATE_UNREADABLE_CODE, `${filePath} is not valid JSON: ${String(error)}`, { cause: error });
  }
}

/** `value` as an object, or `{}` when it is absent or JSON that is not one. */
function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function installedPluginsOf(read: RegistryRead): InstalledPlugins {
  return (read.parsed as InstalledPlugins | undefined) ?? { version: 2, plugins: {} };
}

/**
 * Read known_marketplaces.json from the Claude plugins directory.
 * Returns an empty object if the file does not exist; throws if it is there but unreadable.
 */
export function readKnownMarketplaces(paths: ClaudeUserPaths, side: FsSide): KnownMarketplaces {
  return objectOf(readRegistry(paths.knownMarketplacesPath, side).parsed) as KnownMarketplaces;
}

/**
 * Read installed_plugins.json from the Claude plugins directory.
 * Returns empty registry if the file does not exist; throws if it is there but unreadable.
 */
export function readInstalledPlugins(paths: ClaudeUserPaths, side: FsSide): InstalledPlugins {
  return installedPluginsOf(readRegistry(paths.installedPluginsPath, side));
}

/**
 * Read user settings.json as a plain object.
 * Returns an empty object if the file does not exist or holds JSON that is not an
 * object; throws if it is there but cannot be read or parsed.
 */
export function readUserSettings(paths: ClaudeUserPaths, side: FsSide): Record<string, unknown> {
  return objectOf(readRegistry(paths.userSettingsPath, side).parsed);
}

/**
 * The three registry files as an install or uninstall finds them — side
 * `destination`, since it writes them next — each with its prior bytes and its
 * content as objects the edit may change. Read before any tree changes, so a file
 * that is not JSON refuses the run with nothing changed.
 */
export interface RegistryFiles {
  readonly reads: { readonly known: RegistryRead; readonly installed: RegistryRead; readonly settings: RegistryRead };
  readonly known: KnownMarketplaces;
  readonly installed: InstalledPlugins;
  readonly settings: Record<string, unknown>;
}

/** Read all three registry files for an edit; see {@link RegistryFiles}. */
export function readRegistryFiles(paths: ClaudeUserPaths): RegistryFiles {
  const reads = {
    known: readRegistry(paths.knownMarketplacesPath, 'destination'),
    installed: readRegistry(paths.installedPluginsPath, 'destination'),
    settings: readRegistry(paths.userSettingsPath, 'destination'),
  };
  return { reads, known: objectOf(reads.known.parsed) as KnownMarketplaces, installed: installedPluginsOf(reads.installed), settings: objectOf(reads.settings.parsed) };
}

/** One file of an edit: its prior bytes, and `data` serialised as its new content. */
export function registryFileChange(path: string, read: RegistryRead, data: unknown): RegistryFileChange {
  return { path, prior: read.prior, next: JSON.stringify(data, null, 2) };
}

/** `settings.enabledPlugins` as an object, or `{}` when it is absent or not one. */
export function enabledPluginsOf(settings: Record<string, unknown>): Record<string, unknown> {
  return objectOf(settings['enabledPlugins']);
}

/** What VAT may replace or remove under ~/.claude: the marketplace copies and the plugin cache are its own. */
export const VAT_STATE = { kind: 'vat-state' } as const;

/**
 * The file VAT writes into the root of a marketplace directory its install made — in the
 * marketplace's own staged tree (`planPackageInstall`), so it lands exactly with the copy. Claude Code registers marketplaces of every source — npm included — so neither a
 * known_marketplaces.json entry nor its source can tell VAT's from the user's; an uninstall removes a
 * marketplace directory only when this marker is in it. It carries no version: it is there or it is not.
 */
export const VAT_MARKETPLACE_MARKER = '.vat-marketplace';

/** What {@link VAT_MARKETPLACE_MARKER} holds: fixed text, no version — it is there or it is not. */
export const MARKER_CONTENTS = 'This marketplace was installed by vibe-agent-toolkit (vat claude plugin install).\n'
  + 'vat claude plugin uninstall removes it, with this file, when the last plugin it installed here goes.\n';

/**
 * Whether VAT made the marketplace directory `dir`: its {@link VAT_MARKETPLACE_MARKER} is a regular file
 * in it. No marker — or no directory — is not VAT's. The marker is the marketplace's own, so a probe of
 * it the OS refuses proves nothing either way and is thrown: "absent" is believed only when the
 * directory's listing agrees.
 *
 * @throws a `destination` fault naming the marker when it cannot be examined
 */
export function vatMarketplaceVerdict(dir: string): OwnershipVerdict {
  const marker = safePath.join(dir, VAT_MARKETPLACE_MARKER);
  const notOurs = { owned: false, reason: `it holds no ${VAT_MARKETPLACE_MARKER} marker: VAT did not install it (or an older VAT did, before the marker), so it is left for its owner` } as const;
  const ctx = { side: 'destination', action: "examine VAT's marketplace marker", path: marker } as const;
  try {
    return lstatSync(marker).isFile() ? { owned: true } : notOurs;
  } catch (error) {
    if (!isPathAbsentError(error)) throw classifyFsFault(error, ctx);
    requireConfirmedAbsent(marker, error, ctx, { follows: false });
    return notOurs;
  }
}

/** Where a plugin's version lives in the cache: `cache/<marketplace>/<plugin>/<version>`. */
export function pluginCacheDir(paths: ClaudeUserPaths, names: Pick<InstallPluginOptions, 'marketplaceName' | 'pluginName' | 'version'>): string {
  return safePath.join(paths.pluginsCacheDir, names.marketplaceName, names.pluginName, names.version);
}

/**
 * Record one plugin's install in `files`, as Claude Code reads it: its marketplace in
 * known_marketplaces.json, the plugin (installed at its cache directory) in installed_plugins.json,
 * and enabled in settings.json. Mutates `files`; nothing is written.
 */
export function recordPluginInstall(
  files: RegistryFiles,
  paths: ClaudeUserPaths,
  install: Pick<InstallPluginOptions, 'marketplaceName' | 'pluginName' | 'version' | 'source'>,
  now: string,
): void {
  const { marketplaceName, pluginName, version, source } = install;
  const pluginKey = `${pluginName}@${marketplaceName}`;
  files.known[marketplaceName] = { source: source as MarketplaceSource, installLocation: safePath.join(paths.marketplacesDir, marketplaceName), lastUpdated: now };
  files.installed.plugins[pluginKey] = [{ scope: 'user', installPath: pluginCacheDir(paths, install), version, installedAt: now, lastUpdated: now }];
  files.settings['enabledPlugins'] = { ...enabledPluginsOf(files.settings), [pluginKey]: true };
}

/** The edit that writes all three registry files as `files` now holds them, each with its prior bytes. */
export function registrationEdit(action: string, paths: ClaudeUserPaths, files: RegistryFiles): RegistryEdit {
  return registryEdit(action, [
    registryFileChange(paths.knownMarketplacesPath, files.reads.known, files.known),
    registryFileChange(paths.installedPluginsPath, files.reads.installed, files.installed),
    registryFileChange(paths.userSettingsPath, files.reads.settings, files.settings),
  ]);
}
