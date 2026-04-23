/* eslint-disable security/detect-non-literal-fs-filename */
// Test fixtures legitimately use dynamic file paths

/**
 * System tests for `vat claude plugin install --npm-postinstall` plugin registry flow.
 *
 * Verifies that the postinstall handler correctly:
 * - Finds dist/.claude/plugins/marketplaces/ directory tree in cwd
 * - Copies plugin files to Claude's plugin dirs
 * - Updates known_marketplaces.json and installed_plugins.json registry files
 * - Exits 0 and emits guidance when no plugin tree is present
 */

import { existsSync, readFileSync } from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createPackageAndHomeContext,
  createTempDirTracker,
  executeCli,
  fakeHomeEnv,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-postinstall-registry-test-';
const PACKAGE_NAME = 'acme-tools';
const PACKAGE_VERSION = '2.3.4';
const MARKETPLACE_NAME = 'acme-marketplace';
const PLUGIN_NAME = 'acme-plugin';
const SKILL_NAME = 'acme-skill';

// Fixture path/type literal constants (extracted to satisfy sonarjs/no-duplicate-string)
const PACKAGE_JSON_FILE = 'package.json';
const PLUGIN_JSON_FILE = 'plugin.json';
const CLAUDE_PLUGIN_SUBDIR = '.claude-plugin';

/** npm env vars that mimic a real global npm postinstall context */
const NPM_POSTINSTALL_ENV: Record<string, string> = {
  npm_config_global: 'true',
  npm_lifecycle_event: 'postinstall',
  npm_command: 'install',
};

/**
 * Minimal SKILL.md content — enough to satisfy the postinstall install path.
 */
function minimalSkillMd(skillName: string): string {
  return `---
name: ${skillName}
description: ${skillName} - comprehensive test skill for postinstall registry flow
version: 1.0.0
---

# ${skillName}

This is a test skill for the postinstall registry test.
`;
}

/**
 * Create a minimal package.json with vat skills metadata and built skill artifacts.
 */
function createBasePackageWithSkill(
  packageDir: string,
  opts: { packageName: string; version: string; skillName: string }
): void {
  const { packageName, version, skillName } = opts;

  writeTestFile(
    safePath.join(packageDir, PACKAGE_JSON_FILE),
    JSON.stringify({
      name: packageName,
      version,
      vat: {
        version: '1.0',
        type: 'agent-bundle',
        skills: [skillName],
      },
    })
  );

  const skillDistDir = safePath.join(packageDir, 'dist', 'skills', skillName);
  mkdirSyncReal(skillDistDir, { recursive: true });
  writeTestFile(safePath.join(skillDistDir, 'SKILL.md'), minimalSkillMd(skillName));
}

/**
 * Build all fixture files for a fake installed npm package that has:
 * - package.json with vat metadata
 * - dist/skills/<skill>/ with SKILL.md
 * - dist/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/ with .claude-plugin/plugin.json and skills/
 *
 * This matches the new output structure from vat claude build.
 */
function createFakeNpmPackage(
  packageDir: string,
  opts: {
    packageName: string;
    version: string;
    marketplaceName: string;
    pluginName: string;
    skillName: string;
  }
): void {
  const { marketplaceName, pluginName, skillName, packageName, version } = opts;

  createBasePackageWithSkill(packageDir, { packageName, version, skillName });

  // New dist structure: dist/.claude/plugins/marketplaces/<mp>/plugins/<plugin>/
  const pluginDir = safePath.join(
    packageDir, 'dist', '.claude', 'plugins', 'marketplaces',
    marketplaceName, 'plugins', pluginName
  );

  // .claude-plugin/plugin.json
  const pluginClaudeDir = safePath.join(pluginDir, CLAUDE_PLUGIN_SUBDIR);
  mkdirSyncReal(pluginClaudeDir, { recursive: true });
  writeTestFile(
    safePath.join(pluginClaudeDir, PLUGIN_JSON_FILE),
    JSON.stringify({
      name: pluginName,
      description: 'Test plugin for postinstall',
      author: { name: 'Test Org' },
    })
  );

  // skills/<skillName>/SKILL.md inside plugin
  const pluginSkillDir = safePath.join(pluginDir, 'skills', skillName);
  mkdirSyncReal(pluginSkillDir, { recursive: true });
  writeTestFile(safePath.join(pluginSkillDir, 'SKILL.md'), minimalSkillMd(skillName));
}

/** Context object for tests that need isolated packageDir + fakeHome. */
interface RegistryTestContext {
  packageDir: string;
  fakeHome: string;
}

/**
 * Set up the test suite — returns helper factory and cleanup.
 */
function setupPostinstallRegistryTestSuite() {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs: cleanup } = createTempDirTracker(TEMP_DIR_PREFIX);

  /**
   * Create an isolated packageDir + fakeHome inside a fresh temp dir.
   */
  const createTestContext = (): RegistryTestContext => {
    const tempDir = createTempDir();
    return createPackageAndHomeContext(tempDir);
  };

  /**
   * Create test context with a full fake npm package (skills + plugin artifacts).
   */
  const createFullPackageContext = (): RegistryTestContext => {
    const ctx = createTestContext();
    createFakeNpmPackage(ctx.packageDir, {
      packageName: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      marketplaceName: MARKETPLACE_NAME,
      pluginName: PLUGIN_NAME,
      skillName: SKILL_NAME,
    });
    return ctx;
  };

  /**
   * Run `vat claude plugin install --npm-postinstall` with a fake Claude home.
   */
  const runPostinstall = async (packageDir: string, fakeHome: string, extraArgs: string[] = []) => {
    return executeCli(binPath, ['claude', 'plugin', 'install', '--npm-postinstall', ...extraArgs], {
      cwd: packageDir,
      env: { ...NPM_POSTINSTALL_ENV, ...fakeHomeEnv(fakeHome) },
    });
  };

  return { binPath, createTestContext, createFullPackageContext, cleanup, runPostinstall };
}

describe('claude plugin install --npm-postinstall plugin registry (system test)', () => {
  const suite = setupPostinstallRegistryTestSuite();

  afterEach(() => {
    suite.cleanup();
  });

  describe('when dist/.claude/plugins/marketplaces/ exists', () => {
    it('exits 0 and registers plugin in known_marketplaces.json', async () => {
      const { packageDir, fakeHome } = suite.createFullPackageContext();
      const result = await suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);

      const knownPath = safePath.join(fakeHome, '.claude', 'plugins', 'known_marketplaces.json');
      expect(existsSync(knownPath)).toBe(true);
      const known = JSON.parse(readFileSync(knownPath, 'utf-8')) as Record<string, unknown>;
      expect(known).toHaveProperty(MARKETPLACE_NAME);
    });

    it('exits 0 and records plugin in installed_plugins.json', async () => {
      const { packageDir, fakeHome } = suite.createFullPackageContext();
      const result = await suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);

      const installedPath = safePath.join(fakeHome, '.claude', 'plugins', 'installed_plugins.json');
      expect(existsSync(installedPath)).toBe(true);
      const installed = JSON.parse(readFileSync(installedPath, 'utf-8')) as {
        version: number;
        plugins: Record<string, unknown[]>;
      };
      const pluginKey = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
      expect(installed.plugins).toHaveProperty(pluginKey);
      expect(installed.plugins[pluginKey]).toHaveLength(1);
    });

    it('exits 0 and enables plugin in user settings.json', async () => {
      const { packageDir, fakeHome } = suite.createFullPackageContext();
      const result = await suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);

      const settingsPath = safePath.join(fakeHome, '.claude', 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        enabledPlugins?: Record<string, boolean>;
      };
      const pluginKey = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
      expect(settings.enabledPlugins).toHaveProperty(pluginKey, true);
    });

    it('exits 0 and copies plugin files to marketplacesDir', async () => {
      const { packageDir, fakeHome } = suite.createFullPackageContext();
      const result = await suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);

      const marketplacePluginDest = safePath.join(
        fakeHome,
        '.claude',
        'plugins',
        'marketplaces',
        MARKETPLACE_NAME,
        'plugins',
        PLUGIN_NAME,
        CLAUDE_PLUGIN_SUBDIR,
        PLUGIN_JSON_FILE
      );
      expect(existsSync(marketplacePluginDest)).toBe(true);
    });

    it('exits 0 and copies plugin files to pluginsCacheDir', async () => {
      const { packageDir, fakeHome } = suite.createFullPackageContext();
      const result = await suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);

      const cacheDest = safePath.join(
        fakeHome,
        '.claude',
        'plugins',
        'cache',
        MARKETPLACE_NAME,
        PLUGIN_NAME,
        PACKAGE_VERSION,
        CLAUDE_PLUGIN_SUBDIR,
        PLUGIN_JSON_FILE
      );
      expect(existsSync(cacheDest)).toBe(true);
    });

    it('skips when plugin tree has no plugin subdirectories and still exits 0', async () => {
      const { packageDir, fakeHome } = suite.createTestContext();

      createBasePackageWithSkill(packageDir, {
        packageName: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        skillName: SKILL_NAME,
      });

      // Create marketplace dir without any plugin subdirectories
      const mpDir = safePath.join(
        packageDir, 'dist', '.claude', 'plugins', 'marketplaces', MARKETPLACE_NAME
      );
      mkdirSyncReal(mpDir, { recursive: true });
      // NOTE: no plugins/ subdirectory — test that this doesn't crash

      const result = await suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);
      // No registry files should have been created since no plugins exist
      const knownPath = safePath.join(fakeHome, '.claude', 'plugins', 'known_marketplaces.json');
      expect(existsSync(knownPath)).toBe(false);
    });

    it('removes stale skills from marketplace dir when reinstalled with fewer skills', async () => {
      const { packageDir: v1Dir, fakeHome } = suite.createTestContext();
      const EXTRA_SKILL = 'acme-skill-extra';

      // v1: base package with SKILL_NAME + EXTRA_SKILL in the plugin tree
      createFakeNpmPackage(v1Dir, {
        packageName: PACKAGE_NAME,
        version: '1.0.0',
        marketplaceName: MARKETPLACE_NAME,
        pluginName: PLUGIN_NAME,
        skillName: SKILL_NAME,
      });
      const extraSkillDir = safePath.join(
        v1Dir, 'dist', '.claude', 'plugins', 'marketplaces',
        MARKETPLACE_NAME, 'plugins', PLUGIN_NAME, 'skills', EXTRA_SKILL
      );
      mkdirSyncReal(extraSkillDir, { recursive: true });
      writeTestFile(safePath.join(extraSkillDir, 'SKILL.md'), minimalSkillMd(EXTRA_SKILL));

      // Install v1 — both skills land in the marketplace dir
      const v1Result = await suite.runPostinstall(v1Dir, fakeHome);
      expect(v1Result.status).toBe(0);

      const pluginSkillsDir = safePath.join(
        fakeHome, '.claude', 'plugins', 'marketplaces',
        MARKETPLACE_NAME, 'plugins', PLUGIN_NAME, 'skills'
      );
      expect(existsSync(safePath.join(pluginSkillsDir, SKILL_NAME))).toBe(true);
      expect(existsSync(safePath.join(pluginSkillsDir, EXTRA_SKILL))).toBe(true);

      // v2: package with only SKILL_NAME — EXTRA_SKILL has been removed
      const v2Dir = safePath.join(fakeHome, '..', 'v2-package');
      mkdirSyncReal(v2Dir, { recursive: true });
      createFakeNpmPackage(v2Dir, {
        packageName: PACKAGE_NAME,
        version: '2.0.0',
        marketplaceName: MARKETPLACE_NAME,
        pluginName: PLUGIN_NAME,
        skillName: SKILL_NAME,
      });

      // Reinstall via v2 against the same Claude installation (same fakeHome)
      const v2Result = await suite.runPostinstall(v2Dir, fakeHome);
      expect(v2Result.status).toBe(0);

      // SKILL_NAME must still be present
      expect(existsSync(safePath.join(pluginSkillsDir, SKILL_NAME))).toBe(true);
      // EXTRA_SKILL must be gone — stale files from the previous version must not persist
      expect(existsSync(safePath.join(pluginSkillsDir, EXTRA_SKILL))).toBe(false);
    });
  });

  describe('when dist/.claude/plugins/marketplaces/ does NOT exist', () => {
    it('exits 0 and emits guidance message about running vat build', async () => {
      const { packageDir, fakeHome } = suite.createTestContext();
      createBasePackageWithSkill(packageDir, {
        packageName: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        skillName: SKILL_NAME,
      });
      // dist/.claude/plugins/marketplaces/ is intentionally absent

      const result = await suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('vat build');
    });

    it('exits 0 and mentions dist/.claude/plugins/marketplaces/ in output', async () => {
      const { packageDir, fakeHome } = suite.createTestContext();
      createBasePackageWithSkill(packageDir, {
        packageName: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        skillName: SKILL_NAME,
      });

      const result = await suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('dist/.claude/plugins/marketplaces/');
    });
  });
});
