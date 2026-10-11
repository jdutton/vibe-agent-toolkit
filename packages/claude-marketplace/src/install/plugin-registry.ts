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

import { lstatSync, readdirSync, readFileSync } from 'node:fs';

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
  withFsFaultSync,
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
 * A Claude Code registry or settings file whose CONTENT VAT cannot use: not JSON, the wrong
 * shape (not an object, no `plugins` object, an entry with no `source`), or an entry that is not a plugin key. A file the OS refuses is not this:
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

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A registry file whose JSON is not the shape Claude Code writes: refused, naming the file and what is wrong. */
function wrongShape(filePath: string, what: string): VatError {
  return new VatError(CLAUDE_USER_STATE_UNREADABLE_CODE, `${filePath} is not a file VAT can use: ${what}. Repair or remove the file, then re-run.`);
}

/**
 * `read` as a JSON object — `{}` only when there is NO file. A file holding anything else (an array, a
 * string) is refused: every reader here is followed by a write of the same file, and reading it as
 * empty would replace it.
 */
function objectIn(filePath: string, read: RegistryRead): Record<string, unknown> {
  if (read.prior === undefined) return {};
  if (!isPlainObject(read.parsed)) throw wrongShape(filePath, 'it does not hold a JSON object');
  return read.parsed;
}

/** installed_plugins.json as read: `plugins` an object whose every value is a list of install records. */
function installedPluginsIn(filePath: string, read: RegistryRead): InstalledPlugins {
  if (read.prior === undefined) return { version: 2, plugins: {} };
  const parsed = objectIn(filePath, read);
  const { plugins } = parsed;
  if (!isPlainObject(plugins)) throw wrongShape(filePath, 'it has no "plugins" object');
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries) || !entries.every((entry) => isPlainObject(entry))) throw wrongShape(filePath, `"plugins"["${key}"] is not a list of install records`);
  }
  return parsed as unknown as InstalledPlugins;
}

/** known_marketplaces.json as read: every entry an object whose `source` is an object naming its kind. */
function knownMarketplacesIn(filePath: string, read: RegistryRead): KnownMarketplaces {
  const parsed = objectIn(filePath, read);
  for (const [name, entry] of Object.entries(parsed)) {
    const source = isPlainObject(entry) ? entry['source'] : undefined;
    if (!isPlainObject(source) || typeof source['source'] !== 'string') throw wrongShape(filePath, `its entry "${name}" has no "source" naming where the marketplace came from`);
  }
  return parsed as KnownMarketplaces;
}

/** settings.json as read: an object whose `enabledPlugins`, when there, is an object. */
function userSettingsIn(filePath: string, read: RegistryRead): Record<string, unknown> {
  const parsed = objectIn(filePath, read);
  const enabled = parsed['enabledPlugins'];
  if (enabled !== undefined && !isPlainObject(enabled)) throw wrongShape(filePath, 'its "enabledPlugins" is not an object');
  return parsed;
}

/**
 * Read known_marketplaces.json from the Claude plugins directory.
 * Returns an empty object if the file does not exist; throws if it is there but unreadable or the wrong shape.
 */
export function readKnownMarketplaces(paths: ClaudeUserPaths, side: FsSide): KnownMarketplaces {
  return knownMarketplacesIn(paths.knownMarketplacesPath, readRegistry(paths.knownMarketplacesPath, side));
}

/**
 * Read installed_plugins.json from the Claude plugins directory.
 * Returns empty registry if the file does not exist; throws if it is there but unreadable or the wrong shape.
 */
export function readInstalledPlugins(paths: ClaudeUserPaths, side: FsSide): InstalledPlugins {
  return installedPluginsIn(paths.installedPluginsPath, readRegistry(paths.installedPluginsPath, side));
}

/**
 * Read user settings.json as a plain object.
 * Returns an empty object if the file does not exist; throws if it is there but cannot be read or
 * parsed, or holds JSON that is not an object.
 */
export function readUserSettings(paths: ClaudeUserPaths, side: FsSide): Record<string, unknown> {
  return userSettingsIn(paths.userSettingsPath, readRegistry(paths.userSettingsPath, side));
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
  return {
    reads,
    known: knownMarketplacesIn(paths.knownMarketplacesPath, reads.known),
    installed: installedPluginsIn(paths.installedPluginsPath, reads.installed),
    settings: userSettingsIn(paths.userSettingsPath, reads.settings),
  };
}

/** One file of an edit: its prior bytes, and `data` serialised as its new content. */
export function registryFileChange(path: string, read: RegistryRead, data: unknown): RegistryFileChange {
  return { path, prior: read.prior, next: JSON.stringify(data, null, 2) };
}

/** `settings.enabledPlugins` as an object, or `{}` when it is absent (a `settings` read here never holds another shape). */
export function enabledPluginsOf(settings: Record<string, unknown>): Record<string, unknown> {
  const enabled = settings['enabledPlugins'];
  return isPlainObject(enabled) ? enabled : {};
}

/** What VAT may replace or remove under ~/.claude once a marketplace is proven its own: that marketplace's plugin cache. */
export const VAT_STATE = { kind: 'vat-state' } as const;

/**
 * The file VAT writes into the root of a marketplace directory its install made — in the
 * marketplace's own staged tree (`planPackageInstall`), so it lands exactly with the copy. It is the
 * ONLY witness that VAT made the directory: Claude Code registers marketplaces of every source — npm
 * included — so neither a known_marketplaces.json entry nor a directory's name can tell VAT's from the
 * user's. An install replaces, and an uninstall removes, a marketplace only on its word (or `--force`).
 * It records what the marketplace was installed from, and no version.
 */
export const VAT_MARKETPLACE_MARKER = '.vat-marketplace';

/** The line of the marker that records the installer, as JSON after this prefix. */
const MARKER_INSTALLER_PREFIX = 'installed-from: ';

/**
 * What {@link VAT_MARKETPLACE_MARKER} holds for a marketplace installed from `installedFrom`
 * ({@link installerIdentity}): two sentences for whoever opens it, and the installer on a line of its own.
 */
export function markerContents(installedFrom: string): string {
  return 'This marketplace was installed by vibe-agent-toolkit (vat claude plugin install).\n'
    + 'vat claude plugin uninstall removes it, with this file, when the last plugin it installed here goes.\n'
    + `${MARKER_INSTALLER_PREFIX}${JSON.stringify(installedFrom)}\n`;
}

/** Which field of a marketplace source names what it came from, per source kind. */
const INSTALLER_FIELD: Readonly<Record<string, string>> = { npm: 'package', github: 'repo', url: 'url' };

/**
 * What names the installer of a marketplace — `npm:<package>`, `github:<repo>`, `url:<url>` — as its
 * source records it; `undefined` for a source that names none VAT can compare.
 */
export function installerIdentity(source: { readonly source: string; readonly [key: string]: unknown }): string | undefined {
  const field = Object.hasOwn(INSTALLER_FIELD, source.source) ? INSTALLER_FIELD[source.source] : undefined;
  const value = field === undefined ? undefined : source[field];
  return typeof value === 'string' && value !== '' ? `${source.source}:${value}` : undefined;
}

/** VAT's marker in a marketplace directory: absent, or present with the installer it records (`undefined`: a marker written before it recorded one). */
type MarkerRead = { readonly present: false } | { readonly present: true; readonly installedFrom: string | undefined };

/** The installer a marker's text records: the JSON string after the prefix, on a line of its own. */
const MARKER_INSTALLER_LINE = /^installed-from: ("(?:[^"\\]|\\.)*")$/m;

/** The installer `text` records, or `undefined` for a marker that records none (written before it did, or edited). */
function installerRecordedIn(text: string): string | undefined {
  const quoted = MARKER_INSTALLER_LINE.exec(text)?.[1];
  // The pattern admits only a JSON string literal, so the parse cannot fail on what it matched.
  const value: unknown = quoted === undefined ? undefined : JSON.parse(quoted);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Read VAT's marker in `dir`. The marker is the marketplace's own, so a probe or a read of it the OS
 * refuses proves nothing either way and is thrown: "absent" is believed only when the directory's
 * listing agrees.
 *
 * @throws a `destination` fault naming the marker when it cannot be examined or read
 */
function readMarker(dir: string): MarkerRead {
  const marker = safePath.join(dir, VAT_MARKETPLACE_MARKER);
  const ctx = { side: 'destination', action: "examine VAT's marketplace marker", path: marker } as const;
  try {
    if (!lstatSync(marker).isFile()) return { present: false };
  } catch (error) {
    if (!isPathAbsentError(error)) throw classifyFsFault(error, ctx);
    requireConfirmedAbsent(marker, error, ctx, { follows: false });
    return { present: false };
  }
  return { present: true, installedFrom: installerRecordedIn(withFsFaultSync(ctx, () => readFileSync(marker, 'utf-8'))) };
}

/**
 * Whose word a marketplace is taken on.
 * - `marker`: VAT's marker alone (a key the user named: nothing says which package it should be from).
 * - `installer`: VAT's marker recording this installer; or — for a marker that records none, and for a
 *   directory with no marker at all, which is what every VAT before the marker left — a
 *   known_marketplaces.json entry whose source is this very installer. Never the directory's name.
 */
export type MarketplaceClaim = { readonly kind: 'marker' } | { readonly kind: 'installer'; readonly installedFrom: string };

const NO_MARKER = `it holds no ${VAT_MARKETPLACE_MARKER} marker`;

/** What known_marketplaces.json says a marketplace came from, for a refusal's wording. */
function registryRecord(known: KnownMarketplaceEntry | undefined): string {
  if (known === undefined) return 'known_marketplaces.json does not list it';
  const recorded = installerIdentity(known.source) ?? `a ${known.source.source} marketplace`;
  return `known_marketplaces.json records it as ${recorded}`;
}

/**
 * Whether the marketplace directory `dir` — which is there — is VAT's to replace or remove under `claim`.
 *
 * @param dir - The marketplace directory
 * @param claim - Whose word it is taken on
 * @param known - Its known_marketplaces.json entry, as the registry was read
 * @throws a `destination` fault naming the marker when it cannot be examined
 */
export function marketplaceVerdict(dir: string, claim: MarketplaceClaim, known: KnownMarketplaceEntry | undefined): OwnershipVerdict {
  const marker = readMarker(dir);
  if (claim.kind === 'marker') {
    return marker.present ? { owned: true } : { owned: false, reason: `${NO_MARKER}: VAT did not install it (or a VAT older than the marker did), so it is left for its owner` };
  }
  const recorded = marker.present ? marker.installedFrom : undefined;
  if (recorded !== undefined) {
    return recorded === claim.installedFrom ? { owned: true } : { owned: false, reason: `VAT installed it from ${recorded}, not from ${claim.installedFrom}` };
  }
  if (known !== undefined && installerIdentity(known.source) === claim.installedFrom) return { owned: true };
  return { owned: false, reason: `${marker.present ? 'its marker names no installer' : NO_MARKER} and ${registryRecord(known)}, so nothing shows VAT installed it from ${claim.installedFrom}` };
}

/** Whether `dir` is a directory holding nothing: nothing of anyone's is lost by installing over it. */
export function isEmptyDirectory(dir: string): boolean {
  return withFsFaultSync({ side: 'destination', action: 'list the marketplace directory', path: dir }, () => lstatSync(dir).isDirectory() && readdirSync(dir).length === 0);
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
  // One record per scope: only the user-scope one is this install's to replace.
  files.installed.plugins[pluginKey] = [{ scope: 'user', installPath: pluginCacheDir(paths, install), version, installedAt: now, lastUpdated: now }, ...otherScopeInstalls(files, pluginKey)];
  files.settings['enabledPlugins'] = { ...enabledPluginsOf(files.settings), [pluginKey]: true };
}

/** The install records of `pluginKey` that are not the user-scope one VAT writes (a project-scope install Claude Code made). */
export function otherScopeInstalls(files: RegistryFiles, pluginKey: string): InstalledPluginEntry[] {
  return (files.installed.plugins[pluginKey] ?? []).filter((entry) => entry.scope !== 'user');
}

/**
 * Drop the user-scope install record of `pluginKey` — VAT's — keeping any other scope's; the key goes
 * when none is left. Mutates `files`.
 */
export function dropUserInstall(files: RegistryFiles, pluginKey: string): void {
  const others = otherScopeInstalls(files, pluginKey);
  if (others.length === 0) delete files.installed.plugins[pluginKey];
  else files.installed.plugins[pluginKey] = others;
}

/** The edit that writes all three registry files as `files` now holds them, each with its prior bytes. */
export function registrationEdit(action: string, paths: ClaudeUserPaths, files: RegistryFiles): RegistryEdit {
  return registryEdit(action, [
    registryFileChange(paths.knownMarketplacesPath, files.reads.known, files.known),
    registryFileChange(paths.installedPluginsPath, files.reads.installed, files.installed),
    registryFileChange(paths.userSettingsPath, files.reads.settings, files.settings),
  ]);
}
