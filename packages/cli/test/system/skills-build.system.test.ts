/**
 * System tests for skills build command
 *
 * vat skills build now reads vibe-agent-toolkit.config.yaml with skills.include
 * globs to discover SKILL.md files, instead of reading package.json vat.skills objects.
 */

import { existsSync, readFileSync } from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, afterEach, beforeAll } from 'vitest';

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
const PACKAGE_JSON_FILENAME = 'package.json';
const CONFIG_VERSION_HEADER = 'version: 1\n';
const CONFIG_VERSION_LINE = 'version: 1';
const CONFIG_VALIDATION_INDENT = '      validation:';
const TEST_SKILL_NAME = 'test-skill';
const SKILL_A_NAME = 'skill-a';
const SKILL_B_NAME = 'skill-b';

/** Inline SKILL.md frontmatter + body for fixture projects. */
const SKILL_FRONTMATTER_TEMPLATE = (skillName: string) =>
  `---\nname: ${skillName}\ndescription: ${skillName} - comprehensive test skill for validation and packaging\nversion: 1.0.0\n---\n\n# ${skillName}\n\nThis is a test skill.\n`;

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
    writeTestFile(safePath.join(tempDir, VAT_CONFIG_FILENAME), CONFIG_VERSION_HEADER);

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

  it('should copy files declared in skills.config.<name>.files to the skill output', () => {
    // Regression test: the `files` config was parsed by build.ts::mergePackagingConfig
    // but not passed into SkillBuildSpec.options, so declared files never got copied.
    // This verifies that files config entries land in the packaged output.
    const tempDir = suite.createTempDir();

    // Establish project root: findProjectRoot() looks for a package.json with
    // "workspaces" to identify monorepo roots. Without this, it falls back to the
    // skill dir and source paths resolve incorrectly.
    writeTestFile(
      safePath.join(tempDir, PACKAGE_JSON_FILENAME),
      JSON.stringify({ name: 'files-test-workspace', workspaces: [] }),
    );

    // Create source files: SKILL.md and an artifact to copy
    suite.createSkillSource(tempDir, 'resources/skills/SKILL.md', TEST_SKILL_NAME);
    mkdirSyncReal(safePath.join(tempDir, 'dist', 'bin'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'dist', 'bin', 'tool.mjs'), 'console.log("tool");\n');

    // Config with files entry declaring source → dest mapping.
    // Allow PACKAGED_UNREFERENCED_FILE since this test focuses on file copying,
    // not link-reference coverage. The injected artifact is intentionally unreferenced.
    const configContent = [
      CONFIG_VERSION_LINE,
      'skills:',
      '  include:',
      '    - "resources/skills/**/SKILL.md"',
      '  config:',
      `    ${TEST_SKILL_NAME}:`,
      '      files:',
      '        - source: dist/bin/tool.mjs',
      '          dest: scripts/tool.mjs',
      CONFIG_VALIDATION_INDENT,
      '        allow:',
      '          PACKAGED_UNREFERENCED_FILE:',
      '            - paths: ["**"]',
      '              reason: artifact injected via files config, not linked from markdown',
      '',
    ].join('\n');
    writeTestFile(safePath.join(tempDir, VAT_CONFIG_FILENAME), configContent);

    const { result } = suite.runBuildCommand(tempDir);

    expect(result.status).toBe(0);

    // The declared file should exist in the packaged skill output
    const expectedDest = safePath.join(tempDir, 'dist', 'skills', TEST_SKILL_NAME, 'scripts', 'tool.mjs');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output verification
    const content = readFileSync(expectedDest, 'utf-8');
    expect(content).toContain('console.log("tool")');
  });
});

/**
 * Helper: create a project with a SKILL.md that has an unreferenced packaged file
 * (using the files config to inject a file not mentioned in any markdown).
 * PACKAGED_UNREFERENCED_FILE has default severity=error, so this should cause exit 1.
 */
function setupProjectWithUnreferencedFile(
  tempDir: string,
  skillName: string,
): string {
  const projectDir = safePath.join(tempDir, 'unreferenced-file');
  mkdirSyncReal(projectDir, { recursive: true });

  // package.json to establish project root
  writeTestFile(
    safePath.join(projectDir, PACKAGE_JSON_FILENAME),
    JSON.stringify({ name: 'unreferenced-test', workspaces: [] }),
  );

  // Skill with minimal SKILL.md (no link to the injected file)
  mkdirSyncReal(safePath.join(projectDir, 'skills'), { recursive: true });
  writeTestFile(
    safePath.join(projectDir, 'skills', 'SKILL.md'),
    SKILL_FRONTMATTER_TEMPLATE(skillName),
  );

  // An artifact that will be injected via files config but NOT mentioned in SKILL.md
  mkdirSyncReal(safePath.join(projectDir, 'dist', 'bin'), { recursive: true });
  writeTestFile(safePath.join(projectDir, 'dist', 'bin', 'runner.mjs'), 'console.log("runner");\n');

  // Config: inject the artifact via files but no markdown link → PACKAGED_UNREFERENCED_FILE
  const configContent = [
    CONFIG_VERSION_LINE,
    'skills:',
    '  include:',
    '    - "skills/SKILL.md"',
    '  config:',
    `    ${skillName}:`,
    '      files:',
    '        - source: dist/bin/runner.mjs',
    '          dest: bin/runner.mjs',
    '',
  ].join('\n');
  writeTestFile(safePath.join(projectDir, VAT_CONFIG_FILENAME), configContent);

  return projectDir;
}

/**
 * Shared: scaffold a 3-level link graph (SKILL.md → level1/a.md → level2/b.md)
 * inside `projectDir/skills/`. Used by depth-drop fixture helpers.
 *
 * With linkFollowDepth=1, `level2/b.md` is dropped at packaging time,
 * emitting LINK_DROPPED_BY_DEPTH.
 */
function writeDepthDropLinkGraph(projectDir: string, skillName: string): void {
  mkdirSyncReal(safePath.join(projectDir, 'skills', 'level0'), { recursive: true });
  mkdirSyncReal(safePath.join(projectDir, 'skills', 'level1'), { recursive: true });
  mkdirSyncReal(safePath.join(projectDir, 'skills', 'level2'), { recursive: true });

  writeTestFile(
    safePath.join(projectDir, 'skills', 'level0', 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: ${skillName} - comprehensive test skill for validation and packaging\nversion: 1.0.0\n---\n\n# ${skillName}\n\nSee [level1](../level1/a.md).\n`,
  );
  writeTestFile(
    safePath.join(projectDir, 'skills', 'level1', 'a.md'),
    '# Level 1\n\nSee [level2](../level2/b.md).\n',
  );
  writeTestFile(
    safePath.join(projectDir, 'skills', 'level2', 'b.md'),
    '# Level 2\n\nDeep content.\n',
  );
}

/**
 * Helper: create a project with a SKILL.md that has a depth-drop link
 * and the severity overridden to 'error'.
 * LINK_DROPPED_BY_DEPTH default=warning; we bump it to error to test exit code.
 */
function setupProjectWithDepthDrop(
  tempDir: string,
  skillName: string,
): string {
  const projectDir = safePath.join(tempDir, 'depth-drop');
  mkdirSyncReal(projectDir, { recursive: true });

  writeTestFile(
    safePath.join(projectDir, PACKAGE_JSON_FILENAME),
    JSON.stringify({ name: 'depth-drop-test', workspaces: [] }),
  );

  writeDepthDropLinkGraph(projectDir, skillName);

  // linkFollowDepth=1 so level2/b.md is dropped; override severity to error
  const configContent = [
    CONFIG_VERSION_LINE,
    'skills:',
    '  include:',
    '    - "skills/level0/SKILL.md"',
    '  config:',
    `    ${skillName}:`,
    '      linkFollowDepth: 1',
    CONFIG_VALIDATION_INDENT,
    '        severity:',
    '          LINK_DROPPED_BY_DEPTH: error',
    '',
  ].join('\n');
  writeTestFile(safePath.join(projectDir, VAT_CONFIG_FILENAME), configContent);

  return projectDir;
}

/**
 * Helper: same depth-drop scenario but with an allow entry to suppress the error.
 */
function setupProjectWithDepthDropAndAllow(
  tempDir: string,
  skillName: string,
): string {
  const projectDir = safePath.join(tempDir, 'depth-drop-allow');
  mkdirSyncReal(projectDir, { recursive: true });

  writeTestFile(
    safePath.join(projectDir, PACKAGE_JSON_FILENAME),
    JSON.stringify({ name: 'depth-drop-allow-test', workspaces: [] }),
  );

  writeDepthDropLinkGraph(projectDir, skillName);

  // linkFollowDepth=1, severity=error, but allow suppresses it
  const configContent = [
    CONFIG_VERSION_LINE,
    'skills:',
    '  include:',
    '    - "skills/level0/SKILL.md"',
    '  config:',
    `    ${skillName}:`,
    '      linkFollowDepth: 1',
    CONFIG_VALIDATION_INDENT,
    '        severity:',
    '          LINK_DROPPED_BY_DEPTH: error',
    '        allow:',
    '          LINK_DROPPED_BY_DEPTH:',
    '            - paths: ["**"]',
    '              reason: depth drop is intentional in this test',
    '',
  ].join('\n');
  writeTestFile(safePath.join(projectDir, VAT_CONFIG_FILENAME), configContent);

  return projectDir;
}

describe('skills build — framework exit codes (system test)', () => {
  const DEPTH_DROP_SKILL = 'depth-drop-skill';
  const UNREFERENCED_SKILL = 'unreferenced-skill';

  let suite: ReturnType<typeof setupSkillsBuildTestSuite>;

  beforeAll(() => {
    suite = setupSkillsBuildTestSuite();
  });

  afterEach(() => {
    suite.cleanup();
  });

  it('exits non-zero when LINK_DROPPED_BY_DEPTH is set to severity=error', () => {
    const tempDir = suite.createTempDir();
    const projectDir = setupProjectWithDepthDrop(tempDir, DEPTH_DROP_SKILL);

    const { result: cmdResult } = suite.runBuildCommand(projectDir);

    expect(cmdResult.status).toBe(1);
    expect(cmdResult.stderr + cmdResult.stdout).toContain('LINK_DROPPED_BY_DEPTH');
  });

  it('exits zero when LINK_DROPPED_BY_DEPTH error is suppressed via allow', () => {
    const tempDir = suite.createTempDir();
    const projectDir = setupProjectWithDepthDropAndAllow(tempDir, DEPTH_DROP_SKILL);

    const { result: cmdResult } = suite.runBuildCommand(projectDir);

    expect(cmdResult.status).toBe(0);
  });

  it('exits non-zero when PACKAGED_UNREFERENCED_FILE fires (default severity=error)', () => {
    const tempDir = suite.createTempDir();
    const projectDir = setupProjectWithUnreferencedFile(tempDir, UNREFERENCED_SKILL);

    const { result: cmdResult } = suite.runBuildCommand(projectDir);

    expect(cmdResult.status).toBe(1);
    expect(cmdResult.stderr + cmdResult.stdout).toContain('PACKAGED_UNREFERENCED_FILE');
  });
});

const PLUGIN_TEST_PKG_JSON = JSON.stringify({ name: 't', version: '0.0.1' });

function writePluginLocalSkill(tempDir: string, plugin: string, skill: string): void {
  mkdirSyncReal(safePath.join(tempDir, 'plugins', plugin, 'skills', skill), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, 'plugins', plugin, 'skills', skill, 'SKILL.md'),
    createSkillMarkdown(skill),
  );
}

function writePluginFixtureFiles(tempDir: string, config: string): void {
  writeTestFile(safePath.join(tempDir, VAT_CONFIG_FILENAME), config);
  writeTestFile(safePath.join(tempDir, PACKAGE_JSON_FILENAME), PLUGIN_TEST_PKG_JSON);
}

describe('skills build with plugin-local skills', () => {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-build-plugin-local-');

  afterEach(() => cleanupTempDirs());

  it('emits dist/plugins/<name>/skills/<skill>/ for a plugin-local skill', () => {
    const tempDir = createTempDir();
    writePluginFixtureFiles(
      tempDir,
      `version: 1
skills:
  include: ["skills/**/SKILL.md"]
claude:
  marketplaces:
    mp1:
      owner:
        name: Test
      plugins:
        - name: p1
`,
    );
    writePluginLocalSkill(tempDir, 'p1', 'helper');

    const { result } = executeCliAndParseYaml(binPath, ['skills', 'build'], { cwd: tempDir });
    expect(result.status).toBe(0);
    const distSkillPath = safePath.join(
      tempDir,
      'dist',
      'plugins',
      'p1',
      'skills',
      'helper',
      'SKILL.md',
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test output verification
    expect(existsSync(distSkillPath)).toBe(true);
  });

  it('errors on duplicate plugin names across marketplaces (case-colliding guard)', () => {
    const tempDir = createTempDir();
    writePluginFixtureFiles(
      tempDir,
      `version: 1
skills:
  include: ["skills/**/SKILL.md"]
claude:
  marketplaces:
    mp1:
      owner:
        name: Test
      plugins:
        - name: shared
    mp2:
      owner:
        name: Test
      plugins:
        - name: shared
`,
    );

    const result = executeCli(binPath, ['skills', 'build'], { cwd: tempDir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/plugin name|case-collid|declared more than once/i);
  });
});
