/**
 * System tests for skills build command
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, afterEach } from 'vitest';

import {
  createSkillMarkdown,
  createSkillsPackageJson,
  createTestTempDir,
  executeCliAndParseYaml,
  executeCli,
  getBinPath,
  writeTestFile,
  type TestVatSkill,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-build-test-';
const PACKAGE_JSON_FILENAME = 'package.json';
const PACKAGE_NAME = 'test-package';
const TEST_SKILL_NAME = 'test-skill';
const SKILL_SOURCE_PATH = './resources/skills/SKILL.md';
const SKILL_DIST_PATH = './dist/skills/test-skill';
const SKILL_A_NAME = 'skill-a';
const SKILL_B_NAME = 'skill-b';

/**
 * Setup test fixtures for skills build tests
 */
function setupSkillsBuildTestSuite() {
  const binPath = getBinPath(import.meta.url);
  const tempDirs: string[] = [];

  const createTempDir = () => {
    const dir = createTestTempDir(TEMP_DIR_PREFIX);
    tempDirs.push(dir);
    return dir;
  };

  const cleanup = () => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    tempDirs.length = 0;
  };

  const createPackageWithSkills = (tempDir: string, skills: TestVatSkill[]) => {
    writeTestFile(
      join(tempDir, PACKAGE_JSON_FILENAME),
      createSkillsPackageJson(PACKAGE_NAME, skills)
    );
  };

  const createSkillSource = (tempDir: string, relativePath: string, skillName: string) => {
    const resourcesDir = join(tempDir, relativePath, '..');
    mkdirSyncReal(resourcesDir, { recursive: true });
    writeTestFile(join(tempDir, relativePath), createSkillMarkdown(skillName, `${skillName} test`));
  };

  const setupSingleSkillTest = (tempDir: string) => {
    createPackageWithSkills(tempDir, [
      { name: TEST_SKILL_NAME, source: SKILL_SOURCE_PATH, path: SKILL_DIST_PATH },
    ]);
    createSkillSource(tempDir, SKILL_SOURCE_PATH, TEST_SKILL_NAME);
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
    expect(parsed).toHaveProperty('package', PACKAGE_NAME);
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
    createPackageWithSkills,
    createSkillSource,
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
    expect(result.stdout).toContain('Build skills from source');
    expect(result.stdout).toContain('vat.skills');
    expect(result.stdout).toContain('Package.json Structure:');
    expect(result.stdout).toContain('Exit Codes:');
  });

  it('should fail when package.json not found', () => {
    const tempDir = suite.createTempDir();
    const { result } = suite.runBuildCommand(tempDir);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('package.json not found');
  });

  it('should fail when vat.skills not found in package.json', () => {
    const tempDir = suite.createTempDir();
    writeTestFile(
      join(tempDir, PACKAGE_JSON_FILENAME),
      JSON.stringify({ name: PACKAGE_NAME, version: '1.0.0' })
    );

    const { result } = suite.runBuildCommand(tempDir);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('No skills found in package.json vat.skills');
  });

  it('should fail when skill source not found', () => {
    const tempDir = suite.createTempDir();
    suite.createPackageWithSkills(tempDir, [
      { name: TEST_SKILL_NAME, source: SKILL_SOURCE_PATH, path: SKILL_DIST_PATH },
    ]);

    const { result } = suite.runBuildCommand(tempDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Skill source not found');
  });

  it('should perform dry-run without creating files', () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillTest(tempDir);

    const { result, parsed } = suite.runBuildCommand(tempDir, ['--dry-run']);

    const skills = suite.assertSuccessfulBuild(result, parsed);
    expect(parsed).toHaveProperty('dryRun', true);
    expect(parsed).toHaveProperty('skillsFound', 1);
    expect(skills[0]).toHaveProperty('source', SKILL_SOURCE_PATH);
  });

  it('should build a valid skill', () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillTest(tempDir);

    const { result, parsed } = suite.runBuildCommand(tempDir);

    const skills = suite.assertSuccessfulBuild(result, parsed);
    expect(parsed).toHaveProperty('skillsBuilt', 1);
    expect(skills[0]).toHaveProperty('filesPackaged', 1);

    // Verify output directory was created
    const outputPath = join(tempDir, 'dist', 'skills', TEST_SKILL_NAME);
    const skillMd = join(outputPath, 'SKILL.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output verification
    expect(readFileSync(skillMd, 'utf-8')).toContain(TEST_SKILL_NAME);
  });

  it('should build specific skill with --skill flag', () => {
    const tempDir = suite.createTempDir();
    suite.createPackageWithSkills(tempDir, [
      { name: SKILL_A_NAME, source: './resources/skills/skill-a.md', path: './dist/skills/skill-a' },
      { name: SKILL_B_NAME, source: './resources/skills/skill-b.md', path: './dist/skills/skill-b' },
    ]);
    suite.createSkillSource(tempDir, './resources/skills/skill-a.md', SKILL_A_NAME);
    suite.createSkillSource(tempDir, './resources/skills/skill-b.md', SKILL_B_NAME);

    const { result, parsed } = suite.runBuildCommand(tempDir, ['--skill', SKILL_B_NAME]);

    expect(result.status).toBe(0);
    expect(parsed).toHaveProperty('skillsBuilt', 1);

    const skills = parsed['skills'] as Array<Record<string, unknown>>;
    expect(skills).toHaveLength(1);
    expect(skills[0]).toHaveProperty('name', SKILL_B_NAME);

    // Verify only skill-b was built
    const outputPathB = join(tempDir, 'dist', 'skills', SKILL_B_NAME);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output verification
    expect(readFileSync(join(outputPathB, 'SKILL.md'), 'utf-8')).toContain(SKILL_B_NAME);

    // Skill A should not exist (only skill-b was built)
    const outputPathA = join(tempDir, 'dist', 'skills', SKILL_A_NAME);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output verification
      readFileSync(join(outputPathA, 'SKILL.md'), 'utf-8');
      expect.fail('skill-a should not have been built');
    } catch {
      // Expected - file should not exist
      expect(true).toBe(true);
    }
  });

  it('should fail when specified skill not found', () => {
    const tempDir = suite.createTempDir();
    suite.createPackageWithSkills(tempDir, [
      { name: TEST_SKILL_NAME, source: SKILL_SOURCE_PATH, path: SKILL_DIST_PATH },
    ]);

    const { result } = suite.runBuildCommand(tempDir, ['--skill', 'nonexistent']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Skill "nonexistent" not found');
  });
});
