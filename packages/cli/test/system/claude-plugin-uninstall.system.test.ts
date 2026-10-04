// Test files legitimately use dynamic file paths

/**
 * System tests for `vat claude plugin uninstall` command.
 */

import { chmodSync, existsSync, readFileSync } from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { PLUGIN_UNINSTALL_REPORT_SCHEMA } from '../../src/commands/claude/plugin/uninstall-schema.js';

import {
  createTempDirTracker,
  executeCliAndParseYaml,
  fakeHomeEnv,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-plugin-uninstall-test-';

/**
 * Seed ~/.claude/ with a pre-installed plugin and all its registry artifacts.
 * Mirrors the state left by `vat claude plugin install` so uninstall has something to reverse.
 */
function setupInstalledPlugin(
  fakeHome: string,
  pluginName: string,
  marketplace: string,
  version = '1.0.0'
): void {
  const pluginKey = `${pluginName}@${marketplace}`;
  const claudeDir = safePath.join(fakeHome, '.claude');
  const pluginsDir = safePath.join(claudeDir, 'plugins');
  const mpPluginDir = safePath.join(pluginsDir, 'marketplaces', marketplace, 'plugins', pluginName);
  const cacheDir = safePath.join(pluginsDir, 'cache', marketplace, pluginName, version);

  mkdirSyncReal(mpPluginDir, { recursive: true });
  mkdirSyncReal(cacheDir, { recursive: true });

  writeTestFile(safePath.join(mpPluginDir, 'SKILL.md'), `# ${pluginName}`);
  writeTestFile(safePath.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      [pluginKey]: [
        { scope: 'user', installPath: cacheDir, version, installedAt: '', lastUpdated: '' },
      ],
    },
  }));
  writeTestFile(safePath.join(pluginsDir, 'known_marketplaces.json'), JSON.stringify({
    [marketplace]: {
      source: { source: 'npm', package: '@test/pkg', version },
      installLocation: '',
      lastUpdated: '',
    },
  }));
  writeTestFile(safePath.join(claudeDir, 'settings.json'), JSON.stringify({
    enabledPlugins: { [pluginKey]: true },
  }));
}

/** A fresh fake HOME holding an empty `.claude/`. */
function createUninstallTestHome(createTempDir: () => string): string {
  const fakeHome = safePath.join(createTempDir(), 'home');
  mkdirSyncReal(safePath.join(fakeHome, '.claude'), { recursive: true });
  return fakeHome;
}

/** Run `vat claude plugin uninstall <args>` under `fakeHome` and parse the report it publishes. */
async function runUninstall(
  binPath: string,
  fakeHome: string,
  args: string[],
): Promise<{ status: number | null; report: ReturnType<typeof PLUGIN_UNINSTALL_REPORT_SCHEMA.parse> }> {
  const { result, parsed } = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'uninstall', ...args], { env: fakeHomeEnv(fakeHome) });
  return { status: result.status, report: PLUGIN_UNINSTALL_REPORT_SCHEMA.parse(parsed) };
}

describe('claude plugin uninstall command (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs } = createTempDirTracker(TEMP_DIR_PREFIX);

  afterEach(() => {
    cleanupTempDirs();
  });

  it('uninstalls a plugin and removes all artifacts', async () => {
    const fakeHome = createUninstallTestHome(createTempDir);
    setupInstalledPlugin(fakeHome, 'my-skill', 'my-market');

    const { status, report } = await runUninstall(binPath, fakeHome, ['my-skill@my-market']);

    expect(status).toBe(0);
    expect(report.status).toBe('ok');
    expect(report.examined).toBe(1);
    expect(report.data).toStrictEqual({ dryRun: false, plugins: [{ key: 'my-skill@my-market', removed: true }] });
    expect(
      existsSync(safePath.join(fakeHome, '.claude', 'plugins', 'marketplaces', 'my-market', 'plugins', 'my-skill'))
    ).toBe(false);
  });

  it('is idempotent when plugin is not installed', async () => {
    const fakeHome = createUninstallTestHome(createTempDir);

    const { status, report } = await runUninstall(binPath, fakeHome, ['missing@market']);

    expect(status).toBe(0);
    expect(report.status).toBe('ok');
    expect(report.data?.plugins).toStrictEqual([{ key: 'missing@market', removed: false }]);
  });

  it('dry-run shows what would be removed without removing files', async () => {
    const fakeHome = createUninstallTestHome(createTempDir);
    setupInstalledPlugin(fakeHome, 'dry-skill', 'dry-market');

    const { status, report } = await runUninstall(binPath, fakeHome, ['dry-skill@dry-market', '--dry-run']);

    expect(status).toBe(0);
    expect(report.data).toStrictEqual({ dryRun: true, plugins: [{ key: 'dry-skill@dry-market', removed: true }] });
    // Files must still exist — dry-run must not remove anything
    expect(
      existsSync(safePath.join(fakeHome, '.claude', 'plugins', 'marketplaces', 'dry-market', 'plugins', 'dry-skill'))
    ).toBe(true);
  });

  it('uninstall of a half-removed plugin reports a PLUGIN_UNINSTALL_INCOMPLETE finding', async () => {
    const fakeHome = createUninstallTestHome(createTempDir);
    // The plugin directory is on disk, but no registry names it.
    mkdirSyncReal(safePath.join(fakeHome, '.claude', 'plugins', 'marketplaces', 'half-market', 'plugins', 'half-skill'), { recursive: true });

    const { status, report } = await runUninstall(binPath, fakeHome, ['half-skill@half-market']);

    // A warning: the cleanup ran, and the operator is told the install was not VAT's.
    expect(status).toBe(0);
    expect(report.status).toBe('findings');
    expect(report.findings).toMatchObject([{ code: 'PLUGIN_UNINSTALL_INCOMPLETE', severity: 'warning', location: 'half-skill@half-market' }]);
    expect(report.data?.plugins).toStrictEqual([{ key: 'half-skill@half-market', removed: true }]);
  });

  // Read-only modes are what this test needs; the same hosts that cannot deny a read cannot deny a write.
  it.skipIf(CANNOT_DENY_READS)('refuses a registry it could not rewrite as RUN_INCOMPLETE, never INTERNAL_ERROR', async () => {
    const fakeHome = createUninstallTestHome(createTempDir);
    setupInstalledPlugin(fakeHome, 'ro-skill', 'ro-market');
    const settingsPath = safePath.join(fakeHome, '.claude', 'settings.json');
    chmodSync(settingsPath, 0o444);
    try {
      const { status, report } = await runUninstall(binPath, fakeHome, ['ro-skill@ro-market']);

      expect(status).toBe(2);
      expect(report).toMatchObject({ status: 'error', error: { code: 'RUN_INCOMPLETE' } });
    } finally {
      chmodSync(settingsPath, 0o644);
    }
  });

  it('refuses with USAGE_INVALID when no plugin key given and --all not specified', async () => {
    const fakeHome = createUninstallTestHome(createTempDir);

    const { status, report } = await runUninstall(binPath, fakeHome, []);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
  });

  it.each(['no-marketplace', 'p@'])('refuses the key %s as USAGE_INVALID', async (key) => {
    const fakeHome = createUninstallTestHome(createTempDir);

    const { status, report } = await runUninstall(binPath, fakeHome, [key]);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
  });

  // --all used to ignore the operand and answer for the package in cwd: exit 0, plugins: [], and
  // the named plugin still installed.
  it('refuses a plugin key together with --all as USAGE_INVALID, removing nothing', async () => {
    const fakeHome = createUninstallTestHome(createTempDir);
    setupInstalledPlugin(fakeHome, 'real', 'mk');
    const projectDir = safePath.join(fakeHome, 'owns-nothing');
    mkdirSyncReal(projectDir, { recursive: true });
    writeTestFile(safePath.join(projectDir, 'package.json'), JSON.stringify({ name: '@test/owns-nothing', version: '1.0.0' }));

    const { result, parsed } = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'uninstall', 'real@mk', '--all'], { cwd: projectDir, env: fakeHomeEnv(fakeHome) });
    const report = PLUGIN_UNINSTALL_REPORT_SCHEMA.parse(parsed);

    expect(result.status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
    expect(report.error?.message).toContain('real@mk');
    expect(existsSync(safePath.join(fakeHome, '.claude', 'plugins', 'marketplaces', 'mk', 'plugins', 'real'))).toBe(true);
  });

  // The bad key was READ from Claude's registry: the operator typed nothing wrong. It is the
  // registry's fault (INPUT_UNREADABLE), and refused before any plugin is removed — it used to
  // be USAGE_INVALID mid-loop, after the plugins ahead of it were already gone.
  it('refuses --all over a registry key that is not a plugin key as INPUT_UNREADABLE, removing nothing', async () => {
    const fakeHome = createUninstallTestHome(createTempDir);
    setupInstalledPlugin(fakeHome, 'good-plugin', 'all-market');
    const registry = safePath.join(fakeHome, '.claude', 'plugins', 'installed_plugins.json');
    const installed = JSON.parse(readFileSync(registry, 'utf-8')) as { plugins: Record<string, unknown> };
    installed.plugins['../../victim@all-market'] = [];
    writeTestFile(registry, JSON.stringify(installed));
    const projectDir = safePath.join(fakeHome, 'project');
    mkdirSyncReal(projectDir, { recursive: true });
    writeTestFile(safePath.join(projectDir, 'package.json'), JSON.stringify({ name: '@test/pkg', version: '1.0.0' }));

    const { result, parsed } = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'uninstall', '--all'], { cwd: projectDir, env: fakeHomeEnv(fakeHome) });
    const report = PLUGIN_UNINSTALL_REPORT_SCHEMA.parse(parsed);

    expect(result.status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' } });
    expect(existsSync(safePath.join(fakeHome, '.claude', 'plugins', 'marketplaces', 'all-market', 'plugins', 'good-plugin'))).toBe(true);
  });
});
