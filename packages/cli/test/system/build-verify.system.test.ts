/* eslint-disable security/detect-non-literal-fs-filename -- All file paths are in temp directories controlled by tests */
/**
 * System tests for vat build and vat verify commands (with --cwd flag)
 *
 * vat build runs: skills build → produces dist/skills/<name>/SKILL.md
 * Claude plugin artifacts (dist/.claude/...) are built separately by the
 * package author's own build tooling; vat build no longer includes a claude phase.
 */

import { existsSync, readFileSync } from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
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
const DIST_SKILLS_DIR = safePath.join('dist', 'skills');
const SKILL_INCLUDE_GLOB = 'resources/skills/**/SKILL.md';
const SKILL_SOURCE_PATH = 'resources/skills/SKILL.md';

/**
 * Build a skill-include glob that discovers SKILL.md files under
 * `plugins/<plugin>/skills/` so the plugin-local discovery picks them up.
 */
function pluginSkillIncludeGlob(pluginName: string): string {
  return `plugins/${pluginName}/skills/**/SKILL.md`;
}

/**
 * Write a vibe-agent-toolkit.config.yaml with skills + claude marketplace config.
 *
 * The skill-include glob matches `plugins/<pluginName>/skills/**\/SKILL.md` so
 * every discovered skill is plugin-local to `pluginName` and ships with the
 * plugin's own bundle.
 */
function createVatConfig(
  dir: string,
  marketplaceName: string,
  pluginName: string,
  skillIncludeGlobs?: string[],
): void {
  const globs = skillIncludeGlobs ?? [pluginSkillIncludeGlob(pluginName)];

  const content = `version: 1
skills:
  include:
${globs.map(g => `    - "${g}"`).join('\n')}
claude:
  marketplaces:
    ${marketplaceName}:
      owner:
        name: Test Org
      plugins:
        - name: ${pluginName}
          description: Test plugin for build-verify tests
          skills: "*"
`;
  writeTestFile(safePath.join(dir, VAT_CONFIG_FILENAME), content);
}

/**
 * Setup common test fixtures for build/verify tests
 */
function setupBuildVerifyTestSuite() {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs: cleanup } = createTempDirTracker(TEMP_DIR_PREFIX);

  const createSkillSource = (tempDir: string, relativePath: string, skillName: string) => {
    const resourcesDir = safePath.join(tempDir, relativePath, '..');
    mkdirSyncReal(resourcesDir, { recursive: true });
    writeTestFile(safePath.join(tempDir, relativePath), createSkillMarkdown(skillName));
  };

  /**
   * Place a SKILL.md under `plugins/<plugin>/skills/<skillName>/SKILL.md` so
   * the skill-include glob picks it up into the pool and the plugin's
   * `skills: "*"` selector ships it in the plugin bundle.
   */
  const createPluginLocalSkill = (
    tempDir: string,
    pluginName: string,
    skillName: string,
  ) => {
    const relPath = safePath.join('plugins', pluginName, 'skills', skillName, 'SKILL.md');
    createSkillSource(tempDir, relPath, skillName);
  };

  const setupSingleSkillFixture = (
    tempDir: string,
    marketplaceName: string,
    pluginName: string,
  ) => {
    createPluginLocalSkill(tempDir, pluginName, TEST_SKILL_NAME);
    createVatConfig(tempDir, marketplaceName, pluginName);
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

  it('should build skills into dist/skills/ and ship them via plugin.skills selector', () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillFixture(tempDir, MARKETPLACE_NAME, PLUGIN_NAME);

    const result = suite.runBuild(tempDir);

    expect(result.status).toBe(0);
    // Pool skills live at dist/skills/<name>/
    expect(
      existsSync(
        safePath.join(tempDir, DIST_SKILLS_DIR, TEST_SKILL_NAME, 'SKILL.md'),
      ),
    ).toBe(true);
    // Plugin bundle imports them via skills: "*" selector
    expect(
      existsSync(
        safePath.join(
          tempDir,
          'dist',
          '.claude',
          'plugins',
          'marketplaces',
          MARKETPLACE_NAME,
          'plugins',
          PLUGIN_NAME,
          'skills',
          TEST_SKILL_NAME,
          'SKILL.md',
        ),
      ),
    ).toBe(true);
  });

  it('should build --only skills when no claude config', () => {
    const tempDir = suite.createTempDir();
    // Config with skills only, no claude section
    writeTestFile(
      safePath.join(tempDir, VAT_CONFIG_FILENAME),
      createSkillsConfigYaml([SKILL_INCLUDE_GLOB])
    );
    suite.createSkillSource(tempDir, SKILL_SOURCE_PATH, TEST_SKILL_NAME);

    const result = suite.runBuild(tempDir, ['--only', 'skills']);

    expect(result.status).toBe(0);
    expect(existsSync(safePath.join(tempDir, DIST_SKILLS_DIR, TEST_SKILL_NAME, 'SKILL.md'))).toBe(true);
  });

  it('should sanitize colon-namespaced skill names to fs-safe directory names', () => {
    // Regression test: skill names like "pkg:sub-skill" contain a colon, which is an
    // invalid directory name character on Windows. The build must replace ":" with "__".
    const NAMESPACED_SKILL_NAME = 'test-pkg:sub-skill';
    const NAMESPACED_SKILL_FS_PATH = 'test-pkg__sub-skill'; // expected on-disk name

    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, SKILL_SOURCE_PATH, NAMESPACED_SKILL_NAME);
    // Pool-only build (no claude section): standalone skill distribution path.
    writeTestFile(
      safePath.join(tempDir, VAT_CONFIG_FILENAME),
      createSkillsConfigYaml([SKILL_INCLUDE_GLOB]),
    );

    const result = suite.runBuild(tempDir);

    expect(result.status).toBe(0);

    // dist/skills/ must use "__" form, never ":"
    expect(existsSync(safePath.join(tempDir, DIST_SKILLS_DIR, NAMESPACED_SKILL_FS_PATH, 'SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(tempDir, DIST_SKILLS_DIR, NAMESPACED_SKILL_NAME))).toBe(false); // colon form must not exist
  });

  it('should generate marketplace.json with source paths that do not use .. traversal', () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillFixture(tempDir, MARKETPLACE_NAME, PLUGIN_NAME);

    const result = suite.runBuild(tempDir);
    expect(result.status).toBe(0);

    const marketplaceJsonPath = safePath.join(
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
      safePath.join(tempDir, VAT_CONFIG_FILENAME),
      createSkillsConfigYaml([SKILL_INCLUDE_GLOB])
    );
    // Intentionally NOT creating the skill source file

    const result = suite.runBuild(tempDir);

    expect(result.status).not.toBe(0);
  });
});

/**
 * Set up a temp dir with a complete fixture, build it, and return the tempDir.
 * Shared setup for tests that need pre-built artifacts.
 *
 * Adds package.json (so build emits plugin version) and LICENSE (required by
 * marketplace validate) so that `vat verify` with marketplace phase passes.
 */
function setupBuiltFixture(suite: ReturnType<typeof setupBuildVerifyTestSuite>): string {
  const tempDir = suite.createTempDir();
  suite.setupSingleSkillFixture(tempDir, MARKETPLACE_NAME, PLUGIN_NAME);

  // Build reads version from package.json for plugin.json — required by strict marketplace validate
  writeTestFile(safePath.join(tempDir, 'package.json'), JSON.stringify({ name: 'test-pkg', version: '1.0.0' }));

  const buildResult = suite.runBuild(tempDir);
  expect(buildResult.status).toBe(0);

  // Marketplace validate requires LICENSE in the marketplace root
  const marketplaceDir = safePath.join(
    tempDir, 'dist', '.claude', 'plugins', 'marketplaces', MARKETPLACE_NAME
  );
  writeTestFile(safePath.join(marketplaceDir, 'LICENSE'), 'MIT License - Test');

  return tempDir;
}

const VERIFY_SUCCESS_MARKER = 'status: success';

describe('vat verify command (system test)', () => {
  const suite = setupBuildVerifyTestSuite();

  afterEach(() => {
    suite.cleanup();
  });

  it('should verify all phases pass when artifacts are valid', () => {
    const tempDir = setupBuiltFixture(suite);

    const result = suite.runVerify(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(VERIFY_SUCCESS_MARKER);
  });

  it('should include marketplace phase when claude.marketplaces config exists', () => {
    const tempDir = setupBuiltFixture(suite);

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
      safePath.join(tempDir, VAT_CONFIG_FILENAME),
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
