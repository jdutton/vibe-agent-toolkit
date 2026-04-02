/* eslint-disable security/detect-non-literal-fs-filename -- All file paths are in temp directories controlled by tests */
/**
 * System tests for vat build and vat verify commands (with --cwd flag)
 *
 * vat build runs: skills build → produces dist/skills/<name>/SKILL.md
 * Claude plugin artifacts (dist/.claude/...) are built separately by the
 * package author's own build tooling; vat build no longer includes a claude phase.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, afterEach } from 'vitest';

import {
  createSkillMarkdown,
  createSkillsConfigYaml,
  createTempDirTracker,
  executeCli,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-build-verify-test-';
const TEST_SKILL_NAME = 'test-skill';
const MARKETPLACE_NAME = 'test-tools';
const PLUGIN_NAME = 'test-plugin';
const VAT_CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
const DIST_SKILLS_DIR = join('dist', 'skills');
const SKILL_INCLUDE_GLOB = 'resources/skills/**/SKILL.md';
const SKILL_SOURCE_PATH = 'resources/skills/SKILL.md';

/**
 * Write a vibe-agent-toolkit.config.yaml with skills + claude marketplace config
 */
function createVatConfig(
  dir: string,
  marketplaceName: string,
  pluginName: string,
  skillSelector: string,
  skillIncludeGlobs: string[] = [SKILL_INCLUDE_GLOB]
): void {
  // skills field accepts "*" literal or an array of selectors
  const skillsYaml = skillSelector === '*'
    ? `          skills: "*"`
    : `          skills:\n            - "${skillSelector}"`;

  const content = `version: 1
skills:
  include:
${skillIncludeGlobs.map(g => `    - "${g}"`).join('\n')}
claude:
  marketplaces:
    ${marketplaceName}:
      owner:
        name: Test Org
      plugins:
        - name: ${pluginName}
          description: Test plugin for build-verify tests
${skillsYaml}
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
  ) => {
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

  it('should build skills into dist/skills/ using --cwd flag', () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillFixture(tempDir, MARKETPLACE_NAME, PLUGIN_NAME);

    const result = suite.runBuild(tempDir);

    expect(result.status).toBe(0);
    expect(existsSync(join(tempDir, DIST_SKILLS_DIR, TEST_SKILL_NAME, 'SKILL.md'))).toBe(true);
  });

  it('should build --only skills when no claude config', () => {
    const tempDir = suite.createTempDir();
    // Config with skills only, no claude section
    writeTestFile(
      join(tempDir, VAT_CONFIG_FILENAME),
      createSkillsConfigYaml([SKILL_INCLUDE_GLOB])
    );
    suite.createSkillSource(tempDir, SKILL_SOURCE_PATH, TEST_SKILL_NAME);

    const result = suite.runBuild(tempDir, ['--only', 'skills']);

    expect(result.status).toBe(0);
    expect(existsSync(join(tempDir, DIST_SKILLS_DIR, TEST_SKILL_NAME, 'SKILL.md'))).toBe(true);
  });

  it('should sanitize colon-namespaced skill names to fs-safe directory names', () => {
    // Regression test: skill names like "pkg:sub-skill" contain a colon, which is an
    // invalid directory name character on Windows. The build must replace ":" with "__".
    const NAMESPACED_SKILL_NAME = 'test-pkg:sub-skill';
    const NAMESPACED_SKILL_FS_PATH = 'test-pkg__sub-skill'; // expected on-disk name

    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, SKILL_SOURCE_PATH, NAMESPACED_SKILL_NAME);
    createVatConfig(tempDir, MARKETPLACE_NAME, PLUGIN_NAME, NAMESPACED_SKILL_NAME);

    const result = suite.runBuild(tempDir);

    expect(result.status).toBe(0);

    // dist/skills/ must use "__" form, never ":"
    expect(existsSync(join(tempDir, DIST_SKILLS_DIR, NAMESPACED_SKILL_FS_PATH, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tempDir, DIST_SKILLS_DIR, NAMESPACED_SKILL_NAME))).toBe(false); // colon form must not exist
  });

  it('should generate marketplace.json with source paths that do not use .. traversal', () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillFixture(tempDir, MARKETPLACE_NAME, PLUGIN_NAME);

    const result = suite.runBuild(tempDir);
    expect(result.status).toBe(0);

    const marketplaceJsonPath = join(
      tempDir, 'dist', '.claude', 'plugins', 'marketplaces',
      MARKETPLACE_NAME, '.claude-plugin', 'marketplace.json'
    );
    const marketplaceJson = JSON.parse(readFileSync(marketplaceJsonPath, 'utf-8')) as {
      plugins: Array<{ source: unknown }>;
    };

    for (const plugin of marketplaceJson.plugins) {
      if (typeof plugin.source === 'string') {
        expect(plugin.source).not.toContain('..');
      }
    }
  });

  it('should fail build when skill source missing', () => {
    const tempDir = suite.createTempDir();
    // Config references skills but no SKILL.md files exist
    writeTestFile(
      join(tempDir, VAT_CONFIG_FILENAME),
      createSkillsConfigYaml([SKILL_INCLUDE_GLOB])
    );
    // Intentionally NOT creating the skill source file

    const result = suite.runBuild(tempDir);

    expect(result.status).not.toBe(0);
  });
});

const VERIFY_SUCCESS_MARKER = 'status: success';

describe('vat verify command (system test)', () => {
  const suite = setupBuildVerifyTestSuite();

  afterEach(() => {
    suite.cleanup();
  });

  /**
   * Set up a temp dir with a complete fixture, build it, and return the tempDir.
   * Shared setup for tests that need pre-built artifacts.
   *
   * Adds package.json (so build emits plugin version) and LICENSE (required by
   * marketplace validate) so that `vat verify` with marketplace phase passes.
   */
  function setupBuiltFixture(): string {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillFixture(tempDir, MARKETPLACE_NAME, PLUGIN_NAME);

    // Build reads version from package.json for plugin.json — required by strict marketplace validate
    writeTestFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'test-pkg', version: '1.0.0' }));

    const buildResult = suite.runBuild(tempDir);
    expect(buildResult.status).toBe(0);

    // Marketplace validate requires LICENSE in the marketplace root
    const marketplaceDir = join(
      tempDir, 'dist', '.claude', 'plugins', 'marketplaces', MARKETPLACE_NAME
    );
    writeTestFile(join(marketplaceDir, 'LICENSE'), 'MIT License - Test');

    return tempDir;
  }

  it('should verify all phases pass when artifacts are valid', () => {
    const tempDir = setupBuiltFixture();

    const result = suite.runVerify(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(VERIFY_SUCCESS_MARKER);
  });

  it('should include marketplace phase when claude.marketplaces config exists', () => {
    const tempDir = setupBuiltFixture();

    const result = suite.runVerify(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(VERIFY_SUCCESS_MARKER);
    // Verify the marketplace phase was included in output
    expect(result.stdout).toContain(`marketplace:${MARKETPLACE_NAME}`);
  });

  it('should skip marketplace phase when no claude config exists', () => {
    const tempDir = suite.createTempDir();
    // Config with skills only, no claude section
    writeTestFile(
      join(tempDir, VAT_CONFIG_FILENAME),
      createSkillsConfigYaml([SKILL_INCLUDE_GLOB])
    );
    suite.createSkillSource(tempDir, SKILL_SOURCE_PATH, TEST_SKILL_NAME);

    // Build first (skills only)
    const buildResult = suite.runBuild(tempDir);
    expect(buildResult.status).toBe(0);

    const result = suite.runVerify(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(VERIFY_SUCCESS_MARKER);
    // Marketplace phase should NOT appear
    expect(result.stdout).not.toContain('marketplace:');
  });

});
