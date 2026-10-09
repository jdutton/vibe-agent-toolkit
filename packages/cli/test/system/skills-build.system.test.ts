/**
 * System tests for skills build command
 *
 * vat skills build now reads vibe-agent-toolkit.config.yaml with skills.include
 * globs to discover SKILL.md files, instead of reading package.json vat.skills objects.
 */

import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it, afterEach, beforeAll } from 'vitest';

import { SKILLS_BUILD_REPORT_SCHEMA } from '../../src/commands/skills/build-schema.js';

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
const EMPTY_CONFIG = '{}\n';
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

  /** Run the build; `report` is the stdout document parsed by the verb's own published schema. */
  const runBuildCommand = async (cwd: string, args: string[] = []) => {
    const { result, parsed } = await executeCliAndParseYaml(binPath, ['skills', 'build', ...args], { cwd });
    return { result, report: SKILLS_BUILD_REPORT_SCHEMA.parse(parsed) };
  };

  type BuildReport = Awaited<ReturnType<typeof runBuildCommand>>['report'];

  /** The report's `data`, which every completed run carries. */
  const dataOf = (report: BuildReport) => {
    expect(report.data, JSON.stringify(report)).not.toBeNull();
    return report.data as NonNullable<BuildReport['data']>;
  };

  const assertSuccessfulBuild = (
    result: Awaited<ReturnType<typeof runBuildCommand>>['result'],
    report: BuildReport,
  ) => {
    expect(result.status, result.stderr).toBe(0);
    // "Successful" means the build gate passed: exit 0 and ZERO errors. This
    // fixture's frontmatter carries a `version` field, so a real build may ship a
    // non-blocking finding and publish `findings`; the invariant is the error count.
    expect(report.summary.errors).toBe(0);
    const skills = dataOf(report).skills;
    expect(skills.map((row) => row.name)).toEqual([TEST_SKILL_NAME]);
    return skills;
  };

  /** The codes of a report's findings, in order. */
  const codesOf = (report: BuildReport): string[] => report.findings.map((finding) => finding.code);

  return {
    binPath,
    createTempDir,
    cleanup,
    createSkillSource,
    createConfigWithSkills,
    setupSingleSkillTest,
    runBuildCommand,
    assertSuccessfulBuild,
    dataOf,
    codesOf,
  };
}

describe('skills build command (system test)', () => {
  const suite = setupSkillsBuildTestSuite();

  afterEach(() => {
    suite.cleanup();
  });

  it('should show help text', async () => {
    const result = await executeCli(suite.binPath, ['skills', 'build', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Build skills from config yaml');
    expect(result.stdout).toContain('Config Structure');
    expect(result.stdout).toContain('Exit Codes:');
  });

  it('should fail-fast when no config yaml or .git/ ancestor exists (required projectRoot policy)', async () => {
    const tempDir = suite.createTempDir();

    const { result } = await suite.runBuildCommand(tempDir);

    // Phase 4 spec §7: `vat skills build` enforces the "required" projectRoot
    // policy — no config and no .git/ ancestor → non-zero exit with a clear
    // error message naming the required marker.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /vat skills build (?:failed: )?requires a vibe-agent-toolkit\.config\.yaml or \.git\/ ancestor/,
    );
  });

  it('a config with no skills section built nothing, so it is not a verdict: exit 1', async () => {
    const tempDir = suite.createTempDir();
    writeTestFile(safePath.join(tempDir, VAT_CONFIG_FILENAME), EMPTY_CONFIG);

    const { result, report } = await suite.runBuildCommand(tempDir);

    expect(result.status).toBe(1);
    expect(report.examined).toBe(0);
    expect(suite.codesOf(report)).toEqual(['RESOURCE_CHECK_BROKEN']);
  });

  it('include patterns that match no SKILL.md examine nothing: exit 1, and dist/ is untouched', async () => {
    const tempDir = suite.createTempDir();
    suite.createConfigWithSkills(tempDir, ['resources/skills/**/SKILL.md']);
    // Intentionally NOT creating any skill source files

    const { result, report } = await suite.runBuildCommand(tempDir);

    expect(result.status).toBe(1);
    expect(suite.codesOf(report)).toEqual(['RESOURCE_CHECK_BROKEN']);
    expect(existsSync(safePath.join(tempDir, 'dist'))).toBe(false);
  });

  it('should perform dry-run without creating files', async () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillTest(tempDir);

    const { result, report } = await suite.runBuildCommand(tempDir, ['--dry-run']);

    const skills = suite.assertSuccessfulBuild(result, report);
    expect(report.status).toBe('ok');
    expect(report.examined).toBe(1);
    expect(suite.dataOf(report)).toMatchObject({ dryRun: true, validated: false, outputCommitted: false });
    // Relative to the directory whose config the build read — never `$HOME`.
    expect(skills[0]).toMatchObject({ source: 'resources/skills/SKILL.md', output: `dist/skills/${TEST_SKILL_NAME}` });
    expect(existsSync(safePath.join(tempDir, 'dist'))).toBe(false);
  });

  it('should build a valid skill', async () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillTest(tempDir);

    const { result, report } = await suite.runBuildCommand(tempDir);

    const skills = suite.assertSuccessfulBuild(result, report);
    expect(suite.dataOf(report)).toMatchObject({ dryRun: false, validated: true, skillsBuilt: 1, outputCommitted: true });
    expect(skills[0]).toMatchObject({ output: `dist/skills/${TEST_SKILL_NAME}` });

    // Verify output directory was created
    const outputPath = safePath.join(tempDir, 'dist', 'skills', TEST_SKILL_NAME);
    const skillMd = safePath.join(outputPath, 'SKILL.md');
    expect(readFileSync(skillMd, 'utf-8')).toContain(TEST_SKILL_NAME);
  });

  it('should build specific skill with --skill flag', async () => {
    const tempDir = suite.createTempDir();
    suite.createSkillSource(tempDir, 'resources/skills/skill-a.md', SKILL_A_NAME);
    suite.createSkillSource(tempDir, 'resources/skills/skill-b.md', SKILL_B_NAME);
    suite.createConfigWithSkills(tempDir, ['resources/skills/*.md']);

    const { result, report } = await suite.runBuildCommand(tempDir, ['--skill', SKILL_B_NAME]);

    expect(result.status).toBe(0);
    expect(report.examined).toBe(1);
    expect(suite.dataOf(report).skillsBuilt).toBe(1);
    expect(suite.dataOf(report).skills.map((row) => row.name)).toEqual([SKILL_B_NAME]);

    // Verify only skill-b was built
    const outputPathB = safePath.join(tempDir, 'dist', 'skills', SKILL_B_NAME);
    expect(readFileSync(safePath.join(outputPathB, 'SKILL.md'), 'utf-8')).toContain(SKILL_B_NAME);

    // Skill A should not exist (only skill-b was built). Asserted directly rather
    // than via a try/catch whose `catch` block ended in `expect(true).toBe(true)` —
    // that shape passed on ANY throw, including a bug in the path construction.
    const outputPathA = safePath.join(tempDir, 'dist', 'skills', SKILL_A_NAME);
    expect(existsSync(safePath.join(outputPathA, 'SKILL.md'))).toBe(false);
  });

  it('should fail when specified skill not found', async () => {
    const tempDir = suite.createTempDir();
    suite.setupSingleSkillTest(tempDir);

    const { result, report } = await suite.runBuildCommand(tempDir, ['--skill', 'nonexistent']);

    expect(result.status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
  });

  describe('publish: false = an in-place skill: validated at source, never bundled', () => {
    /** skill-a pooled, skill-b in-place (`skills.config.skill-b.publish: false`). */
    const setupOnePooledOneInPlace = (tempDir: string): void => {
      suite.createSkillSource(tempDir, 'resources/skills/skill-a.md', SKILL_A_NAME);
      suite.createSkillSource(tempDir, 'resources/skills/skill-b.md', SKILL_B_NAME);
      writeTestFile(
        safePath.join(tempDir, VAT_CONFIG_FILENAME),
        ['skills:', '  include:', '    - "resources/skills/*.md"', '  config:', `    ${SKILL_B_NAME}:`, '      publish: false', ''].join('\n'),
      );
    };

    it('skips the in-place skill with ONE info line, builds the rest, and counts the skip in the document', async () => {
      const tempDir = suite.createTempDir();
      setupOnePooledOneInPlace(tempDir);

      const { result, report } = await suite.runBuildCommand(tempDir);

      expect(result.status).toBe(0);
      // The drop is VISIBLE in the machine output: a build that ships fewer
      // skills than it discovered examines both and names the one it set aside.
      expect(report.examined).toBe(2);
      expect(suite.dataOf(report)).toMatchObject({ skillsBuilt: 1, skillsInPlace: [SKILL_B_NAME] });
      expect(suite.dataOf(report).skills.map((row) => row.name)).toEqual([SKILL_A_NAME]);
      expect(existsSync(safePath.join(tempDir, 'dist', 'skills', SKILL_A_NAME, 'SKILL.md'))).toBe(true);
      expect(existsSync(safePath.join(tempDir, 'dist', 'skills', SKILL_B_NAME))).toBe(false);

      // ONE line names the skipped skills (count + names); the closing tally may
      // repeat the count but never the names.
      const infoLines = result.stderr.split('\n').filter((line) => line.includes(SKILL_B_NAME));
      expect(infoLines).toHaveLength(1);
      expect(infoLines[0]).toContain('1 in-place skill(s)');
      expect(result.stderr).toContain('Found 1 skill(s) to build');
      expect(result.stderr).toContain('Built 1 skill(s) successfully (1 in-place skill(s) not bundled)');
    });

    it('shows the same partition in --dry-run', async () => {
      const tempDir = suite.createTempDir();
      setupOnePooledOneInPlace(tempDir);

      const { result, report } = await suite.runBuildCommand(tempDir, ['--dry-run']);

      expect(result.status).toBe(0);
      expect(suite.dataOf(report)).toMatchObject({ validated: false, skillsInPlace: [SKILL_B_NAME] });
      expect(suite.dataOf(report).skills.map((row) => row.name)).toEqual([SKILL_A_NAME]);
      expect(result.stderr).toContain(SKILL_B_NAME);
      expect(existsSync(safePath.join(tempDir, 'dist'))).toBe(false);
    });

    it('building an in-place skill by name is a findings report, exit 1, naming the config key', async () => {
      const tempDir = suite.createTempDir();
      setupOnePooledOneInPlace(tempDir);

      const { result, report } = await suite.runBuildCommand(tempDir, ['--skill', SKILL_B_NAME]);

      expect(result.status).toBe(1);
      expect(report.status).toBe('findings');
      expect(suite.codesOf(report)).toEqual(['SKILL_BUILD_TARGET_NOT_BUILDABLE']);
      expect(report.findings[0]).toMatchObject({ severity: 'error', location: 'resources/skills/skill-b.md' });
      expect(report.findings[0]?.message).toContain(`skills.config.${SKILL_B_NAME}.publish`);
      expect(result.stderr).toContain(`skills.config.${SKILL_B_NAME}.publish`);
      expect(existsSync(safePath.join(tempDir, 'dist', 'skills'))).toBe(false);
    });

    it('a project whose every skill is in-place (skills.defaults.publish: false) builds nothing and exits 0', async () => {
      const tempDir = suite.createTempDir();
      suite.createSkillSource(tempDir, 'resources/skills/skill-a.md', SKILL_A_NAME);
      suite.createSkillSource(tempDir, 'resources/skills/skill-b.md', SKILL_B_NAME);
      writeTestFile(
        safePath.join(tempDir, VAT_CONFIG_FILENAME),
        ['skills:', '  include:', '    - "resources/skills/*.md"', '  defaults:', '    publish: false', ''].join('\n'),
      );

      const { result, report } = await suite.runBuildCommand(tempDir);

      expect(result.status).toBe(0);
      expect(report.examined).toBe(2);
      expect(suite.dataOf(report)).toMatchObject({ skillsBuilt: 0, skillsInPlace: [SKILL_A_NAME, SKILL_B_NAME], skills: [] });
      // Pinned: `runSkillBuild` over zero specs promotes an EMPTY staging tree, so
      // dist/skills is absent or empty — never a stale bundle from an earlier run.
      const distSkills = safePath.join(tempDir, 'dist', 'skills');
      expect(existsSync(distSkills) ? readdirSync(distSkills) : []).toEqual([]);
    });
  });

  it('should copy files declared in skills.config.<name>.files to the skill output', async () => {
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
    //
    // No `validation.allow` for PACKAGED_UNREFERENCED_FILE: a declared `files:`
    // dest is VAT's own copy and is exempt from that check by construction, so
    // the allow entry it used to carry is dead — and a dead allow entry would now
    // itself emit ALLOW_UNUSED.
    const configContent = [
      'skills:',
      '  include:',
      '    - "resources/skills/**/SKILL.md"',
      '  config:',
      `    ${TEST_SKILL_NAME}:`,
      '      files:',
      '        - source: dist/bin/tool.mjs',
      '          dest: scripts/tool.mjs',
      '',
    ].join('\n');
    writeTestFile(safePath.join(tempDir, VAT_CONFIG_FILENAME), configContent);

    const { result } = await suite.runBuildCommand(tempDir);

    expect(result.status).toBe(0);

    // The declared file should exist in the packaged skill output
    const expectedDest = safePath.join(tempDir, 'dist', 'skills', TEST_SKILL_NAME, 'scripts', 'tool.mjs');
    const content = readFileSync(expectedDest, 'utf-8');
    expect(content).toContain('console.log("tool")');
  });

  // A `files:` source that is THERE and the OS will not read passes the
  // packager's existence check; the copy is what fails. That is the skill's
  // content refused — a contained finding beside the other skills' builds, not
  // a defect in VAT that drops the whole run.
  it.skipIf(CANNOT_DENY_READS)('a files: source the OS will not read is that skill\'s SKILL_PACKAGING_FAILED, exit 1, and the other skill still builds', async () => {
    const tempDir = suite.createTempDir();
    writeTestFile(safePath.join(tempDir, PACKAGE_JSON_FILENAME), JSON.stringify({ name: 'unreadable-source-workspace', workspaces: [] }));
    suite.createSkillSource(tempDir, 'resources/skills/skill-a.md', SKILL_A_NAME);
    suite.createSkillSource(tempDir, 'resources/skills/skill-b.md', SKILL_B_NAME);
    const locked = safePath.join(tempDir, 'assets', 'locked.bin');
    mkdirSyncReal(safePath.join(tempDir, 'assets'), { recursive: true });
    writeTestFile(locked, 'payload\n');
    writeTestFile(
      safePath.join(tempDir, VAT_CONFIG_FILENAME),
      ['skills:', '  include:', '    - "resources/skills/*.md"', '  config:', `    ${SKILL_A_NAME}:`, '      files:', '        - source: assets/locked.bin', '          dest: scripts/locked.bin', ''].join('\n'),
    );
    chmodSync(locked, 0o000);

    try {
      const { result, report } = await suite.runBuildCommand(tempDir);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(report.status).toBe('findings');
      expect(report.findings.filter((finding) => finding.severity === 'error').map(({ code, location }) => ({ code, location }))).toEqual([
        { code: 'SKILL_PACKAGING_FAILED', location: 'resources/skills/skill-a.md' },
      ]);
      expect(report.findings.find((finding) => finding.code === 'SKILL_PACKAGING_FAILED')?.message).toContain("Could not read files: source 'assets/locked.bin'");
      expect(suite.dataOf(report)).toMatchObject({ skillsBuilt: 1, skillsFailed: 1, outputCommitted: false });
      // Both rows are published; only the refused skill's is in error.
      expect(suite.dataOf(report).skills.map((row) => row.name)).toEqual([SKILL_A_NAME, SKILL_B_NAME]);
    } finally {
      chmodSync(locked, 0o644);
    }
  });
});

/**
 * Helper: create a project whose SKILL.md links to a file that does not exist and
 * is not declared as a build artifact → LINK_MISSING_TARGET (default
 * severity=error), so the build must exit 1.
 *
 * This fixture used to express "an error-severity code fails the build" by
 * injecting a file via `files:` with no markdown link, expecting
 * PACKAGED_UNREFERENCED_FILE. That was the fixture encoding a BUG as expected
 * behaviour: a declared `files:` dest is VAT's own copy, and the rule engine
 * always intended to exempt it (`ctx.inFilesConfig`) — the post-build check just
 * never received the list. Now that the exemption works, `files:` can no longer
 * produce that code, so the intent needed a different, config-reachable error.
 */
function setupProjectWithMissingLinkTarget(
  tempDir: string,
  skillName: string,
): string {
  const projectDir = safePath.join(tempDir, 'missing-link-target');
  mkdirSyncReal(projectDir, { recursive: true });

  // package.json to establish project root
  writeTestFile(
    safePath.join(projectDir, PACKAGE_JSON_FILENAME),
    JSON.stringify({ name: 'missing-link-target-test', workspaces: [] }),
  );

  // SKILL.md links to bin/runner.mjs, which is never created and never declared.
  mkdirSyncReal(safePath.join(projectDir, 'skills'), { recursive: true });
  writeTestFile(
    safePath.join(projectDir, 'skills', 'SKILL.md'),
    `${SKILL_FRONTMATTER_TEMPLATE(skillName)}\nSee [the runner](bin/runner.mjs).\n`,
  );

  // Config: no files: entry for that path, so the link is a genuine dangling link
  // rather than a deferred build artifact (which would be info LINK_DEFERRED_ARTIFACT).
  const configContent = [
    'skills:',
    '  include:',
    '    - "skills/SKILL.md"',
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

/**
 * Helper: `skills/<name>/SKILL.md` links `../shared.md` — outside the skill
 * directory, inside the project — with the given extra lines under
 * `skills.config.<name>` (e.g. a `validation.severity` block).
 */
function setupProjectLinkingSharedDoc(tempDir: string, skillName: string, skillConfigLines: string[]): string {
  const projectDir = safePath.join(tempDir, 'shared-doc');
  mkdirSyncReal(safePath.join(projectDir, 'skills', skillName), { recursive: true });
  writeTestFile(
    safePath.join(projectDir, 'skills', skillName, 'SKILL.md'),
    `${SKILL_FRONTMATTER_TEMPLATE(skillName)}\nSee [shared](../shared.md).\n`,
  );
  writeTestFile(safePath.join(projectDir, 'skills', 'shared.md'), '# Shared\n\nShared guidance.\n');
  writeTestFile(
    safePath.join(projectDir, VAT_CONFIG_FILENAME),
    ['skills:', '  include:', `    - "skills/${skillName}/SKILL.md"`, '  config:', `    ${skillName}:`, ...skillConfigLines, ''].join('\n'),
  );
  return projectDir;
}

describe('skills build — framework exit codes (system test)', () => {
  const DEPTH_DROP_SKILL = 'depth-drop-skill';
  const MISSING_TARGET_SKILL = 'missing-target-skill';

  let suite: ReturnType<typeof setupSkillsBuildTestSuite>;

  beforeAll(() => {
    suite = setupSkillsBuildTestSuite();
  });

  afterEach(() => {
    suite.cleanup();
  });

  it('exits non-zero when LINK_DROPPED_BY_DEPTH is set to severity=error', async () => {
    const tempDir = suite.createTempDir();
    const projectDir = setupProjectWithDepthDrop(tempDir, DEPTH_DROP_SKILL);

    const { result: cmdResult } = await suite.runBuildCommand(projectDir);

    expect(cmdResult.status).toBe(1);
    expect(cmdResult.stderr + cmdResult.stdout).toContain('LINK_DROPPED_BY_DEPTH');
  });

  it('exits zero when LINK_DROPPED_BY_DEPTH error is suppressed via allow', async () => {
    const tempDir = suite.createTempDir();
    const projectDir = setupProjectWithDepthDropAndAllow(tempDir, DEPTH_DROP_SKILL);

    const { result: cmdResult } = await suite.runBuildCommand(projectDir);

    expect(cmdResult.status).toBe(0);
  });

  it('exits non-zero when LINK_MISSING_TARGET fires (default severity=error)', async () => {
    const tempDir = suite.createTempDir();
    const projectDir = setupProjectWithMissingLinkTarget(tempDir, MISSING_TARGET_SKILL);

    const { result: cmdResult, report } = await suite.runBuildCommand(projectDir);

    expect(cmdResult.status).toBe(1);
    // Named in the document, not only on stderr: the finding that failed the build
    // is on the envelope with its location, and the output was not committed.
    expect(report.status).toBe('findings');
    expect(suite.codesOf(report)).toContain('LINK_MISSING_TARGET');
    expect(suite.dataOf(report)).toMatchObject({ skillsFailedValidation: 1, outputCommitted: false });
    expect(suite.dataOf(report).skills).toEqual([
      { name: MISSING_TARGET_SKILL, source: 'skills/SKILL.md', output: `dist/skills/${MISSING_TARGET_SKILL}`, status: 'findings' },
    ]);
    // The severity is rendered as itself, so a reader can tell WHICH finding
    // failed the build rather than inferring it from the exit code.
    expect(cmdResult.stderr + cmdResult.stdout).toContain('[ERROR] [LINK_MISSING_TARGET]');
  });

  describe('LINK_OUTSIDE_SKILL_DIR — a link out of the skill directory', () => {
    const SHARED_DOC_SKILL = 'shared-doc-skill';

    it('by default bundles the target, rewrites the link, and reports nothing', async () => {
      const projectDir = setupProjectLinkingSharedDoc(suite.createTempDir(), SHARED_DOC_SKILL, ['      linkFollowDepth: 1']);

      const { result: cmdResult } = await suite.runBuildCommand(projectDir);

      expect(cmdResult.status).toBe(0);
      expect(cmdResult.stderr + cmdResult.stdout).not.toContain('LINK_OUTSIDE_SKILL_DIR');
      const outputDir = safePath.join(projectDir, 'dist', 'skills', SHARED_DOC_SKILL);
      expect(readdirSync(outputDir, { recursive: true }).map(String).filter((entry) => entry.endsWith('shared.md'))).toHaveLength(1);
      expect(readFileSync(safePath.join(outputDir, 'SKILL.md'), 'utf-8')).not.toContain('../shared.md');
    });

    it('at severity error fails the build naming the code, instead of bundling and rewriting', async () => {
      const projectDir = setupProjectLinkingSharedDoc(suite.createTempDir(), SHARED_DOC_SKILL, [
        CONFIG_VALIDATION_INDENT,
        '        severity:',
        '          LINK_OUTSIDE_SKILL_DIR: error',
      ]);

      const { result: cmdResult } = await suite.runBuildCommand(projectDir);

      expect(cmdResult.status).toBe(1);
      expect(cmdResult.stderr + cmdResult.stdout).toContain('[ERROR] [LINK_OUTSIDE_SKILL_DIR]');
      expect(existsSync(safePath.join(projectDir, 'dist', 'skills', SHARED_DOC_SKILL, 'SKILL.md'))).toBe(false);
    });
  });
});

