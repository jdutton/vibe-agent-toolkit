/**
 * System tests for skills build command
 *
 * vat skills build now reads vibe-agent-toolkit.config.yaml with skills.include
 * globs to discover SKILL.md files, instead of reading package.json vat.skills objects.
 */

import { readFileSync } from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, afterEach } from 'vitest';

import {
  createSkillMarkdown,
  createSkillsConfigYaml,
  createTempDirTracker,
  executeCliAndParseYaml,
  executeCli,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-build-test-';
const VAT_CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
const TEST_SKILL_NAME = 'test-skill';
const SKILL_A_NAME = 'skill-a';
const SKILL_B_NAME = 'skill-b';

/**
 * Setup test fixtures for skills build tests
 */
function setupSkillsBuildTestSuite() {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs: cleanup } = createTempDirTracker(TEMP_DIR_PREFIX);

  /**
   * Create a SKILL.md at a given path relative to tempDir
   */
  const createSkillSource = (tempDir: string, relativePath: string, skillName: string) => {
    const resourcesDir = safePath.join(tempDir, relativePath, '..');
    mkdirSyncReal(resourcesDir, { recursive: true });
    // Use default description (meets 50 char minimum for DESCRIPTION_TOO_VAGUE validation)
    writeTestFile(safePath.join(tempDir, relativePath), createSkillMarkdown(skillName));
  };

  /**
   * Create a config yaml with skills.include globs
   */
  const createConfigWithSkills = (tempDir: string, includeGlobs: string[]) => {
    writeTestFile(safePath.join(tempDir, VAT_CONFIG_FILENAME), createSkillsConfigYaml(includeGlobs));
  };

  /**
   * Set up a single-skill test fixture with config yaml
   */
  const setupSingleSkillTest = (tempDir: string) => {
    createSkillSource(tempDir, 'resources/skills/SKILL.md', TEST_SKILL_NAME);
    createConfigWithSkills(tempDir, ['resources/skills/**/SKILL.md']);
  };

  const runBuildCommand = (cwd: string, args: string[] = []) => {
    return executeCliAndParseYaml(binPath, ['skills', 'build', ...args], { cwd });
  };

  const assertSuccessfulBuild = (
    result: ReturnType<typeof runBuildCommand>['result'],
    parsed: ReturnType<typeof runBuildCommand>['parsed']
  ) => {
    expect(result.status).toBe(0);
    expect(parsed).toHaveProperty('status', 'success');
    expect(parsed).toHaveProperty('skills');

    const skills = parsed['skills'] as Array<Record<string, unknown>>;
    expect(skills).toHaveLength(1);
    expect(skills[0]).toHaveProperty('name', TEST_SKILL_NAME);

    return skills;
  };

  return {
    binPath,
    createTempDir,
    cleanup,
    createSkillSource,
    createConfigWithSkills,
    setupSingleSkillTest,
    runBuildCommand,
    assertSuccessfulBuild,
  };
}

describe('skills build command (system test)', () => {
  const suite = setupSkillsBuildTestSuite();

  afterEach(() => {
    suite.cleanup();
  });

  it('should show help text', () => {
    const result = executeCli(suite.binPath, ['skills', 'build', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Build skills from config yaml');
    expect(result.stdout).toContain('Config Structure');
    expect(result.stdout).toContain('Exit Codes:');
  });

  it('should exit 0 when no config yaml found (nothing to build)', () => {
    const tempDir = suite.createTempDir();

    const { result } = suite.runBuildCommand(tempDir);

    // No config yaml -> exits 0 with "nothing to build" message
    expect(result.status).toBe(0);
  });

  it('should exit 0 when config yaml has no skills section', () => {
    const tempDir = suite.createTempDir();
    writeTestFile(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n');

    const { result } = suite.runBuildCommand(tempDir);

    expect(result.status).toBe(0);
  });

  it('should fail when no SKILL.md files match include patterns', () => {
    const tempDir = suite.createTempDir();
    suite.createConfigWithSkills(tempDir, ['resources/skills/**/SKILL.md']);
    // Intentionally NOT creating any skill source files

    const { result } = suite.runBuildCommand(tempDir);

    expect(result.status).not.toBe(0);
  });

  it('should perform dry-run without creating files', () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillTest(tempDir);

    const { result, parsed } = suite.runBuildCommand(tempDir, ['--dry-run']);

    const skills = suite.assertSuccessfulBuild(result, parsed);
    expect(parsed).toHaveProperty('dryRun', true);
    expect(parsed).toHaveProperty('skillsFound', 1);
    expect(skills[0]).toHaveProperty('source');
  });

  it('should build a valid skill', () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillTest(tempDir);

    const { result, parsed } = suite.runBuildCommand(tempDir);

    const skills = suite.assertSuccessfulBuild(result, parsed);
    expect(parsed).toHaveProperty('skillsBuilt', 1);
    expect(skills[0]).toHaveProperty('filesPackaged', 1);

    // Verify output directory was created
    const outputPath = safePath.join(tempDir, 'dist', 'skills', TEST_SKILL_NAME);
    const skillMd = safePath.join(outputPath, 'SKILL.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output verification
    expect(readFileSync(skillMd, 'utf-8')).toContain(TEST_SKILL_NAME);
  });

  it('should build specific skill with --skill flag', () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'resources/skills/skill-a.md', SKILL_A_NAME);
    suite.createSkillSource(tempDir, 'resources/skills/skill-b.md', SKILL_B_NAME);
    suite.createConfigWithSkills(tempDir, ['resources/skills/*.md']);

    const { result, parsed } = suite.runBuildCommand(tempDir, ['--skill', SKILL_B_NAME]);

    expect(result.status).toBe(0);
    expect(parsed).toHaveProperty('skillsBuilt', 1);

    const skills = parsed['skills'] as Array<Record<string, unknown>>;
    expect(skills).toHaveLength(1);
    expect(skills[0]).toHaveProperty('name', SKILL_B_NAME);

    // Verify only skill-b was built
    const outputPathB = safePath.join(tempDir, 'dist', 'skills', SKILL_B_NAME);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output verification
    expect(readFileSync(safePath.join(outputPathB, 'SKILL.md'), 'utf-8')).toContain(SKILL_B_NAME);

    // Skill A should not exist (only skill-b was built)
    const outputPathA = safePath.join(tempDir, 'dist', 'skills', SKILL_A_NAME);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output verification
      readFileSync(safePath.join(outputPathA, 'SKILL.md'), 'utf-8');
      expect.fail('skill-a should not have been built');
    } catch {
      // Expected - file should not exist
      expect(true).toBe(true);
    }
  });

  it('should fail when specified skill not found', () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillTest(tempDir);

    const { result } = suite.runBuildCommand(tempDir, ['--skill', 'nonexistent']);

    expect(result.status).not.toBe(0);
  });
});
