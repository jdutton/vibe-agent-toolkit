/**
 * System tests for vat build and vat verify commands (with --cwd flag)
 *
 * vat build runs: skills build → dist/skills/<name>/SKILL.md, then (when
 * claude.marketplaces is configured) the claude plugin build → dist/.claude/.
 * Both orchestrators publish ONE report, parsed here with its registered schema.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { orchestratorReportOf, phaseDataMismatches } from '../helpers/published-phase.js';

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

  const runBuild = async (tempDir: string, extraArgs: string[] = []) => {
    return executeCli(binPath, ['--cwd', tempDir, 'build', ...extraArgs]);
  };

  const runVerify = async (tempDir: string, extraArgs: string[] = []) => {
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

  it('should build skills into dist/skills/ and ship them via plugin.skills selector', async () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillFixture(tempDir, MARKETPLACE_NAME, PLUGIN_NAME);

    const result = await suite.runBuild(tempDir);

    expect(result.status).toBe(0);
    // Every phase ran, and each one's data is what its own verb's schema describes.
    expect(orchestratorReportOf(result.stdout).data?.phases.map((phase) => phase.name)).toEqual(['skills', 'claude', 'shipped-links']);
    expect(phaseDataMismatches(orchestratorReportOf(result.stdout), 'build')).toEqual([]);
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

  it('should build --only skills when no claude config', async () => {
    const tempDir = suite.createTempDir();
    // Config with skills only, no claude section
    writeTestFile(
      safePath.join(tempDir, VAT_CONFIG_FILENAME),
      createSkillsConfigYaml([SKILL_INCLUDE_GLOB])
    );
    suite.createSkillSource(tempDir, SKILL_SOURCE_PATH, TEST_SKILL_NAME);

    const result = await suite.runBuild(tempDir, ['--only', 'skills']);

    expect(result.status).toBe(0);
    expect(existsSync(safePath.join(tempDir, DIST_SKILLS_DIR, TEST_SKILL_NAME, 'SKILL.md'))).toBe(true);
    // A status with no distribution beside it cannot say whether a pass
    // means "clean" or "we did not look".
    const report = orchestratorReportOf(result.stdout);
    expect(report.summary.errors).toBe(0);
    expect(report.data?.phases.map((phase) => phase.name)).toEqual(['skills']);
  });

  it('should sanitize colon-namespaced skill names to fs-safe directory names', async () => {
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

    const result = await suite.runBuild(tempDir);

    expect(result.status).toBe(0);

    // dist/skills/ must use "__" form, never ":"
    expect(existsSync(safePath.join(tempDir, DIST_SKILLS_DIR, NAMESPACED_SKILL_FS_PATH, 'SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(tempDir, DIST_SKILLS_DIR, NAMESPACED_SKILL_NAME))).toBe(false); // colon form must not exist
  });

  it('should generate marketplace.json with source paths that do not use .. traversal', async () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillFixture(tempDir, MARKETPLACE_NAME, PLUGIN_NAME);

    const result = await suite.runBuild(tempDir);
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

  it('should fail build with exit 1 when the include patterns match no skill', async () => {
    const tempDir = suite.createTempDir();
    // Config references skills but no SKILL.md files exist
    writeTestFile(
      safePath.join(tempDir, VAT_CONFIG_FILENAME),
      createSkillsConfigYaml([SKILL_INCLUDE_GLOB])
    );
    // Intentionally NOT creating the skill source file

    const result = await suite.runBuild(tempDir);

    // A run that examined nothing is not a verdict: the writer's
    // RESOURCE_CHECK_BROKEN finding fails it (exit 1) — never a green build of nothing.
    expect(result.status).toBe(1);
    const report = orchestratorReportOf(result.stdout);
    expect(report.status).toBe('findings');
    expect(report.findings.map((finding) => finding.code)).toContain('RESOURCE_CHECK_BROKEN');
  });
});

/**
 * Set up a temp dir with a complete fixture, build it, and return the tempDir.
 * Shared setup for tests that need pre-built artifacts.
 *
 * Adds package.json (so build emits plugin version) and LICENSE (required by
 * marketplace validate) so that `vat verify` with marketplace phase passes.
 */
async function setupBuiltFixture(suite: ReturnType<typeof setupBuildVerifyTestSuite>): Promise<string> {
  const tempDir = suite.createTempDir();
  suite.setupSingleSkillFixture(tempDir, MARKETPLACE_NAME, PLUGIN_NAME);

  // Build reads version from package.json for plugin.json — required by strict marketplace validate
  writeTestFile(safePath.join(tempDir, 'package.json'), JSON.stringify({ name: 'test-pkg', version: '1.0.0' }));

  const buildResult = await suite.runBuild(tempDir);
  expect(buildResult.status).toBe(0);

  // Marketplace validate requires LICENSE in the marketplace root
  const marketplaceDir = safePath.join(
    tempDir, 'dist', '.claude', 'plugins', 'marketplaces', MARKETPLACE_NAME
  );
  writeTestFile(safePath.join(marketplaceDir, 'LICENSE'), 'MIT License - Test');

  return tempDir;
}

/** A verify run that finished with no error finding (warnings never fail it). */
function expectPassed(stdout: string): void {
  const report = orchestratorReportOf(stdout);
  expect(report.status).not.toBe('error');
  expect(report.summary.errors).toBe(0);
}

describe('vat verify command (system test)', () => {
  const suite = setupBuildVerifyTestSuite();

  afterEach(() => {
    suite.cleanup();
  });

  describe('against a marketplace fixture', () => {
    let verifyResult: Awaited<ReturnType<typeof suite.runVerify>>;

    beforeAll(async () => {
      const tempDir = await setupBuiltFixture(suite);
      verifyResult = await suite.runVerify(tempDir);
    });

    afterAll(() => {
      suite.cleanup();
    });

    it('should verify all phases pass when artifacts are valid', () => {
      expect(verifyResult.status).toBe(0);
      expectPassed(verifyResult.stdout);
    });

    it('should include marketplace phase when claude.marketplaces config exists', () => {
      expect(verifyResult.stdout).toContain(`marketplace:${MARKETPLACE_NAME}`);
    });

    it('publishes every phase, each one\'s data as its own schema describes', () => {
      expect(orchestratorReportOf(verifyResult.stdout).data?.phases.map((phase) => [phase.name, phase.status])).toEqual([
        ['skills', expect.not.stringMatching(/^error$/)],
        [`marketplace:${MARKETPLACE_NAME}`, expect.not.stringMatching(/^error$/)],
        ['files-config-dests', 'ok'],
        ['packaged-content', expect.not.stringMatching(/^error$/)],
        ['consistency', expect.not.stringMatching(/^error$/)],
      ]);
      expect(phaseDataMismatches(orchestratorReportOf(verifyResult.stdout), 'verify')).toEqual([]);
    });
  });

  it('publishes a files: dest missing from the built output as FILES_CONFIG_DEST_MISSING, exit 1', async () => {
    // A pool skill whose `files:` entry `vat build` applied; the dest is then
    // deleted from dist/ — the state a partial or hand-edited build leaves.
    const tempDir = suite.createTempDir();
    writeTestFile(
      safePath.join(tempDir, VAT_CONFIG_FILENAME),
      `${createSkillsConfigYaml([SKILL_INCLUDE_GLOB])}  config:\n    ${TEST_SKILL_NAME}:\n      files:\n        - source: assets/tool.mjs\n          dest: scripts/tool.mjs\n`,
    );
    suite.createSkillSource(tempDir, SKILL_SOURCE_PATH, TEST_SKILL_NAME);
    mkdirSyncReal(safePath.join(tempDir, 'assets'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'assets', 'tool.mjs'), 'export {};\n');
    expect((await suite.runBuild(tempDir)).status).toBe(0);
    const dest = safePath.join(tempDir, DIST_SKILLS_DIR, TEST_SKILL_NAME, 'scripts', 'tool.mjs');
    expect(existsSync(dest)).toBe(true);
    rmSync(dest);

    const result = await suite.runVerify(tempDir);

    expect(result.status).toBe(1);
    const report = orchestratorReportOf(result.stdout);
    expect(report.findings.filter((finding) => finding.code === 'FILES_CONFIG_DEST_MISSING')).toEqual([
      expect.objectContaining({ severity: 'error', location: `dist/skills/${TEST_SKILL_NAME}/scripts/tool.mjs` }),
    ]);
    expect(report.data?.phases.find((phase) => phase.name === 'files-config-dests')).toMatchObject({
      status: 'findings',
      examined: 1,
      summary: { errors: 1, warnings: 0, info: 0 },
    });
  });

  it('should skip marketplace phase when no claude config exists', async () => {
    const tempDir = suite.createTempDir();
    // Config with skills only, no claude section
    writeTestFile(
      safePath.join(tempDir, VAT_CONFIG_FILENAME),
      createSkillsConfigYaml([SKILL_INCLUDE_GLOB])
    );
    suite.createSkillSource(tempDir, SKILL_SOURCE_PATH, TEST_SKILL_NAME);

    // Build first (skills only)
    const buildResult = await suite.runBuild(tempDir);
    expect(buildResult.status).toBe(0);

    const result = await suite.runVerify(tempDir);

    expect(result.status).toBe(0);
    expectPassed(result.stdout);
    // Marketplace phase should NOT appear
    expect(orchestratorReportOf(result.stdout).data?.phases.map((phase) => phase.name)).not.toContain(`marketplace:${MARKETPLACE_NAME}`);
  });

  it('propagates a phase that could not run as exit 2, not as a validation failure', async () => {
    // The children (`vat resources validate`, `vat skills validate`) exit 2 on
    // an unparseable config. Collapsing that into 1 made the documented exit
    // code 2 unreachable and a broken config indistinguishable from a broken
    // link in CI.
    //
    // A bare run, because an unreadable config selects EVERY subprocess phase:
    // `vat verify` must not answer "that phase is not configured" about a file
    // it could not read, so it runs the children and lets THEM report.
    const tempDir = suite.createTempDir();
    writeTestFile(
      safePath.join(tempDir, VAT_CONFIG_FILENAME),
      'version: 1\nresources:\n  include: [unclosed\n',
    );

    const result = await suite.runVerify(tempDir);

    expect(result.status).toBe(2);
    const report = orchestratorReportOf(result.stdout);
    expect(report.error?.code).toBe('RUN_INCOMPLETE');
    expect(report.data?.phases.map((phase) => phase.error?.code)).toEqual(['CONFIG_INVALID', 'CONFIG_INVALID']);
  });

});
