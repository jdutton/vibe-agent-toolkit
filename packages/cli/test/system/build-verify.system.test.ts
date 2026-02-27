/* eslint-disable security/detect-non-literal-fs-filename -- All file paths are in temp directories controlled by tests */
/**
 * System tests for vat build and vat verify commands (with --cwd flag)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, afterEach } from 'vitest';

import {
  createSkillMarkdown,
  createSkillsPackageJson,
  createTempDirTracker,
  executeCli,
  getBinPath,
  writeTestFile,
  type TestVatSkill,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-build-verify-test-';
const PACKAGE_JSON_FILENAME = 'package.json';
const PACKAGE_NAME = 'test-package';
const TEST_SKILL_NAME = 'test-skill';
const SKILL_SOURCE_PATH = './resources/skills/SKILL.md';
const SKILL_DIST_PATH = './dist/skills/test-skill';
const MARKETPLACE_NAME = 'test-tools';
const PLUGIN_NAME = 'test-plugin';
const VAT_CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
const DIST_SKILLS_DIR = join('dist', 'skills');
const DIST_CLAUDE_PLUGIN_DIR = join('dist', '.claude-plugin');
const DIST_PLUGINS_DIR = join('dist', 'plugins');
const MARKETPLACE_JSON = join(DIST_CLAUDE_PLUGIN_DIR, 'marketplace.json');

/**
 * Write a vibe-agent-toolkit.config.yaml with a minimal claude marketplace config
 */
function createVatConfig(
  dir: string,
  marketplaceName: string,
  pluginName: string,
  skillSelector: string
): void {
  const content = `version: 1
claude:
  marketplaces:
    ${marketplaceName}:
      owner:
        name: Test Org
      skills:
        - "${skillSelector}"
      plugins:
        - name: ${pluginName}
          skills: "*"
      output:
        marketplaceJson: dist/.claude-plugin/marketplace.json
        pluginsDir: dist/plugins/
`;
  writeTestFile(join(dir, VAT_CONFIG_FILENAME), content);
}

/**
 * Setup common test fixtures for build/verify tests
 */
function setupBuildVerifyTestSuite() {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs: cleanup } = createTempDirTracker(TEMP_DIR_PREFIX);

  const createSkillSource = (tempDir: string, relativePath: string, skillName: string) => {
    const resourcesDir = join(tempDir, relativePath, '..');
    mkdirSyncReal(resourcesDir, { recursive: true });
    writeTestFile(join(tempDir, relativePath), createSkillMarkdown(skillName));
  };

  const setupSingleSkillFixture = (
    tempDir: string,
    marketplaceName: string,
    pluginName: string,
    skills: TestVatSkill[] = [{ name: TEST_SKILL_NAME, source: SKILL_SOURCE_PATH, path: SKILL_DIST_PATH }]
  ) => {
    writeTestFile(join(tempDir, PACKAGE_JSON_FILENAME), createSkillsPackageJson(PACKAGE_NAME, skills));
    createSkillSource(tempDir, SKILL_SOURCE_PATH, TEST_SKILL_NAME);
    createVatConfig(tempDir, marketplaceName, pluginName, TEST_SKILL_NAME);
  };

  const runBuild = (tempDir: string, extraArgs: string[] = []) => {
    return executeCli(binPath, ['--cwd', tempDir, 'build', ...extraArgs]);
  };

  const runVerify = (tempDir: string, extraArgs: string[] = []) => {
    return executeCli(binPath, ['--cwd', tempDir, 'verify', ...extraArgs]);
  };

  return {
    binPath,
    createTempDir,
    cleanup,
    createSkillSource,
    setupSingleSkillFixture,
    runBuild,
    runVerify,
  };
}

describe('vat build command (system test)', () => {
  const suite = setupBuildVerifyTestSuite();

  afterEach(() => {
    suite.cleanup();
  });

  it('should build skills and claude artifacts using --cwd flag', () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillFixture(tempDir, MARKETPLACE_NAME, PLUGIN_NAME);

    const result = suite.runBuild(tempDir);

    expect(result.status).toBe(0);
    expect(existsSync(join(tempDir, DIST_SKILLS_DIR, TEST_SKILL_NAME, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tempDir, MARKETPLACE_JSON))).toBe(true);
    expect(existsSync(join(tempDir, DIST_PLUGINS_DIR, PLUGIN_NAME))).toBe(true);

    // Verify marketplace.json contains the marketplace name
    const marketplaceJson = JSON.parse(
      readFileSync(join(tempDir, MARKETPLACE_JSON), 'utf-8')
    ) as { name: string };
    expect(marketplaceJson.name).toBe(MARKETPLACE_NAME);
  });

  it('should build --only skills when no claude config', () => {
    const tempDir = suite.createTempDir();
    // Only package.json and SKILL.md, no config file
    writeTestFile(
      join(tempDir, PACKAGE_JSON_FILENAME),
      createSkillsPackageJson(PACKAGE_NAME, [
        { name: TEST_SKILL_NAME, source: SKILL_SOURCE_PATH, path: SKILL_DIST_PATH },
      ])
    );
    suite.createSkillSource(tempDir, SKILL_SOURCE_PATH, TEST_SKILL_NAME);

    const result = suite.runBuild(tempDir, ['--only', 'skills']);

    expect(result.status).toBe(0);
    expect(existsSync(join(tempDir, DIST_SKILLS_DIR, TEST_SKILL_NAME, 'SKILL.md'))).toBe(true);
  });

  it('should fail build when skill source missing', () => {
    const tempDir = suite.createTempDir();
    // package.json references a skill with missing source file
    writeTestFile(
      join(tempDir, PACKAGE_JSON_FILENAME),
      createSkillsPackageJson(PACKAGE_NAME, [
        { name: TEST_SKILL_NAME, source: SKILL_SOURCE_PATH, path: SKILL_DIST_PATH },
      ])
    );
    createVatConfig(tempDir, MARKETPLACE_NAME, PLUGIN_NAME, TEST_SKILL_NAME);
    // Intentionally NOT creating the skill source file

    const result = suite.runBuild(tempDir);

    expect(result.status).not.toBe(0);
  });
});

describe('vat verify command (system test)', () => {
  const suite = setupBuildVerifyTestSuite();

  afterEach(() => {
    suite.cleanup();
  });

  /**
   * Set up a temp dir with a complete fixture, build it, and return the tempDir.
   * Shared setup for tests that need pre-built artifacts.
   */
  function setupBuiltFixture(): string {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillFixture(tempDir, MARKETPLACE_NAME, PLUGIN_NAME);
    const buildResult = suite.runBuild(tempDir);
    expect(buildResult.status).toBe(0);
    return tempDir;
  }

  it('should verify all phases pass when artifacts are valid', () => {
    const tempDir = setupBuiltFixture();

    const result = suite.runVerify(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status: success');
  });

  it('should verify --only claude passes with valid marketplace.json', () => {
    const tempDir = setupBuiltFixture();

    const result = suite.runVerify(tempDir, ['--only', 'claude']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status: success');
  });

  it('should verify --only claude fails when marketplace.json is missing', () => {
    const tempDir = suite.createTempDir();
    // Set up config but do NOT run build (no artifacts)
    writeTestFile(
      join(tempDir, PACKAGE_JSON_FILENAME),
      createSkillsPackageJson(PACKAGE_NAME, [
        { name: TEST_SKILL_NAME, source: SKILL_SOURCE_PATH, path: SKILL_DIST_PATH },
      ])
    );
    createVatConfig(tempDir, MARKETPLACE_NAME, PLUGIN_NAME, TEST_SKILL_NAME);
    // Intentionally NOT running build, so no dist/ artifacts exist

    const result = suite.runVerify(tempDir, ['--only', 'claude']);

    expect(result.status).toBe(1);
  });
});
