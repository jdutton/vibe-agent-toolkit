/**
 * `planPackageInstall`: a VAT package's whole install — every marketplace it ships, every plugin's
 * cache, and every plugin its `vat.replaces` names — as ONE plan and one registry edit.
 */

// Test helper — file paths are controlled by test code, not user input

import { readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';

import { applyTreePlan, createSymlink, mkdirSyncReal, planTreeChanges, safePath, symlinkCapability, type TreeFill } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { planPackageInstall, type PackageInstallOptions } from '../../src/install/package-install.js';
import { PLUGIN_KEY_INVALID_CODE, VAT_MARKETPLACE_MARKER } from '../../src/install/plugin-registry.js';
import type { ClaudeUserPaths } from '../../src/paths/claude-paths.js';
import { rejectionOf, setupPluginTestPaths } from '../test-helpers.js';

const MP = 'mp';
const NEW = 'new-plugin';
const OLD = 'old-plugin';
const VERSION = '2.0.0';
const NEW_KEY = `${NEW}@${MP}`;
const OLD_KEY = `${OLD}@${MP}`;

/** A built plugin directory outside ~/.claude, the cache copies it. */
function builtPlugin(paths: ClaudeUserPaths, name: string): string {
  const dir = safePath.join(paths.claudeDir, '..', 'pkg', name);
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(safePath.join(dir, 'plugin.json'), JSON.stringify({ name }));
  return dir;
}

/** A plugin a previous install left: its cache directory and its three registry entries. */
function priorPlugin(paths: ClaudeUserPaths, name: string): void {
  const cache = safePath.join(paths.pluginsCacheDir, MP, name, '1.0.0');
  mkdirSyncReal(cache, { recursive: true });
  writeFileSync(safePath.join(cache, 'plugin.json'), '{}');
  const key = `${name}@${MP}`;
  writeFileSync(paths.installedPluginsPath, JSON.stringify({ version: 2, plugins: { [key]: [{ scope: 'user', installPath: cache, version: '1.0.0', installedAt: '', lastUpdated: '' }] } }));
  writeFileSync(paths.knownMarketplacesPath, JSON.stringify({ [MP]: { source: { source: 'npm', package: '@t/p' }, installLocation: '', lastUpdated: '' } }));
  writeFileSync(paths.userSettingsPath, JSON.stringify({ theme: 'dark', enabledPlugins: { [key]: true } }));
}

function options(paths: ClaudeUserPaths, replaced: readonly string[] = []): PackageInstallOptions {
  const cacheFill: TreeFill = { from: 'copy', source: builtPlugin(paths, NEW), side: 'source', links: 'preserve' };
  return {
    marketplaces: [{
      marketplaceName: MP,
      write: async (staged) => {
        await fs.mkdir(safePath.join(staged, 'plugins', NEW), { recursive: true });
        await fs.writeFile(safePath.join(staged, 'plugins', NEW, 'plugin.json'), 'mp copy');
      },
      reads: [],
      plugins: [{ pluginName: NEW, cacheFill }],
    }],
    version: VERSION,
    source: { source: 'npm', package: '@t/p', version: VERSION },
    replacedPluginKeys: replaced,
    paths,
  };
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

async function install(opts: PackageInstallOptions): Promise<void> {
  const { changes, registry } = planPackageInstall(opts);
  await applyTreePlan(await planTreeChanges(changes), { afterSwap: () => registry.apply() });
}

describe('planPackageInstall', () => {
  const { getPaths } = setupPluginTestPaths();

  it('plans each marketplace as one replace (VAT state, a write fill), each plugin\'s cache, each replaced cache as a remove, and the three registry files', () => {
    const paths = getPaths();
    const plan = planPackageInstall(options(paths, [OLD_KEY]));

    expect(plan.changes).toMatchObject([
      { op: 'replace', dest: safePath.join(paths.marketplacesDir, MP), ownership: { kind: 'vat-state' }, fill: { from: 'write' } },
      { op: 'replace', dest: safePath.join(paths.pluginsCacheDir, MP, NEW, VERSION), ownership: { kind: 'vat-state' }, fill: { from: 'copy' } },
      { op: 'remove', dest: safePath.join(paths.pluginsCacheDir, MP, OLD), ownership: { kind: 'vat-state' } },
    ]);
    expect(plan.replaced).toEqual([{ pluginKey: OLD_KEY, index: 2 }]);
    expect(plan.registry.files).toEqual([paths.knownMarketplacesPath, paths.installedPluginsPath, paths.userSettingsPath]);
  });

  it('writes VAT\'s marker into the marketplace fill itself, so it lands exactly with the copy', async () => {
    const paths = getPaths();

    await install(options(paths));

    expect(readFileSync(safePath.join(paths.marketplacesDir, MP, VAT_MARKETPLACE_MARKER), 'utf8')).toContain('vibe-agent-toolkit');
    expect(readFileSync(safePath.join(paths.marketplacesDir, MP, 'plugins', NEW, 'plugin.json'), 'utf8')).toBe('mp copy');
    expect(readFileSync(safePath.join(paths.pluginsCacheDir, MP, NEW, VERSION, 'plugin.json'), 'utf8')).toContain(NEW);
  });

  it('registers the new plugin and drops each replaced one, in one edit, keeping the rest of settings.json', async () => {
    const paths = getPaths();
    priorPlugin(paths, OLD);

    await install(options(paths, [OLD_KEY]));

    expect(Object.keys((readJson(paths.installedPluginsPath)['plugins'] ?? {}) as object)).toEqual([NEW_KEY]);
    expect(readJson(paths.userSettingsPath)).toMatchObject({ theme: 'dark', enabledPlugins: { [NEW_KEY]: true } });
    expect(readJson(paths.userSettingsPath)['enabledPlugins']).not.toHaveProperty(OLD_KEY);
    expect(readJson(paths.knownMarketplacesPath)).toMatchObject({ [MP]: { source: { source: 'npm', package: '@t/p', version: VERSION } } });
    await expect(fs.lstat(safePath.join(paths.pluginsCacheDir, MP, OLD))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a replaced key the package also installs stays registered, as the new install', async () => {
    const paths = getPaths();
    priorPlugin(paths, NEW);

    await install(options(paths, [NEW_KEY]));

    const installed = readJson(paths.installedPluginsPath)['plugins'] as Record<string, Array<{ version: string }>>;
    expect(Object.keys(installed)).toEqual([NEW_KEY]);
    expect(installed[NEW_KEY]?.[0]?.version).toBe(VERSION);
  });

  // Review Focus 1: `Old` → `new` where the two cache directories are ONE entry (a case-folding
  // filesystem; here a link, which identity treats the same way). Removing the old one would take the
  // new install with it: it is kept, its key unregistered, and the new plugin installed into it.
  it('keeps a replaced cache directory that is the new plugin\'s own, unregistering only its key', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const paths = getPaths();
    priorPlugin(paths, NEW);
    createSymlink(cap, safePath.join(paths.pluginsCacheDir, MP, NEW), safePath.join(paths.pluginsCacheDir, MP, OLD), 'dir');
    const prior = readJson(paths.installedPluginsPath);
    writeFileSync(paths.installedPluginsPath, JSON.stringify({ version: 2, plugins: { [OLD_KEY]: (prior['plugins'] as Record<string, unknown>)[NEW_KEY] } }));

    const { changes, replaced } = planPackageInstall(options(paths, [OLD_KEY]));
    const plan = await planTreeChanges(changes);

    expect(plan.changes[replaced[0]?.index ?? -1]).toMatchObject({ action: 'keep' });
    await install(options(paths, [OLD_KEY]));
    expect(Object.keys((readJson(paths.installedPluginsPath)['plugins'] ?? {}) as object)).toEqual([NEW_KEY]);
    expect(readFileSync(safePath.join(paths.pluginsCacheDir, MP, NEW, VERSION, 'plugin.json'), 'utf8')).toContain(NEW);
  });

  it('a package that ships no plugin and replaces none writes no registry file', () => {
    const paths = getPaths();
    const opts = options(paths);
    const marketplace = opts.marketplaces[0];
    if (marketplace === undefined) throw new Error('the fixture ships one marketplace');

    const plan = planPackageInstall({ ...opts, marketplaces: [{ ...marketplace, plugins: [] }] });

    expect(plan.registry.files).toEqual([]);
  });

  it.each([
    ['a version that is not one path segment', { version: '../x' }],
    ['a replaced key that is not a plugin key', { replacedPluginKeys: ['../../victim@mp'] }],
  ])('refuses %s as PLUGIN_KEY_INVALID before reading anything', async (_label, override) => {
    const paths = getPaths();

    const error = await rejectionOf(async () => planPackageInstall({ ...options(paths), ...override }));

    expect(error).toMatchObject({ code: PLUGIN_KEY_INVALID_CODE });
  });
});
