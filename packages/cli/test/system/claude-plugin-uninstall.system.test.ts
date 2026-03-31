/* eslint-disable security/detect-non-literal-fs-filename */
// Test files legitimately use dynamic file paths

/**
 * System tests for `vat claude plugin uninstall` command.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

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
  const claudeDir = join(fakeHome, '.claude');
  const pluginsDir = join(claudeDir, 'plugins');
  const mpPluginDir = join(pluginsDir, 'marketplaces', marketplace, 'plugins', pluginName);
  const cacheDir = join(pluginsDir, 'cache', marketplace, pluginName, version);

  mkdirSyncReal(mpPluginDir, { recursive: true });
  mkdirSyncReal(cacheDir, { recursive: true });

  writeTestFile(join(mpPluginDir, 'SKILL.md'), `# ${pluginName}`);
  writeTestFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      [pluginKey]: [
        { scope: 'user', installPath: cacheDir, version, installedAt: '', lastUpdated: '' },
      ],
    },
  }));
  writeTestFile(join(pluginsDir, 'known_marketplaces.json'), JSON.stringify({
    [marketplace]: {
      source: { source: 'npm', package: '@test/pkg', version },
      installLocation: '',
      lastUpdated: '',
    },
  }));
  writeTestFile(join(claudeDir, 'settings.json'), JSON.stringify({
    enabledPlugins: { [pluginKey]: true },
  }));
}

describe('claude plugin uninstall command (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs } = createTempDirTracker(TEMP_DIR_PREFIX);

  afterEach(() => {
    cleanupTempDirs();
  });

  it('uninstalls a plugin and removes all artifacts', () => {
    const tempDir = createTempDir();
    const fakeHome = join(tempDir, 'home');
    mkdirSyncReal(fakeHome, { recursive: true });
    setupInstalledPlugin(fakeHome, 'my-skill', 'my-market');

    const { result, parsed } = executeCliAndParseYaml(binPath, [
      'claude', 'plugin', 'uninstall', 'my-skill@my-market',
    ], { env: fakeHomeEnv(fakeHome) });

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.pluginsRemoved).toBe(1);
    expect(
      existsSync(join(fakeHome, '.claude', 'plugins', 'marketplaces', 'my-market', 'plugins', 'my-skill'))
    ).toBe(false);
  });

  it('is idempotent when plugin is not installed', () => {
    const tempDir = createTempDir();
    const fakeHome = join(tempDir, 'home');
    mkdirSyncReal(join(fakeHome, '.claude'), { recursive: true });

    const { result, parsed } = executeCliAndParseYaml(binPath, [
      'claude', 'plugin', 'uninstall', 'missing@market',
    ], { env: fakeHomeEnv(fakeHome) });

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.pluginsRemoved).toBe(0);
  });

  it('dry-run shows what would be removed without removing files', () => {
    const tempDir = createTempDir();
    const fakeHome = join(tempDir, 'home');
    mkdirSyncReal(fakeHome, { recursive: true });
    setupInstalledPlugin(fakeHome, 'dry-skill', 'dry-market');

    const { result, parsed } = executeCliAndParseYaml(binPath, [
      'claude', 'plugin', 'uninstall', 'dry-skill@dry-market', '--dry-run',
    ], { env: fakeHomeEnv(fakeHome) });

    expect(result.status).toBe(0);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.pluginsRemoved).toBe(1);
    // Files must still exist — dry-run must not remove anything
    expect(
      existsSync(join(fakeHome, '.claude', 'plugins', 'marketplaces', 'dry-market', 'plugins', 'dry-skill'))
    ).toBe(true);
  });

  it('fails with non-zero exit code when no plugin key given and --all not specified', () => {
    const tempDir = createTempDir();
    const fakeHome = join(tempDir, 'home');
    mkdirSyncReal(fakeHome, { recursive: true });

    const { result } = executeCliAndParseYaml(binPath, [
      'claude', 'plugin', 'uninstall',
    ], { env: fakeHomeEnv(fakeHome) });

    // Plugin key is required; command exits with error (code 2 = system/unexpected error)
    expect(result.status).not.toBe(0);
  });
});
