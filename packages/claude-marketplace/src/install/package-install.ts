/**
 * A VAT package's install into Claude Code's user plugin registry as ONE plan: every
 * marketplace the package ships, every plugin's cache, every plugin its `vat.replaces`
 * names, and one registry edit that agrees with all of them. Applied as one transaction
 * (`applyTreePlan` with the edit as its `afterSwap`), an install either lands whole —
 * the new plugins registered, the replaced ones gone — or changes nothing.
 */

import fs from 'node:fs/promises';

import { safePath, type TreeChange, type TreeFill } from '@vibe-agent-toolkit/utils';

import type { ClaudeUserPaths } from '../paths/claude-paths.js';

import {
  enabledPluginsOf,
  type InstallPluginSource,
  MARKER_CONTENTS,
  pluginCacheDir,
  readRegistryFiles,
  recordPluginInstall,
  registrationEdit,
  type RegistryFiles,
  requirePluginInstallNames,
  VAT_MARKETPLACE_MARKER,
  VAT_STATE,
} from './plugin-registry.js';
import { parsePluginKey, splitPluginKey } from './plugin-uninstall.js';
import { type RegistryEdit, registryEdit } from './registry-edit.js';

/** One plugin of a marketplace the package ships. */
export interface PackagePluginInstall {
  readonly pluginName: string;
  /** How its cache directory (`cache/<marketplace>/<plugin>/<version>`) is made. */
  readonly cacheFill: TreeFill;
}

/** One marketplace the package ships, installed whole at `marketplaces/<marketplaceName>/`. */
export interface PackageMarketplaceInstall {
  readonly marketplaceName: string;
  /** Fills the staged marketplace directory with everything but VAT's marker, which the plan writes beside it. */
  readonly write: (staged: string) => Promise<void>;
  /** What `write` reads: held to the planner's holding check, as a copy source is. */
  readonly reads: readonly string[];
  readonly plugins: readonly PackagePluginInstall[];
}

export interface PackageInstallOptions {
  readonly marketplaces: readonly PackageMarketplaceInstall[];
  /** The package version: every plugin's cache version. */
  readonly version: string;
  readonly source: InstallPluginSource;
  /** `<plugin>@<marketplace>` keys the package's `vat.replaces` uninstalls, in the same transaction. */
  readonly replacedPluginKeys: readonly string[];
  readonly paths: ClaudeUserPaths;
}

/** The plan of a package install: its tree changes, the registry edit that agrees with them, and where each replaced key's removal sits. */
export interface PackageInstallPlan {
  readonly changes: readonly TreeChange[];
  readonly registry: RegistryEdit;
  /** Each replaced key, and the index in `changes` of its cache directory's removal: what the decided plan did with it is the caller's to report. */
  readonly replaced: ReadonlyArray<{ readonly pluginKey: string; readonly index: number }>;
}

/** The marketplace's own replace: the caller's fill, then VAT's marker in the same staged tree. */
function marketplaceChange(paths: ClaudeUserPaths, marketplace: PackageMarketplaceInstall): TreeChange {
  const { marketplaceName, write, reads } = marketplace;
  return {
    op: 'replace',
    dest: safePath.join(paths.marketplacesDir, marketplaceName),
    ownership: VAT_STATE,
    fill: {
      from: 'write',
      reads,
      write: async (staged) => {
        await write(staged);
        await fs.writeFile(safePath.join(staged, VAT_MARKETPLACE_MARKER), MARKER_CONTENTS);
      },
    },
    label: `marketplace ${marketplaceName}`,
  };
}

/** Every plugin directory a replaced cache must not be: the new plugins', and those of every plugin that stays registered. */
function keptPluginDirs(opts: PackageInstallOptions, files: RegistryFiles, replaced: ReadonlySet<string>): string[] {
  const installing = opts.marketplaces.flatMap(({ marketplaceName, plugins }) => plugins.map(({ pluginName }) => ({ pluginName, marketplace: marketplaceName })));
  // Read-only: an ill-formed registered key only names a directory to keep, never one to remove.
  const staying = Object.keys(files.installed.plugins).filter((key) => !replaced.has(key)).flatMap((key) => {
    const halves = splitPluginKey(key);
    return halves === undefined ? [] : [halves];
  });
  return [...installing, ...staying].map(({ pluginName, marketplace }) => safePath.join(opts.paths.pluginsCacheDir, marketplace, pluginName));
}

/** Drop each replaced key from installed_plugins.json and settings.json (its marketplace stays: the package installs into it). */
function dropReplaced(files: RegistryFiles, keys: readonly string[]): void {
  const enabled = enabledPluginsOf(files.settings);
  for (const key of keys) {
    delete files.installed.plugins[key];
    delete enabled[key];
  }
  files.settings['enabledPlugins'] = enabled;
}

/**
 * Plan a package install, with no side effect but reading the registry files.
 *
 * Every name is checked first (each becomes one directory under ~/.claude:
 * {@link requirePluginInstallNames}, {@link parsePluginKey}). The changes, in order:
 * - replace `marketplaces/<marketplace>/` whole with the caller's fill plus VAT's
 *   `.vat-marketplace` marker, so a plugin dropped from the package does not survive, and the
 *   marker lands exactly with the copy;
 * - replace `cache/<marketplace>/<plugin>/<version>/` with each plugin's `cacheFill`;
 * - remove `cache/<marketplace>/<plugin>/` of each replaced key, KEPT where it is, or could not be
 *   ruled out to be, the same entry as a plugin directory the install writes or a registered plugin
 *   keeps (`Old` → `old` on a case-folding filesystem is one directory). A replaced plugin's
 *   marketplace directory goes with its marketplace's replace.
 * The registry edit drops each replaced key, then records each new plugin — so a replaced key the
 * package also installs stays registered, as the new install.
 *
 * @throws VatError `PLUGIN_KEY_INVALID` or `CLAUDE_USER_STATE_UNREADABLE`; a `destination` fault for a
 *   registry file the OS will not read
 */
export function planPackageInstall(opts: PackageInstallOptions): PackageInstallPlan {
  const { marketplaces, version, source, paths } = opts;
  for (const { marketplaceName, plugins } of marketplaces) {
    for (const { pluginName } of plugins) requirePluginInstallNames({ marketplaceName, pluginName, version });
  }
  const replacedKeys = [...new Set(opts.replacedPluginKeys)];
  const replacedNames = replacedKeys.map((pluginKey) => ({ pluginKey, ...parsePluginKey(pluginKey) }));

  const files = readRegistryFiles(paths);
  // Taken now, before the edit below records the new keys and drops the replaced ones: the registry as it IS.
  const kept = keptPluginDirs(opts, files, new Set(replacedKeys));
  const keepIfSameAs = (): readonly string[] => kept;
  const trees: TreeChange[] = [
    ...marketplaces.map((marketplace) => marketplaceChange(paths, marketplace)),
    ...marketplaces.flatMap(({ marketplaceName, plugins }) => plugins.map(({ pluginName, cacheFill }): TreeChange => ({
      op: 'replace',
      dest: pluginCacheDir(paths, { marketplaceName, pluginName, version }),
      ownership: VAT_STATE,
      fill: cacheFill,
      label: `cache of ${pluginName}@${marketplaceName}`,
    }))),
  ];
  const removals = replacedNames.map(({ pluginKey, pluginName, marketplace }): TreeChange => ({
    op: 'remove',
    dest: safePath.join(paths.pluginsCacheDir, marketplace, pluginName),
    ownership: VAT_STATE,
    keepIfSameAs,
    label: `cache of replaced ${pluginKey}`,
  }));

  dropReplaced(files, replacedKeys);
  const now = new Date().toISOString();
  for (const { marketplaceName, plugins } of marketplaces) {
    for (const { pluginName } of plugins) recordPluginInstall(files, paths, { marketplaceName, pluginName, version, source }, now);
  }
  const installed = marketplaces.flatMap(({ marketplaceName, plugins }) => plugins.map(({ pluginName }) => `${pluginName}@${marketplaceName}`));
  const action = `register ${installed.join(', ')}`;
  return {
    changes: [...trees, ...removals],
    // A package that registers nothing and drops nothing leaves the registry files as they are (absent ones absent).
    registry: installed.length === 0 && replacedKeys.length === 0 ? registryEdit(action, []) : registrationEdit(action, paths, files),
    replaced: replacedKeys.map((pluginKey, index) => ({ pluginKey, index: trees.length + index })),
  };
}
