/**
 * Plugin uninstall — reverses what a plugin install (`planPackageInstall`) wrote, for one key or many, as
 * ONE plan of tree removals plus a registry edit, so the tree and the registry agree
 * after any failure.
 *
 * Idempotent: a key not found is reported, never refused.
 */

import { applyTreePlanOrLeftover, entryIdentities, isVatError, type Ownership, type OwnershipVerdict, type PlannedChange, planTreeChanges, safePath, type TreeChange, type TreePlan, VatError } from '@vibe-agent-toolkit/utils';

import type { ClaudeUserPaths } from '../paths/claude-paths.js';

import {
  CLAUDE_USER_STATE_UNREADABLE_CODE,
  dropUserInstall,
  enabledPluginsOf,
  installerIdentity,
  type MarketplaceClaim,
  marketplaceVerdict,
  otherScopeInstalls,
  PLUGIN_KEY_INVALID_CODE,
  readInstalledPlugins,
  readKnownMarketplaces,
  readRegistryFiles,
  registryFileChange,
  type RegistryFiles,
  requirePluginPathSegment,
} from './plugin-registry.js';
import { type RegistryEdit, registryEdit, type RegistryFileChange } from './registry-edit.js';

/**
 * What lets an uninstall take a plugin. VAT removes only what it can prove it installed:
 * - `marker`: a key the user named — its marketplace directory must hold VAT's marker.
 * - `package`: `--all` for an npm package — the marker must name that package; a marker that names no
 *   installer, or (what every VAT before the marker left) no marker and even no directory, counts only
 *   when known_marketplaces.json records the marketplace as installed from that package.
 * - `force`: the user's explicit override — whatever the key names goes.
 */
export type UninstallAuthority =
  | { readonly kind: 'marker' }
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'force' };

export interface UninstallPluginOptions {
  /** Each "<pluginName>@<marketplace>"; all are uninstalled in one transaction. */
  pluginKeys: readonly string[];
  paths: ClaudeUserPaths;
  /** Required: no caller removes a plugin without deciding on whose word it is VAT's. */
  authority: UninstallAuthority;
  dryRun?: boolean;
}

export interface UninstallPluginResult {
  /** true if plugin was found (and removed, or would remove in dryRun) */
  removed: boolean;
  /** set if directory existed but was not in the VAT registry, or a directory was kept */
  warning?: string;
  /**
   * Set when the plugin is there but nothing shows VAT installed it: why. Nothing of it was changed —
   * no directory, no registry or settings entry — and `removed` is false.
   */
  notVats?: string;
  /**
   * The directories kept because the OS refused to examine a sibling each may be (ruling R7 d-I-1),
   * each with that sibling: the registry no longer names them, so the caller reports each by path.
   */
  keptForSibling: ReadonlyArray<{ readonly path: string; readonly sibling: string }>;
  artifacts: {
    pluginDir: boolean;
    cacheDir: boolean;
    /** The marketplace's own directory, removed with its known_marketplaces.json entry once no plugin of it is left. */
    marketplaceDir: boolean;
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
  const halves = splitPluginKey(pluginKey);
  if (halves === undefined) {
    throw new VatError(PLUGIN_KEY_INVALID_CODE, `Invalid plugin key "${pluginKey}" — expected "<plugin>@<marketplace>".`);
  }
  requirePluginPathSegment(halves.pluginName, 'plugin name', pluginKey);
  requirePluginPathSegment(halves.marketplace, 'marketplace name', pluginKey);
  return halves;
}

/** A plugin key's two halves, split at its LAST `@`; `undefined` when either is empty. Checks nothing else: {@link parsePluginKey} does. */
export function splitPluginKey(pluginKey: string): { pluginName: string; marketplace: string } | undefined {
  const atIdx = pluginKey.lastIndexOf('@');
  if (atIdx <= 0 || atIdx === pluginKey.length - 1) return undefined;
  return { pluginName: pluginKey.slice(0, atIdx), marketplace: pluginKey.slice(atIdx + 1) };
}

/** Every registered key that stays, split. Read-only: an ill-formed key only names a path to examine, never one to remove. */
function otherPlugins(files: RegistryFiles, removing: ReadonlySet<string>): Array<{ pluginName: string; marketplace: string }> {
  return Object.keys(files.installed.plugins).flatMap((key) => {
    const halves = removing.has(key) ? undefined : splitPluginKey(key);
    return halves === undefined ? [] : [halves];
  });
}



/** Where every known marketplace that stays lives: its directory under marketplaces/, and the location its entry names. */
function otherMarketplaceDirs(files: RegistryFiles, paths: ClaudeUserPaths, dropping: ReadonlySet<string>): string[] {
  return Object.entries(files.known).flatMap(([name, entry]) => {
    if (dropping.has(name)) return [];
    const location = (entry as { installLocation?: unknown }).installLocation;
    return [safePath.join(paths.marketplacesDir, name), ...(typeof location === 'string' && location !== '' ? [location] : [])];
  });
}

/** An uninstall, decided: the tree plan, the registry edit that agrees with it, and what the run reports for each key. */
export interface PluginUninstallPlan {
  readonly plan: TreePlan;
  readonly registry: RegistryEdit;
  /** One per distinct key, in the order given. */
  readonly results: readonly UninstallPluginResult[];
}

/** What an uninstall did: one result per distinct key, the plan's dry-run lines, and what it could not clean up once committed. */
export interface UninstallPluginsOutcome {
  readonly results: readonly UninstallPluginResult[];
  /** `plan.describe()`: one line per change, what the run does (or, for a dry run, would do). */
  readonly changes: readonly string[];
  /**
   * The failure after the registry was rewritten — every key IS uninstalled — naming what could not be
   * removed (a parked directory). Absent when the run finished clean. A failure before that is thrown,
   * with everything put back.
   */
  readonly leftover?: unknown;
}

/** One key being uninstalled: its two names, whether the registry has it, and whether anything of it is there at all. */
interface UninstallTarget {
  readonly pluginKey: string;
  readonly pluginName: string;
  readonly marketplace: string;
  readonly inRegistry: boolean;
  /** Registered, or its marketplace directory is there: otherwise there is nothing of it to remove, only its settings entry to clean. */
  readonly found: boolean;
  /** Found, and nothing shows VAT installed it: why. It is left exactly as it is. */
  readonly notVats: string | undefined;
  /** Claude Code also installed the key at another scope (a project's): its directories are still in use, so they stay. */
  readonly otherScopes: number;
}

/** A planned removal, and what it is the removal of. */
type Role = { readonly kind: 'plugin' | 'cache'; readonly pluginKey: string } | { readonly kind: 'marketplace'; readonly marketplace: string };

/** Where each plugin lives under `paths`. */
function dirsOf(paths: ClaudeUserPaths): { mp: (name: string, mp: string) => string; cache: (name: string, mp: string) => string } {
  return {
    mp: (name, mp) => safePath.join(paths.marketplacesDir, mp, 'plugins', name),
    cache: (name, mp) => safePath.join(paths.pluginsCacheDir, mp, name),
  };
}

/**
 * Whether the marketplace `marketplace` is VAT's to take plugins out of, on `authority`'s word — decided
 * from disk each time it is asked, so the planner's own check sees a marker removed since.
 *
 * A marketplace directory that is gone carries no marker: only `package` authority, with the registry
 * recording that very package, can still vouch for what is left of it (a cache, the entries).
 */
function marketplaceProvenance(marketplace: string, authority: UninstallAuthority, files: RegistryFiles, paths: ClaudeUserPaths): OwnershipVerdict {
  if (authority.kind === 'force') return { owned: true };
  const dir = safePath.join(paths.marketplacesDir, marketplace);
  const known = Object.hasOwn(files.known, marketplace) ? files.known[marketplace] : undefined;
  const claim: MarketplaceClaim = authority.kind === 'package' ? { kind: 'installer', installedFrom: `npm:${authority.name}` } : { kind: 'marker' };
  if (entryIdentities(dir, 'destination').length > 0) return marketplaceVerdict(dir, claim, known);
  if (claim.kind === 'installer' && known !== undefined && installerIdentity(known.source) === claim.installedFrom) return { owned: true };
  return { owned: false, reason: `its marketplace directory ${dir} is not there, so no marker shows VAT installed it` };
}

function targetOf(pluginKey: string, files: RegistryFiles, paths: ClaudeUserPaths, authority: UninstallAuthority): UninstallTarget {
  const { pluginName, marketplace } = parsePluginKey(pluginKey);
  const inRegistry = Object.hasOwn(files.installed.plugins, pluginKey);
  const found = inRegistry || entryIdentities(dirsOf(paths).mp(pluginName, marketplace), 'destination').length > 0;
  const verdict = found ? marketplaceProvenance(marketplace, authority, files, paths) : { owned: true as const };
  return { pluginKey, pluginName, marketplace, inRegistry, found, notVats: verdict.owned ? undefined : verdict.reason, otherScopes: otherScopeInstalls(files, pluginKey).length };
}

/** What the removals of one uninstall are decided from. */
interface UninstallContext {
  readonly files: RegistryFiles;
  readonly paths: ClaudeUserPaths;
  readonly authority: UninstallAuthority;
}

/** Whether `target` is taken out of the registry: found, and VAT's. */
const unregisters = (target: UninstallTarget): boolean => target.found && target.notVats === undefined;

/** Whether `target`'s directories go too: unregistered, and no other scope of the key still uses them. */
const removesTrees = (target: UninstallTarget): boolean => unregisters(target) && target.otherScopes === 0;

/**
 * The removals an uninstall asks for (see {@link planPluginUninstall}), each with its role. Every one is
 * owned on the marketplace's provenance, read again from disk when the planner decides: a marker gone
 * since the targets were judged refuses the uninstall (`TREE_DEST_NOT_OWNED`) rather than delete from
 * an unmarked marketplace.
 */
function uninstallChanges(targets: readonly UninstallTarget[], context: UninstallContext): Array<{ change: TreeChange; role: Role }> {
  const { files, paths, authority } = context;
  const dirs = dirsOf(paths);
  const going = targets.filter((target) => removesTrees(target));
  // Every key whose directories stay — registered and not going — is one a removal must not take with it.
  const removing = new Set(going.map((target) => target.pluginKey));
  const remaining = otherPlugins(files, removing);
  const ownershipOf = (marketplace: string): Ownership =>
    (authority.kind === 'force' ? { kind: 'force' } : { kind: 'vat-made', recognise: () => marketplaceProvenance(marketplace, authority, files, paths) });
  const removal = (dest: string, label: string, marketplace: string, keepIfSameAs: () => readonly string[]): TreeChange =>
    ({ op: 'remove', dest, ownership: ownershipOf(marketplace), keepIfSameAs, label });
  const plugins = going.flatMap(({ pluginKey, pluginName, marketplace }) => [
    { change: removal(dirs.mp(pluginName, marketplace), `marketplace copy of ${pluginKey}`, marketplace, () => remaining.map((o) => dirs.mp(o.pluginName, o.marketplace))), role: { kind: 'plugin', pluginKey } as const },
    { change: removal(dirs.cache(pluginName, marketplace), `cache of ${pluginKey}`, marketplace, () => remaining.map((o) => dirs.cache(o.pluginName, o.marketplace))), role: { kind: 'cache', pluginKey } as const },
  ]);
  const emptied = [...new Set(going.map((target) => target.marketplace))]
    .filter((marketplace) => !remaining.some((other) => other.marketplace === marketplace) && Object.hasOwn(files.known, marketplace));
  const marketplaces = emptied.map((marketplace) => ({
    change: removal(safePath.join(paths.marketplacesDir, marketplace), `marketplace ${marketplace}`, marketplace, () => otherMarketplaceDirs(files, paths, new Set(emptied))),
    role: { kind: 'marketplace', marketplace } as const,
  }));
  return [...plugins, ...marketplaces];
}

/** Whether a planned removal takes its directory away: removed itself, or with a directory above it. */
const goes = (planned: PlannedChange | undefined): boolean => planned?.action === 'remove' || planned?.action === 'subsumed';

/** Whether a marketplace's directory is gone once the plan is applied: taken away, or never there. Its known entry goes exactly then. */
const marketplaceGone = (planned: PlannedChange): boolean => goes(planned) || planned.existing === 'absent';

/** The registry edit of an uninstall: only the files it changes, each with its prior bytes. */
function uninstallEdit(paths: ClaudeUserPaths, files: RegistryFiles, dropped: { keys: readonly string[]; marketplaces: readonly string[]; enabled: readonly string[] }): RegistryFileChange[] {
  const edit: RegistryFileChange[] = [];
  if (dropped.keys.length > 0) {
    // Only the user-scope record is VAT's: another scope's (a project install Claude Code made) stays.
    for (const key of dropped.keys) dropUserInstall(files, key);
    edit.push(registryFileChange(paths.installedPluginsPath, files.reads.installed, files.installed));
  }
  if (dropped.marketplaces.length > 0) {
    for (const marketplace of dropped.marketplaces) delete files.known[marketplace];
    edit.push(registryFileChange(paths.knownMarketplacesPath, files.reads.known, files.known));
  }
  if (dropped.enabled.length > 0) {
    const enabled = enabledPluginsOf(files.settings);
    for (const key of dropped.enabled) delete enabled[key];
    files.settings['enabledPlugins'] = enabled;
    edit.push(registryFileChange(paths.userSettingsPath, files.reads.settings, files.settings));
  }
  return edit;
}

/** What is said of a key whose registry entry went (or would) while something of it stayed, or that no registry recorded. */
function warningOf(target: UninstallTarget, kept: readonly string[], dryRun: boolean): string | undefined {
  const { pluginKey, inRegistry, otherScopes } = target;
  if (otherScopes > 0) {
    return `Plugin "${pluginKey}" ${dryRun ? 'would be' : 'was'} removed from the user scope only: Claude Code also has it installed at ${otherScopes} other scope(s), which still use its directories, so they ${dryRun ? 'would be' : 'were'} kept`;
  }
  if (kept.length > 0) {
    const keptList = kept.join('; ');
    return dryRun
      ? `Plugin "${pluginKey}" would be removed from the registry, but these would be kept: ${keptList}`
      : `Plugin "${pluginKey}" was removed from the registry, but these were kept: ${keptList}`;
  }
  if (inRegistry) return undefined;
  return `Plugin "${pluginKey}" directory exists in a marketplace VAT installed, but no registry recorded it — ${dryRun ? 'it would be removed' : 'cleaning up'}`;
}

/** The kept directories among `planned`, each with the planner's reason. */
function keptOf(planned: ReadonlyArray<PlannedChange | undefined>): string[] {
  return planned.flatMap((each) => (each?.action === 'keep' && each.existing !== 'absent' ? [`${each.change.dest} (${each.reason ?? 'kept'})`] : []));
}

/** What the decided plan says about one key. */
type Decided = (role: Role) => PlannedChange | undefined;

const NOTHING_REMOVED = { pluginDir: false, cacheDir: false, marketplaceDir: false, installedPlugins: false, knownMarketplaces: false, settings: false } as const;

/** What the run reports for one key, read off the decided plan. */
function resultOf(target: UninstallTarget, decided: Decided, enabled: boolean, dryRun: boolean): UninstallPluginResult {
  const { pluginKey, marketplace, inRegistry, found, notVats } = target;
  if (notVats !== undefined) {
    return {
      removed: false,
      notVats: `Plugin "${pluginKey}" was not uninstalled, and nothing of it was changed: ${notVats}. Remove it in Claude Code (/plugin), or pass --force to remove it anyway.`,
      keptForSibling: [],
      artifacts: NOTHING_REMOVED,
    };
  }
  const own = [decided({ kind: 'plugin', pluginKey }), decided({ kind: 'cache', pluginKey })];
  const marketplaceChange = decided({ kind: 'marketplace', marketplace });
  const marketplaceDropped = marketplaceChange !== undefined && marketplaceGone(marketplaceChange);
  const artifacts = { pluginDir: goes(own[0]), cacheDir: goes(own[1]), marketplaceDir: goes(marketplaceChange), installedPlugins: inRegistry, knownMarketplaces: marketplaceDropped, settings: enabled };
  const warning = found ? warningOf(target, keptOf([...own, marketplaceChange]), dryRun) : undefined;
  const keptForSibling = [...own, marketplaceChange].flatMap((each) =>
    (each?.action === 'keep' && each.unexaminedSibling !== undefined ? [{ path: each.change.dest, sibling: each.unexaminedSibling }] : []));
  return { removed: found, ...(warning === undefined ? {} : { warning }), keptForSibling, artifacts };
}

const sameRole = (a: Role, b: Role): boolean =>
  a.kind === b.kind && (a.kind === 'marketplace' ? a.marketplace === (b as typeof a).marketplace : a.pluginKey === (b as typeof a).pluginKey);

/**
 * Plan uninstalling plugins — one transaction for every key — with no side effect.
 * Every key is checked first, then the registry files are read (a file that is not
 * JSON refuses the run, nothing changed), then the trees.
 *
 * A key is uninstalled only when VAT can prove it installed it, on `authority`'s word
 * ({@link UninstallAuthority}): its marketplace directory holds VAT's `.vat-marketplace` marker
 * (naming the package, under `package` authority). A plugin that is there in a marketplace with
 * no such proof — Claude Code's, of any source; one a VAT older than the marker installed, when
 * named by key; one whose marketplace directory is gone — is left EXACTLY as it is: no directory,
 * no registry record and no settings entry of it changes, and its result says why (`notVats`).
 *
 * For a key that is VAT's, the changes remove its marketplace directory and its cache directory —
 * each KEPT where a plugin that stays registered has a directory that is, or could
 * not be ruled out to be, the same entry on disk (a case-folding filesystem makes
 * `plugins/Old` and `plugins/old` one directory; a link does the same), and both kept where
 * Claude Code also installed the key at another scope (only the user-scope record is VAT's). A
 * marketplace none of whose plugins stays installed has its directory removed too, and its entry
 * is dropped exactly when that directory is removed: the uninstall never leaves the registry naming
 * a marketplace it removed, nor drops one still there (one holding a kept directory is
 * kept). A plugin neither registered nor in its marketplace has nothing to remove: only its
 * settings entry is cleaned.
 *
 * @throws VatError {@link PLUGIN_KEY_INVALID_CODE} or {@link CLAUDE_USER_STATE_UNREADABLE_CODE};
 *   a `destination` fault for a registry file or a directory of a plugin the OS will not examine
 */
export async function planPluginUninstall(opts: UninstallPluginOptions): Promise<PluginUninstallPlan> {
  const { paths, dryRun = false } = opts;
  const keys = [...new Set(opts.pluginKeys)];
  for (const key of keys) parsePluginKey(key);
  const files = readRegistryFiles(paths);
  const targets = keys.map((key) => targetOf(key, files, paths, opts.authority));
  const asked = uninstallChanges(targets, { files, paths, authority: opts.authority });
  const plan = await planTreeChanges(asked.map(({ change }) => change));
  const decided: Decided = (role) => plan.changes[asked.findIndex((each) => sameRole(each.role, role))];

  const enabled = new Set(Object.keys(enabledPluginsOf(files.settings)));
  const results = targets.map((target) => resultOf(target, decided, enabled.has(target.pluginKey), dryRun));
  const marketplaces = asked.flatMap(({ role }, index) => (role.kind === 'marketplace' && marketplaceGone(plan.changes[index] as PlannedChange) ? [role.marketplace] : []));
  // A key that is not VAT's keeps every entry it has; one that was never found has only a stale settings entry to clean.
  const touched = targets.filter((target) => target.notVats === undefined);
  const edit = uninstallEdit(paths, files, {
    keys: touched.filter((target) => target.inRegistry).map((target) => target.pluginKey),
    marketplaces,
    enabled: touched.filter((target) => enabled.has(target.pluginKey)).map((target) => target.pluginKey),
  });
  return { plan, registry: registryEdit(`uninstall plugin ${keys.join(', ')}`, edit), results };
}

/**
 * Uninstall plugins installed via the file-based method: {@link planPluginUninstall},
 * then every removal and the registry edit as ONE transaction — each directory is
 * moved aside, the registry written, and only then is what was moved aside deleted.
 * A failure before the registry is written puts every directory and every registry
 * file back, for every key, and is thrown. A failure after it (a moved-aside
 * directory the OS will not delete) cannot be undone and is not a refusal of the
 * uninstall: every key IS uninstalled, and the failure is returned as `leftover`,
 * naming what is left. Idempotent — a key not found is reported `removed: false`. A
 * dry run plans and stops.
 *
 * @returns One result per distinct key in the order given, the plan's lines, and any leftover
 */
export async function uninstallPlugins(opts: UninstallPluginOptions): Promise<UninstallPluginsOutcome> {
  const { plan, registry, results } = await planPluginUninstall(opts);
  const changes = plan.describe();
  if (opts.dryRun === true) return { results, changes };
  const { leftover } = await applyTreePlanOrLeftover(plan, { afterSwap: () => registry.apply() });
  return leftover === undefined ? { results, changes } : { results, changes, leftover };
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
  const knownMarketplaces = readKnownMarketplaces(paths, 'destination');
  const installedPlugins = readInstalledPlugins(paths, 'destination');

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
