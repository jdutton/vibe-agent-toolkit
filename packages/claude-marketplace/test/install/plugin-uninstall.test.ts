// packages/claude-marketplace/test/install/plugin-uninstall.test.ts

// Test helper — file paths are controlled by test code, not user input

import nodeFs, { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { createSymlink, FS_FAULT_CODE, isVatError, mkdirSyncReal, relativeEscapesRoot, safePath, symlinkCapability, TREE_ROLLBACK_INCOMPLETE_CODE, TreeRollbackIncompleteError } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, diffSnapshots, type FaultRule, refuseSyncFs, snapshotTree, type StatRewrite, tmpdirFoldsCase } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { CLAUDE_USER_STATE_UNREADABLE_CODE, PLUGIN_KEY_INVALID_CODE, VAT_MARKETPLACE_MARKER } from '../../src/install/plugin-registry.js';
import { findPluginsByPackage, parsePluginKey, planPluginUninstall, type UninstallPluginResult, uninstallPlugins } from '../../src/install/plugin-uninstall.js';
import type { ClaudeUserPaths } from '../../src/paths/claude-paths.js';
import { rejectionOf, setupPluginTestPaths, stagedWriteOf, underFaults } from '../test-helpers.js';

function setupInstalledPlugin(
  paths: ClaudeUserPaths,
  pluginName: string,
  marketplace: string,
  npmPackage: string,
  version = '1.0.0',
): void {
  const pluginKey = `${pluginName}@${marketplace}`;

  // Artifact 1: marketplaces dir
  const mpPluginDir = safePath.join(paths.marketplacesDir, marketplace, 'plugins', pluginName);
  mkdirSyncReal(mpPluginDir, { recursive: true });
  writeFileSync(safePath.join(mpPluginDir, 'SKILL.md'), `# ${pluginName}`);

  // Artifact 2: cache dir
  const cacheDir = safePath.join(paths.pluginsCacheDir, marketplace, pluginName, version);
  mkdirSyncReal(cacheDir, { recursive: true });
  writeFileSync(safePath.join(cacheDir, 'SKILL.md'), `# ${pluginName}`);

  // Artifact 3: installed_plugins.json
  writeFileSync(paths.installedPluginsPath, JSON.stringify({
    version: 2,
    plugins: {
      [pluginKey]: [{ scope: 'user', installPath: cacheDir, version, installedAt: '', lastUpdated: '' }],
    },
  }));

  // Artifact 4: known_marketplaces.json
  writeFileSync(paths.knownMarketplacesPath, JSON.stringify({
    [marketplace]: { source: { source: 'npm', package: npmPackage, version }, installLocation: '', lastUpdated: '' },
  }));

  // Artifact 5: settings.json
  writeFileSync(paths.userSettingsPath, JSON.stringify({ enabledPlugins: { [pluginKey]: true } }));

  // VAT's witness that it made the marketplace, as a plugin install writes it.
  writeFileSync(safePath.join(paths.marketplacesDir, marketplace, VAT_MARKETPLACE_MARKER), 'vat\n');
}

/** Uninstall one key: the single result of a one-key transaction. */
async function uninstallPlugin(opts: { pluginKey: string; paths: ClaudeUserPaths; dryRun?: boolean }): Promise<UninstallPluginResult> {
  const { results: [result], leftover } = await uninstallPlugins({ pluginKeys: [opts.pluginKey], paths: opts.paths, ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }) });
  if (leftover !== undefined) throw leftover;
  if (result === undefined) throw new Error('uninstallPlugins returned no result for its one key');
  return result;
}

/** The case root a test's Claude paths live under: where its fault sessions trace. */
const caseRoot = (paths: ClaudeUserPaths): string => safePath.join(paths.claudeDir, '..');

describe('uninstallPlugin', () => {
  const { getPaths } = setupPluginTestPaths();

  it('removes every artifact of a registered plugin, and its marketplace with the last plugin of it', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');
    const result = await uninstallPlugin({ pluginKey: 'my-skill@my-market', paths });

    expect(result.removed).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.artifacts).toEqual({ pluginDir: true, cacheDir: true, marketplaceDir: true, installedPlugins: true, knownMarketplaces: true, settings: true });
    // The registry no longer names the marketplace, so its directory is not left behind for nothing to name.
    expect(existsSync(safePath.join(paths.marketplacesDir, 'my-market'))).toBe(false);
    expect(existsSync(safePath.join(paths.pluginsCacheDir, 'my-market', 'my-skill'))).toBe(false);
    // installed_plugins.json: key removed
    const ip = JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8'));
    expect(ip.plugins['my-skill@my-market']).toBeUndefined();
    // known_marketplaces.json: removed (last plugin)
    const km = JSON.parse(readFileSync(paths.knownMarketplacesPath, 'utf-8'));
    expect(km['my-market']).toBeUndefined();
    // settings.json: enabledPlugins key removed
    const s = JSON.parse(readFileSync(paths.userSettingsPath, 'utf-8'));
    expect(s.enabledPlugins?.['my-skill@my-market']).toBeUndefined();
  });

  it('is idempotent: exits cleanly when plugin not installed', async () => {
    const result = await uninstallPlugin({ pluginKey: 'missing@market', paths: getPaths() });
    expect(result.removed).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it('keeps the marketplace, in the registry and on disk, while another of its plugins is installed', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'skill-a', 'shared-market', '@test/pkg-a');
    // Add a second plugin to the same marketplace
    const pluginBDir = safePath.join(paths.marketplacesDir, 'shared-market', 'plugins', 'skill-b');
    mkdirSyncReal(pluginBDir, { recursive: true });
    const ip = JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8'));
    ip.plugins['skill-b@shared-market'] = [{ scope: 'user', installPath: '', version: '1.0.0', installedAt: '', lastUpdated: '' }];
    writeFileSync(paths.installedPluginsPath, JSON.stringify(ip));

    const result = await uninstallPlugin({ pluginKey: 'skill-a@shared-market', paths });

    const km = JSON.parse(readFileSync(paths.knownMarketplacesPath, 'utf-8'));
    expect(km['shared-market']).toBeDefined(); // still has skill-b
    expect(existsSync(pluginBDir)).toBe(true);
    expect(existsSync(safePath.join(paths.marketplacesDir, 'shared-market', 'plugins', 'skill-a'))).toBe(false);
    expect(result.artifacts).toMatchObject({ pluginDir: true, marketplaceDir: false, knownMarketplaces: false });
  });

  // The dry run IS the plan: one `describe()` line per change, the same plan the real run applies.
  it('dry-run: hands back the plan\'s lines, one per change, and changes nothing', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');
    const before = snapshotTree(paths.claudeDir);

    const { changes } = await uninstallPlugins({ pluginKeys: ['my-skill@my-market'], paths, dryRun: true });

    expect(changes).toEqual([
      `subsumed marketplace copy of my-skill@my-market ${safePath.join(paths.marketplacesDir, 'my-market', 'plugins', 'my-skill')} (parked by remove marketplace my-market)`,
      `remove cache of my-skill@my-market ${safePath.join(paths.pluginsCacheDir, 'my-market', 'my-skill')}`,
      `remove marketplace my-market ${safePath.join(paths.marketplacesDir, 'my-market')}`,
    ]);
    expect(diffSnapshots(before, snapshotTree(paths.claudeDir))).toEqual([]);
  });

  // Once the registry is rewritten the uninstall has happened: a moved-aside directory the OS then will
  // not delete is a leftover to name, never "nothing finished, everything put back".
  it('reports every key uninstalled, with the leftover, when a moved-aside directory will not go after the registry is written', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');
    const parkedCache = (p: string): boolean => p.includes('/.my-skill.vat-staged-') && p.endsWith('.previous');

    const outcome = await underFaults(caseRoot(paths), { faults: [{ family: 'remove', op: 'rm', path: parkedCache, errno: 'EBUSY' }] }, () =>
      uninstallPlugins({ pluginKeys: ['my-skill@my-market'], paths }));

    expect(outcome.results).toMatchObject([{ removed: true, artifacts: { cacheDir: true, installedPlugins: true } }]);
    expect(outcome.leftover, String(outcome.leftover)).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', errno: 'EBUSY' });
    expect(String(outcome.leftover)).toMatch(/\.my-skill\.vat-staged-\w+\.previous/);
    expect(JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8')).plugins).toEqual({});
    expect(existsSync(safePath.join(paths.pluginsCacheDir, 'my-market', 'my-skill'))).toBe(false);
  });

  // A marketplace Claude Code added (a github clone) is the user's: VAT's last plugin of it going
  // must not take the clone, nor its known_marketplaces.json entry.
  // Claude Code registers marketplaces of every source — npm included — so the source proves nothing.
  // Only VAT's marker does: an unmarked marketplace (a Claude Code one, or one an older VAT installed
  // before the marker existed) is the user's, and its directory and entry stay.
  it.for([
    ['a github clone', { source: 'github', repo: 'o/r' }],
    ['an npm marketplace Claude Code registered', { source: 'npm', package: '@someone/mp' }],
  ] as const)('keeps a marketplace with no VAT marker — %s — directory and entry, saying why, when its last plugin goes', async ([, source]) => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'my-skill', 'their-market', '@test/pkg');
    writeFileSync(paths.knownMarketplacesPath, JSON.stringify({ 'their-market': { source, installLocation: '', lastUpdated: '' } }));
    const clone = safePath.join(paths.marketplacesDir, 'their-market');
    rmSync(safePath.join(clone, VAT_MARKETPLACE_MARKER));
    writeFileSync(safePath.join(clone, 'README.md'), 'the user\'s marketplace');

    const result = await uninstallPlugin({ pluginKey: 'my-skill@their-market', paths });

    expect(readFileSync(safePath.join(clone, 'README.md'), 'utf-8')).toBe('the user\'s marketplace');
    expect(existsSync(safePath.join(clone, 'plugins', 'my-skill'))).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(paths.knownMarketplacesPath, 'utf-8')))).toEqual(['their-market']);
    expect(result.artifacts).toMatchObject({ pluginDir: true, marketplaceDir: false, knownMarketplaces: false });
    expect(result.warning).toContain(`no ${VAT_MARKETPLACE_MARKER} marker`);
  });

  // The marker is the target's own: a probe of it the OS refuses (or answers ENOENT while it is listed)
  // proves nothing either way, so the uninstall refuses with nothing changed — never keeps silently, never removes.
  it.for(['EACCES', 'ENOENT'] as const)('refuses, changing nothing, when VAT\'s marker cannot be examined (%s)', async (errno) => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');
    const marker = safePath.join(paths.marketplacesDir, 'my-market', VAT_MARKETPLACE_MARKER);
    const before = snapshotTree(paths.claudeDir);

    const thrown = await underFaults(caseRoot(paths), { faults: [{ op: 'lstat', path: (p) => p === marker, errno }] }, () =>
      rejectionOf(() => uninstallPlugins({ pluginKeys: ['my-skill@my-market'], paths })));

    expect(thrown, String(thrown)).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', errno, path: marker });
    expect(diffSnapshots(before, snapshotTree(paths.claudeDir))).toEqual([]);
  });

  it('removes a marketplace VAT marked, with its known entry, when its last plugin goes', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');

    const result = await uninstallPlugin({ pluginKey: 'my-skill@my-market', paths });

    expect(result.artifacts).toMatchObject({ marketplaceDir: true, knownMarketplaces: true });
    expect(existsSync(safePath.join(paths.marketplacesDir, 'my-market'))).toBe(false);
  });

  it('dry-run: returns removed=true but does not touch filesystem', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');
    const before = snapshotTree(paths.claudeDir);
    const result = await uninstallPlugin({ pluginKey: 'my-skill@my-market', paths, dryRun: true });
    expect(result.removed).toBe(true);
    expect(result.artifacts).toMatchObject({ pluginDir: true, cacheDir: true, marketplaceDir: true });
    expect(diffSnapshots(before, snapshotTree(paths.claudeDir))).toEqual([]);
  });

  // Invariant I7: the directories were already moved aside when the registry write failed. Every
  // one of them, and every registry file written before the failing one, is put back.
  it.each(['installedPluginsPath', 'knownMarketplacesPath', 'userSettingsPath'] as const)(
    'a %s write it could not make is a destination fault, and every directory and registry file is put back',
    async (file) => {
      const paths = getPaths();
      setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');
      const before = snapshotTree(paths.claudeDir);

      const thrown = await underFaults(caseRoot(paths), { faults: [{ family: 'rename', path: stagedWriteOf(paths[file]), errno: 'EACCES' }] }, () =>
        rejectionOf(() => uninstallPlugin({ pluginKey: 'my-skill@my-market', paths })));

      expect(thrown, String(thrown)).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'refused' });
      expect(String(thrown)).toContain('my-skill@my-market');
      expect(String(thrown)).toContain(basename(paths[file]));
      expect(diffSnapshots(before, snapshotTree(paths.claudeDir))).toEqual([]);
    },
  );

  // A registry file written before the failure that cannot be put back leaves the registry
  // disagreeing with the restored tree: that is never a clean refusal.
  it('names a registry file it could not put back as TREE_ROLLBACK_INCOMPLETE, the directories restored', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');

    const thrown = await underFaults(caseRoot(paths), {
      faults: [
        { family: 'rename', path: stagedWriteOf(paths.userSettingsPath), errno: 'EACCES' },
        // The second rename of installed_plugins.json's temp is its restore.
        { family: 'rename', path: stagedWriteOf(paths.installedPluginsPath), nth: 2, errno: 'EACCES' },
      ],
    }, () => rejectionOf(() => uninstallPlugin({ pluginKey: 'my-skill@my-market', paths })));

    expect(isVatError(thrown, TREE_ROLLBACK_INCOMPLETE_CODE), String(thrown)).toBe(true);
    // The one shape of that code: the file it could not put back is a stranded destination, nothing parked.
    expect(thrown).toBeInstanceOf(TreeRollbackIncompleteError);
    expect((thrown as TreeRollbackIncompleteError).stranded).toMatchObject([{ dest: paths.installedPluginsPath, parked: undefined }]);
    expect(String(thrown)).toContain(paths.installedPluginsPath);
    expect(existsSync(safePath.join(paths.marketplacesDir, 'my-market', 'plugins', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(paths.pluginsCacheDir, 'my-market', 'my-skill', '1.0.0', 'SKILL.md'))).toBe(true);
  });

  // `--all` is one transaction: a registry write that fails after the first key's directories
  // were moved aside used to leave that key uninstalled and the next one installed.
  it('uninstalls several keys as one transaction: a failure puts every key back, and success takes them all with their marketplace', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'a', 'mp', '@test/pkg');
    mkdirSyncReal(safePath.join(paths.marketplacesDir, 'mp', 'plugins', 'b'), { recursive: true });
    mkdirSyncReal(safePath.join(paths.pluginsCacheDir, 'mp', 'b', '1.0.0'), { recursive: true });
    registerKey(paths, 'b@mp', safePath.join(paths.pluginsCacheDir, 'mp', 'b', '1.0.0'));
    const before = snapshotTree(paths.claudeDir);
    const keys = ['a@mp', 'b@mp'];

    // The second key's own cache directory cannot be examined: one transaction refuses before
    // touching the first key; key-by-key, the first was already gone.
    const bCache = safePath.join(paths.pluginsCacheDir, 'mp', 'b');
    const thrown = await underFaults(caseRoot(paths), { faults: [{ op: 'lstat', path: (p) => p === bCache, errno: 'EACCES' }] }, () =>
      rejectionOf(() => uninstallPlugins({ pluginKeys: keys, paths })));
    expect(thrown, String(thrown)).toMatchObject({ code: FS_FAULT_CODE, side: 'destination' });
    expect(diffSnapshots(before, snapshotTree(paths.claudeDir))).toEqual([]);

    const { results } = await uninstallPlugins({ pluginKeys: keys, paths });
    expect(results.map((r) => r.removed)).toEqual([true, true]);
    expect(existsSync(safePath.join(paths.marketplacesDir, 'mp'))).toBe(false);
    expect(JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8')).plugins).toEqual({});
    expect(JSON.parse(readFileSync(paths.knownMarketplacesPath, 'utf-8'))).toEqual({});
  });

  // A known marketplace whose directory is already gone has nothing on disk to disagree with:
  // its entry goes with its last plugin.
  // A directory that is gone carries no marker: nothing shows VAT made the entry, so it is not VAT's to drop.
  it('keeps the known entry of a marketplace whose directory is already gone: nothing marks it VAT\'s', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');
    rmSync(safePath.join(paths.marketplacesDir, 'my-market'), { recursive: true });

    const result = await uninstallPlugin({ pluginKey: 'my-skill@my-market', paths });

    expect(result.artifacts).toMatchObject({ marketplaceDir: false, knownMarketplaces: false, cacheDir: true });
    expect(Object.keys(JSON.parse(readFileSync(paths.knownMarketplacesPath, 'utf-8')))).toEqual(['my-market']);
  });

  // An older VAT build copied a read-only plugin's modes into ~/.claude: a tree its owner cannot
  // empty without first making it writable. The uninstall must still take it away, whole.
  it.skipIf(CANNOT_DENY_READS)('removes a plugin whose installed tree is read-only (0555), whole', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'my-skill', 'my-market', '@test/pkg');
    const cacheVersion = safePath.join(paths.pluginsCacheDir, 'my-market', 'my-skill', '1.0.0');
    const mpPlugin = safePath.join(paths.marketplacesDir, 'my-market', 'plugins', 'my-skill');
    for (const dir of [cacheVersion, mpPlugin]) {
      mkdirSyncReal(safePath.join(dir, 'skills', 's'), { recursive: true });
      writeFileSync(safePath.join(dir, 'skills', 's', 'SKILL.md'), '# s\n');
      chmodSync(safePath.join(dir, 'skills', 's'), 0o555);
      chmodSync(safePath.join(dir, 'skills'), 0o555);
      chmodSync(dir, 0o555);
    }

    const result = await uninstallPlugin({ pluginKey: 'my-skill@my-market', paths });

    expect(result.warning).toBeUndefined();
    expect(existsSync(safePath.join(paths.pluginsCacheDir, 'my-market', 'my-skill'))).toBe(false);
    expect(existsSync(safePath.join(paths.marketplacesDir, 'my-market'))).toBe(false);
  });

  it('warns and cleans if plugin dir exists but not in registry', async () => {
    const paths = getPaths();
    // Only artifact 1 (dir) exists — not VAT-installed
    const mpPluginDir = safePath.join(paths.marketplacesDir, 'my-market', 'plugins', 'orphan');
    mkdirSyncReal(mpPluginDir, { recursive: true });
    const result = await uninstallPlugin({ pluginKey: 'orphan@my-market', paths });
    expect(result.removed).toBe(true);
    expect(result.warning).toContain('not installed via VAT');
    expect(existsSync(mpPluginDir)).toBe(false);
  });

  it('a dry-run over an orphan says the directory WOULD be removed, never that it is cleaning up', async () => {
    const paths = getPaths();
    const mpPluginDir = safePath.join(paths.marketplacesDir, 'my-market', 'plugins', 'orphan');
    mkdirSyncReal(mpPluginDir, { recursive: true });
    const result = await uninstallPlugin({ pluginKey: 'orphan@my-market', paths, dryRun: true });
    expect(result.removed).toBe(true);
    expect(result.warning).toContain('not installed via VAT');
    expect(result.warning).toContain('would be removed');
    expect(result.warning).not.toContain('cleaning up');
    expect(existsSync(mpPluginDir)).toBe(true);
  });
});

/** Add `pluginKey` to the registry, its install path `installPath`. */
function registerKey(paths: ClaudeUserPaths, pluginKey: string, installPath: string): void {
  const ip = JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8'));
  ip.plugins[pluginKey] = [{ scope: 'user', installPath, version: '1.0.0', installedAt: '', lastUpdated: '' }];
  writeFileSync(paths.installedPluginsPath, JSON.stringify(ip));
}

/** A clone that keeps the Stats prototype, with dev and ino replaced (in the call's own number type). */
const withIdentity = (dev: bigint, ino: bigint): StatRewrite['rewrite'] => (stats) => {
  const big = typeof stats.ino === 'bigint';
  return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as typeof stats, stats, { dev: big ? dev : Number(dev), ino: big ? ino : Number(ino) });
};

/** A filesystem that reports no inode (0) for any entry: only the real path can tell two apart. */
const NO_INODES: readonly StatRewrite[] = [
  { op: 'lstat', path: () => true, rewrite: withIdentity(0n, 0n) },
  { op: 'stat', path: () => true, rewrite: withIdentity(0n, 0n) },
];

// `vat.replaces` runs after the install: a package that renames `Old` → `old` and replaces
// `Old` uninstalled `Old@mp` — and on a case-insensitive filesystem `plugins/Old` IS
// `plugins/old`, so it removed the plugin it had just installed, exit 0, registry dangling.
describe('uninstallPlugin never removes a directory another registered plugin is installed in', () => {
  const { getPaths } = setupPluginTestPaths();

  // Only a case-folding filesystem can hold this alias for real. An inode of 0 used to read as
  // "nothing there", deleting the alias wherever the filesystem reports none: unknowable
  // identity must keep, never remove.
  it.skipIf(!tmpdirFoldsCase()).for([
    ['', false],
    [', when the filesystem reports no inode', true],
  ] as const)('keeps old@mp\'s directories when uninstalling Old@mp on a case-insensitive filesystem%s', async ([, noInodes]) => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'old', 'mp', '@test/pkg', '2.0.0');
    registerKey(paths, 'Old@mp', safePath.join(paths.pluginsCacheDir, 'mp', 'Old', '1.0.0'));

    const result = await underFaults(caseRoot(paths), { rewrites: noInodes ? NO_INODES : [] }, () => uninstallPlugin({ pluginKey: 'Old@mp', paths }));

    expect(existsSync(safePath.join(paths.marketplacesDir, 'mp', 'plugins', 'old', 'SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(paths.pluginsCacheDir, 'mp', 'old', '2.0.0', 'SKILL.md'))).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8')).plugins)).toEqual(['old@mp']);
    expect(result.artifacts).toMatchObject({ pluginDir: false, cacheDir: false, installedPlugins: true });
    expect(result.warning).toContain(safePath.join(paths.marketplacesDir, 'mp', 'plugins', 'old'));
  });

  // R6 C1 on every OS: the alias is SIMULATED — `Old` and `old` report one device and inode — so a
  // case-sensitive host decides exactly as a case-folding one must, by identity, never by name.
  it('keeps the directories of old@mp that Old@mp\'s directories ARE on disk, judged by identity alone', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'old', 'mp', '@test/pkg', '2.0.0');
    registerKey(paths, 'Old@mp', safePath.join(paths.pluginsCacheDir, 'mp', 'Old', '1.0.0'));
    const mp = (name: string): string => safePath.join(paths.marketplacesDir, 'mp', 'plugins', name);
    const cache = (name: string): string => safePath.join(paths.pluginsCacheDir, 'mp', name);
    // Where case is kept, `Old` is a directory of its own until the rewrite makes it `old`.
    if (!tmpdirFoldsCase()) for (const dir of [mp('Old'), cache('Old')]) mkdirSyncReal(dir, { recursive: true });
    const alias = (names: readonly string[], ino: bigint): StatRewrite => ({ op: 'lstat', path: (p) => names.includes(p), rewrite: withIdentity(9n, ino) });

    const result = await underFaults(caseRoot(paths), { rewrites: [alias([mp('Old'), mp('old')], 77n), alias([cache('Old'), cache('old')], 78n)] }, () =>
      uninstallPlugin({ pluginKey: 'Old@mp', paths }));

    expect(existsSync(safePath.join(mp('old'), 'SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(cache('old'), '2.0.0', 'SKILL.md'))).toBe(true);
    expect(existsSync(mp('Old'))).toBe(true);
    expect(result.artifacts).toMatchObject({ pluginDir: false, cacheDir: false, installedPlugins: true });
    expect(Object.keys(JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8')).plugins)).toEqual(['old@mp']);
  });

  it('keeps a directory that reaches another registered plugin\'s through a linked marketplace', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const paths = getPaths();
    setupInstalledPlugin(paths, 'p', 'mp', '@test/pkg');
    createSymlink(cap, safePath.join(paths.marketplacesDir, 'mp'), safePath.join(paths.marketplacesDir, 'alias'), 'dir');
    createSymlink(cap, safePath.join(paths.pluginsCacheDir, 'mp'), safePath.join(paths.pluginsCacheDir, 'alias'), 'dir');
    registerKey(paths, 'p@alias', safePath.join(paths.pluginsCacheDir, 'alias', 'p', '1.0.0'));

    await uninstallPlugin({ pluginKey: 'p@alias', paths });

    expect(existsSync(safePath.join(paths.marketplacesDir, 'mp', 'plugins', 'p', 'SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(paths.pluginsCacheDir, 'mp', 'p', '1.0.0', 'SKILL.md'))).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8')).plugins)).toEqual(['p@mp']);
  });

  // The guard compared the other plugin's entry WITHOUT following it: `mp2/plugins/p` is a link
  // to `mp/plugins/p`, so its lstat is the link's own inode, and uninstalling p@mp emptied p@mp2.
  // Windows answers a real path in its own separator (`C:\…`) while every other spelling here is
  // forward-slashed, so the real-path fallback read one directory as two and removed it. The
  // no-inode rows run on every OS: the stat rewrite reports ino 0 wherever the test runs.
  it.for([
    ['its own device and inode', false, false],
    ['no inode (0), where only the real path can tell', true, false],
    ['no inode (0), with the real path answered in backslashes as Windows does', true, true],
  ] as const)('keeps a directory another registered plugin\'s directory LINKS to, judged by %s', async ([, noInodes, backslashes], { skip }) => {
    const cap = symlinkCapability() ?? skip();
    const paths = getPaths();
    setupInstalledPlugin(paths, 'p', 'mp', '@test/pkg');
    mkdirSyncReal(safePath.join(paths.marketplacesDir, 'mp2', 'plugins'), { recursive: true });
    createSymlink(cap, safePath.join(paths.marketplacesDir, 'mp', 'plugins', 'p'), safePath.join(paths.marketplacesDir, 'mp2', 'plugins', 'p'), 'dir');
    registerKey(paths, 'p@mp2', safePath.join(paths.pluginsCacheDir, 'mp2', 'p', '1.0.0'));

    const result = await underFaults(caseRoot(paths), { rewrites: noInodes ? NO_INODES : [] }, () =>
      withRealPathsIn(backslashes, () => uninstallPlugin({ pluginKey: 'p@mp', paths })));

    expect(existsSync(safePath.join(paths.marketplacesDir, 'mp', 'plugins', 'p', 'SKILL.md'))).toBe(true);
    expect(result.artifacts.pluginDir).toBe(false);
    expect(result.warning).toContain(safePath.join(paths.marketplacesDir, 'mp2', 'plugins', 'p'));
  });

  // One unrelated plugin's directory the OS would not examine blocked every uninstall — and it
  // failed AFTER the target's marketplace directory was gone, the registry still listing it.
  it.skipIf(CANNOT_DENY_READS)('keeps, and warns, where another plugin\'s directory cannot be examined — never blocks, never half-removes', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'other', 'mp2', '@test/pkg');
    const lockedCache = safePath.join(paths.pluginsCacheDir, 'mp');
    mkdirSyncReal(safePath.join(lockedCache, 'old', '1.0.0'), { recursive: true });
    registerKey(paths, 'old@mp', safePath.join(lockedCache, 'old', '1.0.0'));
    chmodSync(lockedCache, 0o000);
    let result: Awaited<ReturnType<typeof uninstallPlugin>>;
    try {
      result = await uninstallPlugin({ pluginKey: 'other@mp2', paths });
    } finally {
      chmodSync(lockedCache, 0o755);
    }

    expect(Object.keys(JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8')).plugins)).toEqual(['old@mp']);
    expect(existsSync(safePath.join(paths.marketplacesDir, 'mp2', 'plugins', 'other'))).toBe(false);
    expect(existsSync(safePath.join(paths.pluginsCacheDir, 'mp2', 'other', '1.0.0', 'SKILL.md'))).toBe(true);
    expect(result.artifacts).toMatchObject({ pluginDir: true, cacheDir: false, installedPlugins: true });
    expect(result.warning).toContain(safePath.join(lockedCache, 'old'));
    // The kept directory by path, with the sibling the OS refused: a caller names it by code, never by message text.
    expect(result.keptForSibling).toEqual([{ path: safePath.join(paths.pluginsCacheDir, 'mp2', 'other'), sibling: safePath.join(lockedCache, 'old') }]);
  });

  // R7 d-I-1 on every OS: the sibling's refusal is a KEEP decided in the plan, before the apply
  // moves anything — so the kept directory is never touched at all, not moved and put back.
  it('decides a sibling it cannot examine as a keep in the plan, and never moves the kept directory', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'other', 'mp2', '@test/pkg');
    const sibling = safePath.join(paths.pluginsCacheDir, 'mp', 'old');
    mkdirSyncReal(safePath.join(sibling, '1.0.0'), { recursive: true });
    registerKey(paths, 'old@mp', safePath.join(sibling, '1.0.0'));
    const kept = safePath.join(paths.pluginsCacheDir, 'mp2', 'other');
    const refuseSibling: FaultRule[] = [{ op: 'lstat', path: (p) => p === sibling, errno: 'EACCES' }];

    const { plan } = await underFaults(caseRoot(paths), { faults: refuseSibling }, () => planPluginUninstall({ pluginKeys: ['other@mp2'], paths }));
    expect(plan.changes.find((c) => c.change.dest === kept)).toMatchObject({ action: 'keep', reason: expect.stringContaining(sibling) as unknown });

    let touched: string[] = [];
    await underFaults(caseRoot(paths), { faults: refuseSibling }, async (session) => {
      await uninstallPlugin({ pluginKey: 'other@mp2', paths });
      touched = session.calls.filter((c) => (c.family === 'rename' || c.family === 'remove') && !relativeEscapesRoot(safePath.relative(kept, c.path))).map((c) => `${c.op} ${c.path}`);
    });
    expect(touched).toEqual([]);
    expect(existsSync(safePath.join(kept, '1.0.0', 'SKILL.md'))).toBe(true);
  });

  // Every keep-or-remove verdict is reached before the first removal: a refusal on the
  // target's own cache directory used to surface after its marketplace directory was deleted.
  it('refuses the target\'s own unexaminable directory before removing anything', async () => {
    const paths = getPaths();
    setupInstalledPlugin(paths, 'p', 'mp', '@test/pkg');
    const restore = refuseSyncFs('lstatSync', safePath.join(paths.pluginsCacheDir, 'mp', 'p'), 'EACCES');
    let thrown: unknown;
    try {
      await uninstallPlugin({ pluginKey: 'p@mp', paths });
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }

    expect(thrown, String(thrown)).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'refused' });
    expect(existsSync(safePath.join(paths.marketplacesDir, 'mp', 'plugins', 'p', 'SKILL.md'))).toBe(true);
  });
});

/** Run `body` while the OS's real path answers in backslashes — Windows' native spelling. */
async function withRealPathsIn<T>(backslashes: boolean, body: () => Promise<T>): Promise<T> {
  if (!backslashes) return body();
  const original = nodeFs.realpathSync.native;
  nodeFs.realpathSync.native = ((...args: Parameters<typeof original>) => String(original(...args)).replaceAll('/', '\\')) as typeof original;
  try {
    return await body();
  } finally {
    nodeFs.realpathSync.native = original;
  }
}

describe('uninstallPlugin with a key that is not two path segments', () => {
  const { getPaths } = setupPluginTestPaths();

  it('refuses before removing anything outside the Claude config dir', async () => {
    const paths = getPaths();
    // marketplaces/../../../victim — a sibling of the Claude config dir's plugins tree.
    const victim = safePath.join(paths.marketplacesDir, 'x', 'plugins', '..', '..', '..', 'victim');
    mkdirSyncReal(victim, { recursive: true });
    writeFileSync(safePath.join(victim, 'data.txt'), 'precious');

    await expect(uninstallPlugin({ pluginKey: '../../../victim@x', paths })).rejects.toMatchObject({ code: PLUGIN_KEY_INVALID_CODE });
    expect(readFileSync(safePath.join(victim, 'data.txt'), 'utf8')).toBe('precious');
  });
});

describe('parsePluginKey', () => {
  it('splits at the LAST @, so a plugin name keeps its own', () => {
    expect(parsePluginKey('a@b@mp')).toStrictEqual({ pluginName: 'a@b', marketplace: 'mp' });
  });

  // Each half is joined into ~/.claude and removed recursively: `../../../../../victim@x`
  // used to resolve outside the Claude config dir and be deleted as an "orphan".
  it.each([
    'no-marketplace', '@mp', 'p@',
    '../../../../../victim@x', '..@x', '.@x', 'p@..', 'p@.', 'a/b@mp', String.raw`a\b@mp`, 'p@m/n', '/abs@mp', 'C:evil@mp', '@scope/p@mp',
  ])('refuses %s with PLUGIN_KEY_INVALID', (key) => {
    let thrown: unknown;
    try {
      parsePluginKey(key);
    } catch (error) {
      thrown = error;
    }
    expect(isVatError(thrown, PLUGIN_KEY_INVALID_CODE), String(thrown)).toBe(true);
  });
});

describe('findPluginsByPackage', () => {
  const { getPaths } = setupPluginTestPaths();

  it('returns all plugin keys whose source.package matches', () => {
    const myPkg = '@test/my-pkg';
    const paths = getPaths();
    setupInstalledPlugin(paths, 'skill-a', 'market-a', myPkg);
    // setupInstalledPlugin overwrites files, so set up skill-b manually
    const pluginBKey = 'skill-b@market-b';
    const ip = JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8'));
    ip.plugins[pluginBKey] = [{ scope: 'user', installPath: '', version: '1.0.0', installedAt: '', lastUpdated: '' }];
    writeFileSync(paths.installedPluginsPath, JSON.stringify(ip));
    const km = JSON.parse(readFileSync(paths.knownMarketplacesPath, 'utf-8'));
    km['market-b'] = { source: { source: 'npm', package: myPkg }, installLocation: '', lastUpdated: '' };
    writeFileSync(paths.knownMarketplacesPath, JSON.stringify(km));

    const keys = findPluginsByPackage(myPkg, paths);
    expect(keys).toHaveLength(2);
    expect(keys).toContain('skill-a@market-a');
    expect(keys).toContain('skill-b@market-b');
  });

  it('returns empty array when no plugins match', () => {
    const keys = findPluginsByPackage('@test/other-pkg', getPaths());
    expect(keys).toHaveLength(0);
  });

  // The key was READ from Claude's registry, not typed: the registry is the input
  // at fault, and it is refused before any plugin is uninstalled.
  it('refuses a registry key of the package that is not a plugin key, coded as unreadable user state', () => {
    const myPkg = '@test/my-pkg';
    const paths = getPaths();
    setupInstalledPlugin(paths, 'skill-a', 'market-a', myPkg);
    const ip = JSON.parse(readFileSync(paths.installedPluginsPath, 'utf-8'));
    ip.plugins['../../victim@market-a'] = [];
    writeFileSync(paths.installedPluginsPath, JSON.stringify(ip));

    let error: unknown;
    try {
      findPluginsByPackage(myPkg, paths);
    } catch (caught) {
      error = caught;
    }

    expect(isVatError(error, CLAUDE_USER_STATE_UNREADABLE_CODE), String(error)).toBe(true);
    expect(String(error)).toContain('../../victim@market-a');
    expect(String(error)).toContain(paths.installedPluginsPath);
  });
});
