/**
 * `planPackageInstall`: a VAT package's whole install — every marketplace it ships, every plugin's
 * cache, and every plugin its `vat.replaces` names — as ONE plan and one registry edit.
 */

// Test helper — file paths are controlled by test code, not user input

import { readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';

import { applyTreePlan, createSymlink, FS_FAULT_CODE, mkdirSyncReal, planTreeChanges, safePath, symlinkCapability, TREE_DEST_NOT_OWNED_CODE, type TreeFill } from '@vibe-agent-toolkit/utils';
import { diffSnapshots, snapshotTree } from '@vibe-agent-toolkit/utils/testing';
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
    force: false,
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

  it('plans each marketplace as one replace (VAT-made: the marker decides; a write fill), each plugin\'s cache, each replaced cache as a remove, and the three registry files', () => {
    const paths = getPaths();
    const plan = planPackageInstall(options(paths, [OLD_KEY]));

    expect(plan.changes).toMatchObject([
      { op: 'replace', dest: safePath.join(paths.marketplacesDir, MP), ownership: { kind: 'vat-made' }, fill: { from: 'write' } },
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

  it('a plugin key Claude Code also installed at project scope keeps that record: only the user-scope one is replaced', async () => {
    const paths = getPaths();
    priorPlugin(paths, NEW);
    const projectScope = { scope: 'project', projectPath: '/work/repo', installPath: '/elsewhere', version: '0.9.0', installedAt: '', lastUpdated: '' };
    const prior = readJson(paths.installedPluginsPath)['plugins'] as Record<string, unknown[]>;
    writeFileSync(paths.installedPluginsPath, JSON.stringify({ version: 2, plugins: { [NEW_KEY]: [...(prior[NEW_KEY] ?? []), projectScope] } }));

    await install(options(paths));

    const entries = (readJson(paths.installedPluginsPath)['plugins'] as Record<string, Array<{ scope: string; version: string }>>)[NEW_KEY];
    expect(entries).toMatchObject([{ scope: 'user', version: VERSION }, projectScope]);
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

// The registry edit is a read-modify-write: read when the install is planned, written whole once the
// trees are in place — after a copy that can take a while. Anything written to a registry file in
// between (another install, Claude Code saving settings.json) used to be overwritten from the stale
// read, and a rollback put the stale bytes back over it.
describe('the registry edit never overwrites a registry file that changed since the plan read it', () => {
  const { getPaths } = setupPluginTestPaths();

  it.each([
    ['settings.json, saved by Claude Code meanwhile', 'userSettingsPath', JSON.stringify({ theme: 'light', enabledPlugins: { 'theirs@mp2': true } })],
    ['installed_plugins.json, written by another install meanwhile', 'installedPluginsPath', JSON.stringify({ version: 2, plugins: { 'theirs@mp2': [] } })],
  ] as const)('refuses, the trees rolled back and the newer %s kept byte for byte', async (_label, file, newer) => {
    const paths = getPaths();
    priorPlugin(paths, OLD);
    const { changes, registry } = planPackageInstall(options(paths));
    const plan = await planTreeChanges(changes);
    writeFileSync(paths[file], newer);
    const before = snapshotTree(paths.claudeDir);

    const refused = await rejectionOf(() => applyTreePlan(plan, { afterSwap: () => registry.apply() }));

    expect(refused, String(refused)).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'busy', path: paths[file] });
    expect(readFileSync(paths[file], 'utf8')).toBe(newer);
    expect(diffSnapshots(before, snapshotTree(paths.claudeDir))).toEqual([]);
  });

  it('refuses a registry file that APPEARED since the plan found none', async () => {
    const paths = getPaths();
    const { changes, registry } = planPackageInstall(options(paths));
    const plan = await planTreeChanges(changes);
    writeFileSync(paths.knownMarketplacesPath, '{}');

    const refused = await rejectionOf(() => applyTreePlan(plan, { afterSwap: () => registry.apply() }));

    expect(refused, String(refused)).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', path: paths.knownMarketplacesPath });
    expect(readFileSync(paths.knownMarketplacesPath, 'utf8')).toBe('{}');
  });
});

// Ruling R3 as a class: EVERY file VAT writes into a staged tree is exclusive and never follows a link.
// The package's own tree is copied in with its links kept, so a package shipping
// `.vat-marketplace -> ../../../settings.json` had VAT's marker written THROUGH the link: the user's
// settings.json overwritten during staging, where no rollback reaches.
describe('planPackageInstall never writes its marker through an entry the package put there', () => {
  const { getPaths } = setupPluginTestPaths();

  for (const [label, kind] of [
    ['a link to a file outside the tree', 'link'],
    ['a regular file of that name', 'file'],
  ] as const) it(`refuses a package whose marketplace already holds the marker name as ${label}: the source's fault, nothing installed, the outside file untouched`, async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const paths = getPaths();
    writeFileSync(paths.userSettingsPath, '{"theme":"dark"}');
    const base = options(paths);
    const marketplace = base.marketplaces[0];
    if (marketplace === undefined) throw new Error('the fixture ships one marketplace');
    const planted: PackageInstallOptions = { ...base, marketplaces: [{
      ...marketplace,
      write: async (staged) => {
        await marketplace.write(staged);
        const entry = safePath.join(staged, VAT_MARKETPLACE_MARKER);
        if (kind === 'link') createSymlink(cap, paths.userSettingsPath, entry, 'file');
        else writeFileSync(entry, 'the package\'s own');
      },
    }] };

    const refused = await rejectionOf(() => install(planted));

    expect(refused, String(refused)).toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin: 'content', faultClass: 'occupied' });
    expect(String(refused)).toContain(VAT_MARKETPLACE_MARKER);
    expect(readFileSync(paths.userSettingsPath, 'utf8')).toBe('{"theme":"dark"}');
    await expect(fs.lstat(safePath.join(paths.marketplacesDir, MP))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

/** A marketplace directory VAT did not make: a clone Claude Code added, with the user's own file and plugin in it. */
function foreignMarketplace(paths: ClaudeUserPaths, source: Record<string, unknown>): string {
  const dir = safePath.join(paths.marketplacesDir, MP);
  mkdirSyncReal(safePath.join(dir, '.git'), { recursive: true });
  writeFileSync(safePath.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(safePath.join(dir, 'LOCAL-NOTES.md'), 'mine');
  mkdirSyncReal(safePath.join(dir, 'plugins', 'user-plugin'), { recursive: true });
  writeFileSync(paths.knownMarketplacesPath, JSON.stringify({ [MP]: { source, installLocation: dir, lastUpdated: 'then' } }));
  return dir;
}

const planOf = (opts: PackageInstallOptions): Promise<unknown> => planTreeChanges(planPackageInstall(opts).changes);

// Ruling R1: the marker is the only witness that VAT made a marketplace directory. An install that
// replaced whatever stood at marketplaces/<name> deleted a clone Claude Code added, then claimed it.
describe('planPackageInstall never replaces a marketplace VAT cannot prove it installed', () => {
  const { getPaths } = setupPluginTestPaths();

  it('refuses an unmarked directory before anything changes, naming it, its registry entry untouched', async () => {
    const paths = getPaths();
    const dir = foreignMarketplace(paths, { source: 'github', repo: 'o/r' });
    const before = snapshotTree(paths.claudeDir);

    const refused = await rejectionOf(() => install(options(paths)));

    expect(refused, String(refused)).toMatchObject({ code: TREE_DEST_NOT_OWNED_CODE });
    expect(String(refused)).toContain(dir);
    expect(String(refused)).toContain('github:o/r');
    expect(diffSnapshots(before, snapshotTree(paths.claudeDir))).toEqual([]);
  });

  it('--force is the one way past: the directory is replaced and marked', async () => {
    const paths = getPaths();
    const dir = foreignMarketplace(paths, { source: 'github', repo: 'o/r' });

    await install({ ...options(paths), force: true });

    expect(readFileSync(safePath.join(dir, VAT_MARKETPLACE_MARKER), 'utf8')).toContain('"npm:@t/p"');
    await expect(fs.lstat(safePath.join(dir, 'LOCAL-NOTES.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // What every VAT before the marker left: an unmarked directory whose registry entry names the package.
  it('takes an unmarked directory the registry records as installed from this very package (an upgrade from a VAT older than the marker)', async () => {
    const paths = getPaths();
    const dir = foreignMarketplace(paths, { source: 'npm', package: '@t/p', version: '1.0.0' });

    await install(options(paths));

    expect(readFileSync(safePath.join(dir, VAT_MARKETPLACE_MARKER), 'utf8')).toContain('"npm:@t/p"');
  });

  it('refuses an unmarked directory the registry records under ANOTHER package: the name alone proves nothing', async () => {
    const paths = getPaths();
    foreignMarketplace(paths, { source: 'npm', package: '@someone/else' });

    expect(await rejectionOf(() => planOf(options(paths)))).toMatchObject({ code: TREE_DEST_NOT_OWNED_CODE });
  });

  // Two packages of one organisation shipping one marketplace name: the second install deleted the first's plugins.
  it('refuses a marketplace VAT installed from a DIFFERENT package, naming both', async () => {
    const paths = getPaths();
    await install(options(paths));
    const before = snapshotTree(paths.claudeDir);
    const other: PackageInstallOptions = { ...options(paths), source: { source: 'npm', package: '@t/other', version: VERSION } };

    const refused = await rejectionOf(() => install(other));

    expect(refused, String(refused)).toMatchObject({ code: TREE_DEST_NOT_OWNED_CODE });
    expect(String(refused)).toContain('npm:@t/p');
    expect(String(refused)).toContain('npm:@t/other');
    expect(diffSnapshots(before, snapshotTree(paths.claudeDir))).toEqual([]);
  });

  it('re-installs over its own marketplace, and over one whose marker names no installer when the registry agrees', async () => {
    const paths = getPaths();
    await install(options(paths));
    await install(options(paths));
    writeFileSync(safePath.join(paths.marketplacesDir, MP, VAT_MARKETPLACE_MARKER), 'vat\n');

    await install(options(paths));

    expect(readFileSync(safePath.join(paths.marketplacesDir, MP, VAT_MARKETPLACE_MARKER), 'utf8')).toContain('"npm:@t/p"');
  });

  it('refuses a marker that names no installer when the registry records another package', async () => {
    const paths = getPaths();
    foreignMarketplace(paths, { source: 'npm', package: '@someone/else' });
    writeFileSync(safePath.join(paths.marketplacesDir, MP, VAT_MARKETPLACE_MARKER), 'vat\n');

    expect(await rejectionOf(() => planOf(options(paths)))).toMatchObject({ code: TREE_DEST_NOT_OWNED_CODE });
  });

  it('installs over an EMPTY directory of that name: nothing of anyone\'s is lost', async () => {
    const paths = getPaths();
    mkdirSyncReal(safePath.join(paths.marketplacesDir, MP), { recursive: true });

    await install(options(paths));

    expect(readFileSync(safePath.join(paths.marketplacesDir, MP, 'plugins', NEW, 'plugin.json'), 'utf8')).toBe('mp copy');
  });
});
