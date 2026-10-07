/**
 * Plugin registry — read/write Claude's plugin registry files and install plugins.
 *
 * Manages:
 * - known_marketplaces.json: Registry of known marketplace sources
 * - installed_plugins.json: Registry of installed plugins
 *
 * Follows Postel's Law: reads with fallbacks (liberal), writes with structured data.
 */

import { chmodSync, closeSync, cpSync, type Dirent, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { isPathAbsentError, isSingleFsSegment, isUnderRoot, isVatError, mkdirSyncReal, normalizePath, safePath, toForwardSlash, VatError } from '@vibe-agent-toolkit/utils';

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
 * The code for a plugin key — or a plugin name, marketplace name or version
 * given to `installPlugin` — that cannot name one entry under ~/.claude.
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
 * Refuse names and a version {@link installPlugin} cannot install under: each
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

/** The refusal for a plugin source path the OS will not list or read. */
function pluginSourceUnreadable(path: string, error: unknown): VatError {
  return new VatError(PLUGIN_SOURCE_UNREADABLE_CODE, `Could not read the plugin to install at ${path}: ${String(error)}`, { cause: error });
}

/**
 * Refuse a plugin source any part of which cannot be read, before anything is
 * written for it. The whole tree, not its top level: a file the copy cannot
 * read deeper down otherwise fails inside ~/.claude and reads as Claude's
 * state, naming the destination. Each file is opened, not `access`ed — on
 * Windows `access` does not consult ACLs. Links are copied as links, so they
 * are not followed here.
 *
 * @throws VatError {@link PLUGIN_SOURCE_UNREADABLE_CODE} naming the path that failed
 */
export function requirePluginSource(pluginDir: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(pluginDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    throw pluginSourceUnreadable((error as NodeJS.ErrnoException).path ?? pluginDir, error);
  }
  for (const entry of entries) {
    // A link is copied as a link, never read through: what it points at is not the copy's to read.
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const file = safePath.join(entry.parentPath, entry.name);
    try {
      closeSync(openSync(file, 'r'));
    } catch (error) {
      throw pluginSourceUnreadable(file, error);
    }
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

/** Whether anything — a dangling link included — sits at `path`. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isPathAbsentError(error)) return false;
    throw error;
  }
}

/** What {@link replaceDirectory} puts in the name of its staged copy and of the tree it parks. */
const STAGED_INFIX = '.vat-staged-';

/**
 * Whether a directory entry is {@link replaceDirectory}'s staged copy or parked
 * previous tree (`.<dest>.vat-staged-XXXXXX[.previous]`) — left beside `dest` by
 * a crash or by a removal the OS refused, and never one of the entries it sits among.
 */
export function isStagedReplaceLeftover(name: string): boolean {
  return name.startsWith('.') && name.includes(STAGED_INFIX);
}

/**
 * Make `dest` a copy of `source`, replacing whatever tree is there.
 *
 * Replaced, never copied into: a re-install's links would copy onto their own
 * targets. And never deleted first: the registry already points at `dest`, so a
 * copy that fails must leave the previous tree in place. The copy goes to a
 * sibling directory and is swapped in only once it is whole; a failure removes
 * the sibling and, if the swap itself failed, puts the previous tree back.
 *
 * The sibling is DOT-named: `vat inventory` reads every other directory beside
 * the versions as one, so a sibling a crash leaves behind must not look like a
 * version. It takes the source's mode — `mkdtemp` makes it 0700 — with the
 * owner's rwx added, as every directory of the copy gets: a read-only source
 * would otherwise install a tree no uninstall (VAT's, Claude Code's, `rm -rf`) can empty.
 *
 * @returns Warnings: the previous tree, when it could not be removed once replaced
 */
export function replaceDirectory(source: string, dest: string): string[] {
  const staged = stageBeside(dest);
  try {
    cpSync(source, staged, { recursive: true });
    // AFTER the copy: a read-only source mode applied first leaves the copy no
    // directory it may write into (Node's native copy then aborts the process).
    chmodSync(staged, ownerWritable(statSync(source).mode));
    for (const entry of readdirSync(staged, { recursive: true, withFileTypes: true })) {
      // A link is skipped before the type test: chmod follows it, and what it leads to is not the copy's.
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const dir = safePath.join(entry.parentPath, entry.name);
      chmodSync(dir, ownerWritable(lstatSync(dir).mode));
    }
    return swapIn(staged, dest);
  } finally {
    // Gone already once swapped in; otherwise the half-copied sibling must not stay.
    removeTree(staged);
  }
}

/** `mode`'s permission bits with the owner's read, write and search added. */
function ownerWritable(mode: number): number {
  return (mode & 0o7777) | 0o700;
}

/**
 * {@link replaceDirectory} for a copy the caller makes: `fill` writes the new
 * tree into an empty, dot-named sibling of `dest` (mode 0700 until `fill` sets
 * one), which is swapped in only once `fill` resolves. A `fill` that rejects
 * leaves `dest` exactly as it was and the sibling removed.
 *
 * @returns Warnings: the previous tree, when it could not be removed once replaced
 */
export async function replaceDirectoryWith(dest: string, fill: (staged: string) => Promise<void>): Promise<string[]> {
  const staged = stageBeside(dest);
  try {
    await fill(staged);
    return swapIn(staged, dest);
  } finally {
    removeTree(staged);
  }
}

/** An empty, dot-named sibling of `dest` for {@link swapIn} — its parent made first. */
function stageBeside(dest: string): string {
  const parent = dirname(dest);
  mkdirSyncReal(parent, { recursive: true });
  return mkdtempSync(safePath.join(parent, `.${basename(dest)}${STAGED_INFIX}`));
}

/**
 * Remove a tree VAT made under ~/.claude, its root's own mode notwithstanding:
 * a root that took a read-only source's mode refuses the removal of its entries.
 */
function removeTree(path: string): void {
  if (!entryExists(path)) return;
  if (!lstatSync(path).isSymbolicLink()) chmodSync(path, 0o700);
  rmSync(path, { recursive: true, force: true });
}

/**
 * Move the whole tree `staged` to `dest`; the tree `dest` held is removed only
 * after `staged` is in its place. That removal is best-effort: the new tree is
 * live by then, so a removal the OS refuses must not fail the install.
 *
 * @returns Warnings: the previous tree, when it could not be removed
 */
function swapIn(staged: string, dest: string): string[] {
  // `lstat`, not `existsSync`: a dangling link at `dest` is moved aside like a tree.
  if (!entryExists(dest)) {
    renameSync(staged, dest);
    return [];
  }
  const previous = `${staged}.previous`;
  renameSync(dest, previous);
  try {
    renameSync(staged, dest);
  } catch (error) {
    renameSync(previous, dest);
    throw error;
  }
  try {
    removeTree(previous);
    return [];
  } catch (error) {
    return [`The previous ${basename(dest)} tree could not be removed and is left at ${previous}: ${String(error)}`];
  }
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
 * The names and version are checked first: each becomes one directory under
 * ~/.claude, so one that is not a single path segment is refused
 * ({@link PLUGIN_KEY_INVALID_CODE}). Then the source is read: one that is not
 * there is refused ({@link PLUGIN_SOURCE_UNREADABLE_CODE}) with nothing created. Then 5 steps in
 * order; a failure throws, coded (see the two user-state codes above).
 * 1. Replace the plugin's tree in marketplacesDir
 * 2. Update known_marketplaces.json
 * 3. Replace the plugin's tree in pluginsCacheDir
 * 4. Update installed_plugins.json
 * 5. Enable plugin in user settings.json
 *
 * @returns `warnings`: cleanup that did not happen — the install itself is complete
 */
export function installPlugin(opts: InstallPluginOptions): Promise<{ warnings: string[] }> {
  const { marketplaceName, pluginName, pluginDir, version, source, paths } = opts;

  const pluginKey = `${pluginName}@${marketplaceName}`;
  // Both refusals throw synchronously; a caller still receives them as a rejection.
  try {
    requirePluginInstallNames(opts);
    requirePluginSource(pluginDir);
  } catch (error) {
    return Promise.reject(error as Error);
  }
  return codedUserStateWrite(`register plugin ${pluginKey}`, () => {
    const now = new Date().toISOString();
    // The directory itself, not a link to it: a copied link would collide with the directory it lands on.
    const realPluginDir = normalizePath(safePath.resolve(pluginDir));

    // Step 1: Replace marketplacesDir/<marketplaceName>/plugins/<pluginName>/ with the plugin.
    // Replaced, not copied into, so a file the plugin dropped does not survive a re-install.
    // Skip if pluginDir is already at the destination (e.g. copyPluginTree already did the copy)
    const marketplacePluginDest = safePath.join(paths.marketplacesDir, marketplaceName, 'plugins', pluginName);
    const marketplaceWarnings = resolvesInto(pluginDir, marketplacePluginDest) ? [] : replaceDirectory(realPluginDir, marketplacePluginDest);

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
    const cacheWarnings = resolvesInto(pluginDir, cacheDest) ? [] : replaceDirectory(realPluginDir, cacheDest);

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
    return { warnings: [...marketplaceWarnings, ...cacheWarnings] };
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
