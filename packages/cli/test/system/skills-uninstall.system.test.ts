/**
 * System tests for claude plugin uninstall command
 * Tests removal of installed plugins from the Claude plugin registry
 */



import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createPackageAndHomeContext,
  createTempDirTracker,
  executeCli,
  fakeHomeEnv,
  fs,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-uninstall-test-';
const MARKETPLACE_NAME = 'test-marketplace';
const PLUGIN_NAME = 'test-plugin';
const SKILL_NAME = 'test-skill';
const PACKAGE_NAME = 'test-tools';
const PACKAGE_VERSION = '1.0.0';

const PLUGIN_JSON_FILE = 'plugin.json';
const CLAUDE_PLUGIN_SUBDIR = '.claude-plugin';

/** npm env vars that mimic a real global npm postinstall context */
const NPM_POSTINSTALL_ENV: Record<string, string> = {
  npm_config_global: 'true',
  npm_lifecycle_event: 'postinstall',
  npm_command: 'install',
};

function minimalSkillMd(skillName: string): string {
  return `---
name: ${skillName}
description: ${skillName} test skill
version: 1.0.0
---

# ${skillName}
`;
}

/**
 * Create a fake npm package with dist plugin tree ready for postinstall
 */
function createFakeNpmPackage(packageDir: string): void {
  writeTestFile(
    safePath.join(packageDir, 'package.json'),
    JSON.stringify({
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      vat: { version: '1.0', type: 'agent-bundle', skills: [SKILL_NAME] },
    })
  );

  // dist/.claude/plugins/marketplaces/<mp>/plugins/<plugin>/
  const pluginClaudeDir = safePath.join(
    packageDir, 'dist', '.claude', 'plugins', 'marketplaces',
    MARKETPLACE_NAME, 'plugins', PLUGIN_NAME, CLAUDE_PLUGIN_SUBDIR
  );
  mkdirSyncReal(pluginClaudeDir, { recursive: true });
  writeTestFile(
    safePath.join(pluginClaudeDir, PLUGIN_JSON_FILE),
    JSON.stringify({ name: PLUGIN_NAME, description: 'Test plugin', author: { name: 'Test Org' } })
  );

  // skills inside plugin
  const pluginSkillDir = safePath.join(
    packageDir, 'dist', '.claude', 'plugins', 'marketplaces',
    MARKETPLACE_NAME, 'plugins', PLUGIN_NAME, 'skills', SKILL_NAME
  );
  mkdirSyncReal(pluginSkillDir, { recursive: true });
  writeTestFile(safePath.join(pluginSkillDir, 'SKILL.md'), minimalSkillMd(SKILL_NAME));
}

function setupUninstallTestSuite() {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs: cleanup } = createTempDirTracker(TEMP_DIR_PREFIX);

  const createInstalledContext = () => {
    const tempDir = createTempDir();
    const { packageDir, fakeHome } = createPackageAndHomeContext(tempDir);
    createFakeNpmPackage(packageDir);

    // Install via postinstall to populate registry
    const installResult = executeCli(
      binPath,
      ['claude', 'plugin', 'install', '--npm-postinstall'],
      {
        cwd: packageDir,
        env: { ...NPM_POSTINSTALL_ENV, ...fakeHomeEnv(fakeHome) },
      }
    );
    return { packageDir, fakeHome, installResult };
  };

  const runUninstall = (
    fakeHome: string,
    args: string[],
    cwd?: string
  ) => executeCli(
    binPath,
    ['claude', 'plugin', 'uninstall', ...args],
    { cwd: cwd ?? process.cwd(), env: fakeHomeEnv(fakeHome) }
  );

  return { binPath, createInstalledContext, cleanup, runUninstall };
}

/**
 * Install a plugin and return context needed for uninstall tests.
 * Verifies install succeeded and plugin dir exists before returning.
 */
function setupInstalledPlugin(suite: ReturnType<typeof setupUninstallTestSuite>) {
  const { fakeHome, installResult } = suite.createInstalledContext();
  expect(installResult.status).toBe(0);
  const pluginDir = safePath.join(
    fakeHome, '.claude', 'plugins', 'marketplaces',
    MARKETPLACE_NAME, 'plugins', PLUGIN_NAME
  );
  expect(fs.existsSync(pluginDir)).toBe(true);
  const pluginKey = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
  return { fakeHome, pluginDir, pluginKey };
}

describe('claude plugin uninstall command (system test)', () => {
  const suite = setupUninstallTestSuite();

  afterEach(() => {
    suite.cleanup();
  });

  it('exits 0 and removes plugin files when given plugin@marketplace key', () => {
    const { fakeHome, pluginKey } = setupInstalledPlugin(suite);

    const result = suite.runUninstall(fakeHome, [pluginKey]);

    expect(result.status).toBe(0);
    const combined = result.stdout;
    expect(combined).toContain('status: success');
    expect(combined).toContain('pluginsRemoved: 1');
  });

  it('removes plugin directory from marketplacesDir after uninstall', () => {
    const { fakeHome, pluginDir, pluginKey } = setupInstalledPlugin(suite);

    suite.runUninstall(fakeHome, [pluginKey]);

    expect(fs.existsSync(pluginDir)).toBe(false);
  });

  it('removes plugin from installed_plugins.json after uninstall', () => {
    const { fakeHome, pluginKey } = setupInstalledPlugin(suite);

    const installedPath = safePath.join(fakeHome, '.claude', 'plugins', 'installed_plugins.json');
    const beforeUninstall = JSON.parse(fs.readFileSync(installedPath, 'utf-8')) as {
      plugins: Record<string, unknown[]>;
    };
    expect(beforeUninstall.plugins).toHaveProperty(pluginKey);

    suite.runUninstall(fakeHome, [pluginKey]);

    const afterUninstall = JSON.parse(fs.readFileSync(installedPath, 'utf-8')) as {
      plugins: Record<string, unknown[]>;
    };
    expect(afterUninstall.plugins).not.toHaveProperty(pluginKey);
  });

  it('exits 0 (idempotent) when plugin is not installed', () => {
    const { createTempDir } = createTempDirTracker(TEMP_DIR_PREFIX);
    const fakeHome = createTempDir();
    mkdirSyncReal(safePath.join(fakeHome, '.claude'), { recursive: true });

    const result = suite.runUninstall(fakeHome, ['nonexistent@nonexistent-market']);

    // idempotent — not installed is a valid no-op success
    expect(result.status).toBe(0);
  });

  it('exits 0 with pluginsRemoved: 0 when --all and nothing installed', () => {
    const { createTempDir } = createTempDirTracker(TEMP_DIR_PREFIX);
    const tempDir = createTempDir();
    const { fakeHome, packageDir } = createPackageAndHomeContext(tempDir);

    writeTestFile(
      safePath.join(packageDir, 'package.json'),
      JSON.stringify({ name: 'some-uninstalled-package', version: '1.0.0' })
    );

    const result = suite.runUninstall(fakeHome, ['--all'], packageDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pluginsRemoved: 0');
  });

  it('previews removal with --dry-run without deleting files', () => {
    const { fakeHome, pluginDir, pluginKey } = setupInstalledPlugin(suite);

    const result = suite.runUninstall(fakeHome, [pluginKey, '--dry-run']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status: success');
    // Plugin directory must still exist after dry-run
    expect(fs.existsSync(pluginDir)).toBe(true);
  });
});
