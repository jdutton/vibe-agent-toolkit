/* eslint-disable security/detect-non-literal-fs-filename */
// Test fixtures legitimately use dynamic file paths

/**
 * System tests for `vat skills install --npm-postinstall` plugin registry flow.
 *
 * Verifies that `tryInstallPluginRegistry` correctly:
 * - Finds dist/.claude-plugin/marketplace.json in cwd
 * - Copies plugin files to Claude's plugin dirs
 * - Updates known_marketplaces.json and installed_plugins.json registry files
 * - Exits 0 and emits guidance when no marketplace.json is present
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempDirTracker,
  executeCli,
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
const VAT_AGENT_BUNDLE_TYPE = 'agent-bundle';

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
 * Used as the base for both the full marketplace fixture and the no-marketplace fixture.
 */
function createBasePackageWithSkill(
  packageDir: string,
  opts: { packageName: string; version: string; skillName: string }
): void {
  const { packageName, version, skillName } = opts;

  writeTestFile(
    join(packageDir, PACKAGE_JSON_FILE),
    JSON.stringify({
      name: packageName,
      version,
      vat: {
        version: '1.0',
        type: VAT_AGENT_BUNDLE_TYPE,
        skills: [
          {
            name: skillName,
            source: `./resources/skills/${skillName}.md`,
            path: `./dist/skills/${skillName}`,
          },
        ],
      },
    })
  );

  const skillDistDir = join(packageDir, 'dist', 'skills', skillName);
  mkdirSyncReal(skillDistDir, { recursive: true });
  writeTestFile(join(skillDistDir, 'SKILL.md'), minimalSkillMd(skillName));
}

/**
 * Build all fixture files for a fake installed npm package that has:
 * - package.json with vat metadata
 * - dist/skills/<skill>/ with SKILL.md
 * - dist/.claude-plugin/marketplace.json
 * - dist/plugins/<plugin>/ with .claude-plugin/plugin.json
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

  const marketplaceDir = join(packageDir, 'dist', CLAUDE_PLUGIN_SUBDIR);
  mkdirSyncReal(marketplaceDir, { recursive: true });
  writeTestFile(
    join(marketplaceDir, 'marketplace.json'),
    JSON.stringify({
      name: marketplaceName,
      plugins: [
        {
          name: pluginName,
          source: `../plugins/${pluginName}`,
          skills: [`skills/${skillName}`],
        },
      ],
    })
  );

  const pluginClaudeDir = join(packageDir, 'dist', 'plugins', pluginName, CLAUDE_PLUGIN_SUBDIR);
  mkdirSyncReal(pluginClaudeDir, { recursive: true });
  writeTestFile(
    join(pluginClaudeDir, PLUGIN_JSON_FILE),
    JSON.stringify({
      type: 'plugin',
      name: pluginName,
      skills: [skillName],
    })
  );
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
   * Keeps each test's filesystem state fully independent.
   */
  const createTestContext = (): RegistryTestContext => {
    const tempDir = createTempDir();
    const packageDir = join(tempDir, 'package');
    const fakeHome = join(tempDir, 'home');
    mkdirSyncReal(packageDir, { recursive: true });
    mkdirSyncReal(fakeHome, { recursive: true });
    return { packageDir, fakeHome };
  };

  /**
   * Create test context with a full fake npm package (skills + marketplace + plugin artifacts).
   * Eliminates per-test boilerplate for the common case.
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
   * Run `vat skills install --npm-postinstall` with a fake Claude home.
   * `HOME` is overridden so homedir() → fakeHome, keeping real ~/.claude untouched.
   * The npm postinstall env vars make isGlobalNpmInstall() return true.
   */
  const runPostinstall = (packageDir: string, fakeHome: string, extraArgs: string[] = []) => {
    return executeCli(binPath, ['skills', 'install', '--npm-postinstall', ...extraArgs], {
      cwd: packageDir,
      env: {
        ...NPM_POSTINSTALL_ENV,
        HOME: fakeHome,
        // Windows: os.homedir() reads USERPROFILE (not HOME), so set both to
        // ensure the fake home directory is used on all platforms.
        USERPROFILE: fakeHome,
      },
    });
  };

  return { binPath, createTestContext, createFullPackageContext, cleanup, runPostinstall };
}

describe('skills install --npm-postinstall plugin registry (system test)', () => {
  const suite = setupPostinstallRegistryTestSuite();

  afterEach(() => {
    suite.cleanup();
  });

  describe('when dist/.claude-plugin/marketplace.json exists', () => {
    it('exits 0 and registers plugin in known_marketplaces.json', () => {
      const { packageDir, fakeHome } = suite.createFullPackageContext();
      const result = suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);

      const knownPath = join(fakeHome, '.claude', 'plugins', 'known_marketplaces.json');
      expect(existsSync(knownPath)).toBe(true);
      const known = JSON.parse(readFileSync(knownPath, 'utf-8')) as Record<string, unknown>;
      expect(known).toHaveProperty(MARKETPLACE_NAME);
    });

    it('exits 0 and records plugin in installed_plugins.json', () => {
      const { packageDir, fakeHome } = suite.createFullPackageContext();
      const result = suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);

      const installedPath = join(fakeHome, '.claude', 'plugins', 'installed_plugins.json');
      expect(existsSync(installedPath)).toBe(true);
      const installed = JSON.parse(readFileSync(installedPath, 'utf-8')) as {
        version: number;
        plugins: Record<string, unknown[]>;
      };
      const pluginKey = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
      expect(installed.plugins).toHaveProperty(pluginKey);
      expect(installed.plugins[pluginKey]).toHaveLength(1);
    });

    it('exits 0 and enables plugin in user settings.json', () => {
      const { packageDir, fakeHome } = suite.createFullPackageContext();
      const result = suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);

      const settingsPath = join(fakeHome, '.claude', 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        enabledPlugins?: Record<string, boolean>;
      };
      const pluginKey = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
      expect(settings.enabledPlugins).toHaveProperty(pluginKey, true);
    });

    it('exits 0 and copies plugin files to marketplacesDir', () => {
      const { packageDir, fakeHome } = suite.createFullPackageContext();
      const result = suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);

      const marketplacePluginDest = join(
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

    it('exits 0 and copies plugin files to pluginsCacheDir', () => {
      const { packageDir, fakeHome } = suite.createFullPackageContext();
      const result = suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);

      const cacheDest = join(
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

    it('skips missing plugin dir and still exits 0', () => {
      const { packageDir, fakeHome } = suite.createTestContext();

      createBasePackageWithSkill(packageDir, {
        packageName: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        skillName: SKILL_NAME,
      });

      const marketplaceDir = join(packageDir, 'dist', CLAUDE_PLUGIN_SUBDIR);
      mkdirSyncReal(marketplaceDir, { recursive: true });
      writeTestFile(
        join(marketplaceDir, 'marketplace.json'),
        JSON.stringify({
          name: MARKETPLACE_NAME,
          plugins: [{ name: 'missing-plugin', source: '../plugins/missing-plugin', skills: [] }],
        })
      );
      // NOTE: dist/plugins/missing-plugin/ is intentionally NOT created

      const result = suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);
      // No registry files should have been created since plugin dir is missing
      const knownPath = join(fakeHome, '.claude', 'plugins', 'known_marketplaces.json');
      expect(existsSync(knownPath)).toBe(false);
    });
  });

  describe('when dist/.claude-plugin/marketplace.json does NOT exist', () => {
    it('exits 0 and emits guidance message about running vat build', () => {
      const { packageDir, fakeHome } = suite.createTestContext();
      createBasePackageWithSkill(packageDir, {
        packageName: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        skillName: SKILL_NAME,
      });
      // dist/.claude-plugin/ is intentionally absent

      const result = suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('vat build');
    });

    it('exits 0 and mentions dist/.claude-plugin/marketplace.json in output', () => {
      const { packageDir, fakeHome } = suite.createTestContext();
      createBasePackageWithSkill(packageDir, {
        packageName: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        skillName: SKILL_NAME,
      });

      const result = suite.runPostinstall(packageDir, fakeHome);

      expect(result.status).toBe(0);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('dist/.claude-plugin/marketplace.json');
    });
  });
});
