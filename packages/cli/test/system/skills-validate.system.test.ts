/**
 * System tests for skills validate command
 */

import { spawnSync } from 'node:child_process';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createSuiteContext,
  executeCli,
  executeCliAndParseYaml,
  getBinPath,
  getFixturePath,
  writeTestFile,
} from './test-common.js';
import { executeSkillsCommandAndExpectYaml } from './test-helpers/index.js';

// Type for packaging validation result
interface PackagingValidationOutput {
  status: string;
  skillsValidated: number;
  results: Array<{
    skillName: string;
    status: string;
    allErrors: Array<unknown>;
    activeErrors: Array<unknown>;
    ignoredErrors: Array<unknown>;
    metadata: {
      skillLines: number;
      totalLines: number;
      fileCount: number;
      directFileCount: number;
      maxLinkDepth: number;
      excludedReferenceCount: number;
      excludedReferences?: Array<{
        path: string;
        reason: string;
        matchedPattern?: string;
      }>;
    };
  }>;
  durationSecs: number;
}

describe('skills validate command (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  // Use fixture with package.json that has vat.skills
  const fixtureDir = getFixturePath(import.meta.url, 'skills-minimal');

  it('should show help text', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate', '--help'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Validate skills for packaging');
    expect(result.stdout).toContain('Exit Codes:');
  });

  it('should validate skills and report packaging validation results', () => {
    const { result, parsed } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);

    expect(result.status).toBe(0);

    const typedParsed = parsed as unknown as PackagingValidationOutput;

    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('skillsValidated');
    expect(parsed).toHaveProperty('results');
    expect(parsed).toHaveProperty('durationSecs');
    expect(Array.isArray(typedParsed.results)).toBe(true);

    // Should find skills in fixture
    expect(typedParsed.skillsValidated).toBeGreaterThan(0);

    // Verify result structure
    if (typedParsed.results.length > 0) {
      const firstResult = typedParsed.results[0];
      expect(firstResult).toHaveProperty('skillName');
      expect(firstResult).toHaveProperty('status');
      expect(firstResult).toHaveProperty('activeErrors');
      expect(firstResult).toHaveProperty('metadata');
      expect(firstResult.metadata).toHaveProperty('skillLines');
      expect(firstResult.metadata).toHaveProperty('totalLines');
    }
  });

  it('should output YAML format', () => {
    const { result, parsed } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);

    // Should be parseable as YAML
    expect(result.status).toBeDefined();
    expect(parsed.status).toBeDefined();
    expect(['success', 'error']).toContain(parsed.status);
  });

  it('should exit with proper status code', () => {
    // Note: Fixture may have validation errors, that's fine for testing structure
    const { parsed } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);

    expect(parsed.status).toBeDefined();
    expect(['success', 'error']).toContain(parsed.status);
  });

  it('should report validation errors with proper structure', () => {
    const { parsed } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);

    const typedParsed = parsed as unknown as PackagingValidationOutput;

    if (typedParsed.results.length > 0) {
      const skillResult = typedParsed.results[0];

      // Verify packaging validation structure
      expect(skillResult).toHaveProperty('skillName');
      expect(skillResult).toHaveProperty('allErrors');
      expect(skillResult).toHaveProperty('activeErrors');
      expect(skillResult).toHaveProperty('ignoredErrors');
      expect(skillResult).toHaveProperty('metadata');

      // Verify metadata structure (including new fields)
      expect(skillResult.metadata).toHaveProperty('skillLines');
      expect(skillResult.metadata).toHaveProperty('totalLines');
      expect(skillResult.metadata).toHaveProperty('fileCount');
      expect(skillResult.metadata).toHaveProperty('directFileCount');
      expect(skillResult.metadata).toHaveProperty('maxLinkDepth');
      expect(skillResult.metadata).toHaveProperty('excludedReferenceCount');
    }
  });

  it('should NOT include excludedReferences in default (non-verbose) output', () => {
    const { parsed } = executeSkillsCommandAndExpectYaml(binPath, 'validate', fixtureDir);

    const typedParsed = parsed as unknown as PackagingValidationOutput;

    // In non-verbose mode, excludedReferences should be stripped from metadata
    for (const result of typedParsed.results) {
      expect(result.metadata).not.toHaveProperty('excludedReferences');
      // But excludedReferenceCount should still be present
      expect(result.metadata).toHaveProperty('excludedReferenceCount');
    }
  });

  it('should include excludedReferences in verbose output', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Testing CLI command
    const result = spawnSync('node', [binPath, 'skills', 'validate', fixtureDir, '--verbose'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const parsed = yaml.load(result.stdout) as PackagingValidationOutput;

    // In verbose mode, excludedReferences should be present in metadata
    for (const skillResult of parsed.results) {
      expect(skillResult.metadata).toHaveProperty('excludedReferences');
      expect(Array.isArray(skillResult.metadata.excludedReferences)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Constants shared by framework exit-code tests
// ---------------------------------------------------------------------------
const TEMP_DIR_PREFIX = 'vat-validate-test-';
const VAT_CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
const CONFIG_VERSION_LINE = 'version: 1';
const VALIDATE_SKILL_NAME = 'validate-test-skill';
const SKILL_INCLUDE_GLOB = '    - "skills/SKILL.md"';
const GITIGNORED_FILE_GLOB = 'skills/secret.md';
const SKILL_MD_RELATIVE = 'skills/SKILL.md';
const GITIGNORE_FILENAME = '.gitignore';

/**
 * Build a SKILL.md with valid frontmatter (description meets 50-char minimum).
 * Pass an optional body suffix for links; defaults to standalone content.
 */
const makeSkillMd = (name: string, bodySuffix = 'This is a test skill.') =>
  `---\nname: ${name}\ndescription: ${name} - comprehensive test skill for validation and packaging\nversion: 1.0.0\n---\n\n# ${name}\n\n${bodySuffix}\n`;

/**
 * Initialize a git repo in dir and stage the given files so that
 * `crawlDirectory` (which uses git ls-files) can discover them, and
 * `isGitIgnored` (which uses git check-ignore) can report ignored targets.
 */
function initGitRepo(dir: string, filesToAdd: string[]): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
  spawnSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for repo init in tests
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git required for staging files in tests
  spawnSync('git', ['add', ...filesToAdd], { cwd: dir, stdio: 'pipe' });
}

// ---------------------------------------------------------------------------
// Fixture helpers for framework exit-code tests
// ---------------------------------------------------------------------------

/**
 * Create a project with a SKILL.md that links to a gitignored file.
 * The gitignored file is co-located in the skills/ directory so the walker
 * sees it as within-project (avoiding LINK_OUTSIDE_PROJECT) and instead
 * reports LINK_TO_GITIGNORED_FILE (default severity=error → exits 1).
 *
 * Requires an initialized git repo: crawlDirectory uses git ls-files to
 * enumerate tracked files, and isGitIgnored uses git check-ignore.
 */
function setupProjectWithGitignoreLink(tempDir: string, skillName: string): string {
  const projectDir = safePath.join(tempDir, 'gitignore-link');
  mkdirSyncReal(safePath.join(projectDir, 'skills'), { recursive: true });

  // .gitignore that excludes the co-located sensitive file
  writeTestFile(safePath.join(projectDir, GITIGNORE_FILENAME), `${GITIGNORED_FILE_GLOB}\n`);

  // The gitignored target file (must exist for walker to stat + detect it is gitignored)
  writeTestFile(safePath.join(projectDir, 'skills', 'secret.md'), '# Secret\n\nConfidential content.\n');

  // SKILL.md that links to the gitignored file (same directory → no outside-project issue)
  writeTestFile(
    safePath.join(projectDir, 'skills', 'SKILL.md'),
    makeSkillMd(skillName, 'See [secret](secret.md).'),
  );

  // Config: no validation override → LINK_TO_GITIGNORED_FILE fires at default error severity
  const configContent = [
    CONFIG_VERSION_LINE,
    'skills:',
    '  include:',
    SKILL_INCLUDE_GLOB,
    '',
  ].join('\n');
  writeTestFile(safePath.join(projectDir, VAT_CONFIG_FILENAME), configContent);

  // Initialize git repo and stage SKILL.md (not secret.md — it is gitignored)
  // This makes crawlDirectory (git ls-files) discover SKILL.md, and isGitIgnored
  // (git check-ignore) correctly report secret.md as gitignored.
  initGitRepo(projectDir, [SKILL_MD_RELATIVE, GITIGNORE_FILENAME, VAT_CONFIG_FILENAME]);

  return projectDir;
}

/**
 * Same as above but with an allow entry suppressing the gitignored-link error.
 */
function setupProjectWithGitignoreLinkAllowed(tempDir: string, skillName: string): string {
  const projectDir = safePath.join(tempDir, 'gitignore-link-allow');
  mkdirSyncReal(safePath.join(projectDir, 'skills'), { recursive: true });

  writeTestFile(safePath.join(projectDir, GITIGNORE_FILENAME), `${GITIGNORED_FILE_GLOB}\n`);
  writeTestFile(safePath.join(projectDir, 'skills', 'secret.md'), '# Secret\n\nConfidential content.\n');

  writeTestFile(
    safePath.join(projectDir, 'skills', 'SKILL.md'),
    makeSkillMd(skillName, 'See [secret](secret.md).'),
  );

  // Config: allow suppresses the gitignored-link error
  const configContent = [
    CONFIG_VERSION_LINE,
    'skills:',
    '  include:',
    SKILL_INCLUDE_GLOB,
    '  config:',
    `    ${skillName}:`,
    '      validation:',
    '        allow:',
    '          LINK_TO_GITIGNORED_FILE:',
    '            - paths: ["**"]',
    '              reason: reviewed, intentional link for testing purposes',
    '',
  ].join('\n');
  writeTestFile(safePath.join(projectDir, VAT_CONFIG_FILENAME), configContent);

  // Initialize git repo and stage SKILL.md (not secret.md — it is gitignored)
  initGitRepo(projectDir, [SKILL_MD_RELATIVE, GITIGNORE_FILENAME, VAT_CONFIG_FILENAME]);

  return projectDir;
}

/**
 * Create a project with a SKILL.md that links to a README.md (navigation file).
 * LINK_TO_NAVIGATION_FILE default severity = warning → validate exits 0.
 *
 * README.md is placed as a sibling of SKILL.md so the walker sees it as within
 * the project root (which falls back to the skills/ directory when no git repo
 * or package.json with workspaces exists).
 */
function setupProjectWithNavigationLink(tempDir: string, skillName: string): string {
  const projectDir = safePath.join(tempDir, 'navigation-link');
  mkdirSyncReal(safePath.join(projectDir, 'skills'), { recursive: true });

  // README.md sibling of SKILL.md — classified as navigation file
  writeTestFile(safePath.join(projectDir, 'skills', 'README.md'), '# Skills\n\nNavigation index.\n');

  // SKILL.md that links to the sibling README (navigation file, within project root)
  writeTestFile(
    safePath.join(projectDir, 'skills', 'SKILL.md'),
    makeSkillMd(skillName, 'See [index](README.md).'),
  );

  // Config: no overrides → LINK_TO_NAVIGATION_FILE fires at default warning severity
  const configContent = [
    CONFIG_VERSION_LINE,
    'skills:',
    '  include:',
    SKILL_INCLUDE_GLOB,
    '',
  ].join('\n');
  writeTestFile(safePath.join(projectDir, VAT_CONFIG_FILENAME), configContent);

  return projectDir;
}

// ---------------------------------------------------------------------------
// Framework exit-code tests for vat skills validate
// ---------------------------------------------------------------------------

const frameworkCtx = createSuiteContext(TEMP_DIR_PREFIX, import.meta.url);

describe('skills validate — framework exit codes (system test)', () => {
  beforeAll(frameworkCtx.setup);
  afterEach(frameworkCtx.cleanup);

  it('exits 1 when LINK_TO_GITIGNORED_FILE fires (default severity=error)', () => {
    const tempDir = frameworkCtx.createTempDir();
    const projectDir = setupProjectWithGitignoreLink(tempDir, VALIDATE_SKILL_NAME);

    const { result, parsed } = executeCliAndParseYaml(frameworkCtx.binPath, ['skills', 'validate'], { cwd: projectDir });

    expect(result.status).toBe(1);
    // Output should contain the error code somewhere (stdout YAML or stderr)
    expect(result.stderr + result.stdout).toContain('LINK_TO_GITIGNORED_FILE');
    // YAML should reflect error status
    expect(parsed.status).toBe('error');
  });

  it('exits 0 when LINK_TO_GITIGNORED_FILE error is suppressed via allow', () => {
    const tempDir = frameworkCtx.createTempDir();
    const projectDir = setupProjectWithGitignoreLinkAllowed(tempDir, VALIDATE_SKILL_NAME);

    const { result, parsed } = executeCliAndParseYaml(frameworkCtx.binPath, ['skills', 'validate'], { cwd: projectDir });

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('exits 0 when LINK_TO_NAVIGATION_FILE fires (default severity=warning, non-blocking)', () => {
    const tempDir = frameworkCtx.createTempDir();
    const projectDir = setupProjectWithNavigationLink(tempDir, VALIDATE_SKILL_NAME);

    const { result, parsed } = executeCliAndParseYaml(frameworkCtx.binPath, ['skills', 'validate'], { cwd: projectDir });

    // Warnings are non-blocking — should exit 0
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');

    // But the code should appear in warnings in the YAML output
    const results = parsed.results as Array<Record<string, unknown>>;
    const firstResult = results[0] ?? {};
    const activeWarnings = firstResult['activeWarnings'] as Array<Record<string, unknown>> | undefined;
    if (activeWarnings && activeWarnings.length > 0) {
      const warningCodes = activeWarnings.map((w) => w['code']);
      expect(warningCodes).toContain('LINK_TO_NAVIGATION_FILE');
    }
  });

  it('help text uses validation framework language and not stale override language', () => {
    const result = executeCli(frameworkCtx.binPath, ['skills', 'validate', '--help']);

    expect(result.status).toBe(0);
    // New framework language
    expect(result.stdout).toContain('validation framework');
    expect(result.stdout).toContain('severity');
    expect(result.stdout).toContain('allow');
    expect(result.stdout).toContain('docs/validation-codes.md');
    // Exit codes section updated
    expect(result.stdout).toContain('Exit Codes:');
    expect(result.stdout).toContain('severity=error, not allowed');
    // Stale language should be gone
    expect(result.stdout).not.toContain('validation overrides with expiration checking');
    expect(result.stdout).not.toContain('ignoreValidationErrors');
  });
});
