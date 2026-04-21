/**
 * System tests for vat audit — validation framework behavior (Task 14)
 *
 * Locks in three invariants:
 * 1. Audit always exits 0, even when severity=error issues are present.
 * 2. Audit ignores validation.allow — allowed codes are still shown.
 * 3. Audit respects validation.severity: 'ignore' — ignored codes are hidden.
 */

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createSuiteContext,
  executeCli,
  executeCliAndParseYaml,
  writeTestFile,
} from './test-common.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEMP_DIR_PREFIX = 'vat-audit-framework-';
const VAT_CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
const SKILL_MD_RELATIVE = 'skills/SKILL.md';
const SKILL_NAME = 'audit-framework-test-skill';

// ---------------------------------------------------------------------------
// SKILL.md helpers
// ---------------------------------------------------------------------------

/**
 * Build a SKILL.md with valid frontmatter and an optional body.
 */
const makeSkillMd = (name: string, body = 'This is a test skill.') =>
  `---\nname: ${name}\ndescription: ${name} - comprehensive test skill for validation\nversion: 1.0.0\n---\n\n# ${name}\n\n${body}\n`;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Create a project whose SKILL.md links to a file OUTSIDE the skill directory.
 *
 * Layout:
 *   projectDir/
 *     skills/
 *       SKILL.md  → links to ../outside.md (LINK_OUTSIDE_PROJECT, severity=warning in audit)
 *     outside.md
 *     vibe-agent-toolkit.config.yaml  (no validation overrides)
 *
 * Because validateSkill (used by audit) emits LINK_OUTSIDE_PROJECT at
 * severity=warning, this fixture verifies: audit exits 0 even when issues
 * are present. Use LINK_MISSING_TARGET (a broken link) to get severity=error.
 */
function setupProjectWithOutsideLink(tempDir: string): string {
  const projectDir = safePath.join(tempDir, 'outside-link');
  mkdirSyncReal(safePath.join(projectDir, 'skills'), { recursive: true });

  // File outside the skill dir (so the link escapes the boundary)
  writeTestFile(safePath.join(projectDir, 'outside.md'), '# Outside\n\nContent.\n');

  // SKILL.md that links to the outside file (LINK_OUTSIDE_PROJECT)
  writeTestFile(
    safePath.join(projectDir, 'skills', 'SKILL.md'),
    makeSkillMd(SKILL_NAME, 'See [outside](../outside.md).'),
  );

  // Config: no validation overrides
  writeTestFile(
    safePath.join(projectDir, VAT_CONFIG_FILENAME),
    'version: 1\nskills:\n  include:\n    - "skills/SKILL.md"\n',
  );

  return projectDir;
}

/**
 * Create a project whose SKILL.md has a broken link (LINK_MISSING_TARGET,
 * severity=error).  No validation.allow in the config.
 *
 * Used to assert that audit exits 0 even when severity=error issues fire.
 */
function setupProjectWithBrokenLink(tempDir: string): string {
  const projectDir = safePath.join(tempDir, 'broken-link');
  mkdirSyncReal(safePath.join(projectDir, 'skills'), { recursive: true });

  // SKILL.md with a link to a non-existent file → LINK_MISSING_TARGET (error)
  writeTestFile(
    safePath.join(projectDir, 'skills', 'SKILL.md'),
    makeSkillMd(SKILL_NAME, 'See [missing](does-not-exist.md).'),
  );

  // Config: no validation overrides
  writeTestFile(
    safePath.join(projectDir, VAT_CONFIG_FILENAME),
    'version: 1\nskills:\n  include:\n    - "skills/SKILL.md"\n',
  );

  return projectDir;
}

/**
 * Create a project with a broken link AND a validation.allow for that code.
 *
 * vat audit must NOT honour allow — the code must still appear in the YAML
 * output and audit must still exit 0.
 */
function setupProjectWithBrokenLinkAllowed(tempDir: string): string {
  const projectDir = safePath.join(tempDir, 'broken-link-allowed');
  mkdirSyncReal(safePath.join(projectDir, 'skills'), { recursive: true });

  writeTestFile(
    safePath.join(projectDir, 'skills', 'SKILL.md'),
    makeSkillMd(SKILL_NAME, 'See [missing](does-not-exist.md).'),
  );

  // Config: allow suppresses LINK_MISSING_TARGET — audit must ignore this
  const configContent = [
    'version: 1',
    'skills:',
    '  include:',
    `    - "${SKILL_MD_RELATIVE}"`,
    '  config:',
    `    ${SKILL_NAME}:`,
    '      validation:',
    '        allow:',
    '          LINK_MISSING_TARGET:',
    '            - paths: ["**"]',
    '              reason: reviewed, intentional for audit framework test',
    '',
  ].join('\n');
  writeTestFile(safePath.join(projectDir, VAT_CONFIG_FILENAME), configContent);

  return projectDir;
}

/**
 * Create a project that emits LINK_OUTSIDE_PROJECT (emitted at severity=warning
 * by validateSkill), and the config sets severity.LINK_OUTSIDE_PROJECT to
 * 'ignore'. Audit must hide this code from its output.
 *
 * Note: audit reads the VATConfig and applies severity to decide what to show,
 * but it does NOT apply allow. Only vat skills validate uses allow.
 */
function setupProjectWithIgnoredSeverity(tempDir: string): string {
  const projectDir = safePath.join(tempDir, 'ignored-severity');
  mkdirSyncReal(safePath.join(projectDir, 'skills'), { recursive: true });

  writeTestFile(safePath.join(projectDir, 'outside.md'), '# Outside\n\nContent.\n');

  writeTestFile(
    safePath.join(projectDir, 'skills', 'SKILL.md'),
    makeSkillMd(SKILL_NAME, 'See [outside](../outside.md).'),
  );

  // Config: severity.LINK_OUTSIDE_PROJECT set to ignore — audit must hide it
  const configContent = [
    'version: 1',
    'skills:',
    '  include:',
    `    - "${SKILL_MD_RELATIVE}"`,
    '  config:',
    `    ${SKILL_NAME}:`,
    '      validation:',
    '        severity:',
    '          LINK_OUTSIDE_PROJECT: ignore',
    '',
  ].join('\n');
  writeTestFile(safePath.join(projectDir, VAT_CONFIG_FILENAME), configContent);

  return projectDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ctx = createSuiteContext(TEMP_DIR_PREFIX, import.meta.url);

describe('vat audit — validation framework behavior (system test)', () => {
  beforeAll(ctx.setup);
  afterEach(ctx.cleanup);

  // -------------------------------------------------------------------------
  // (c) Audit exits 0 even when validation errors are surfaced
  // -------------------------------------------------------------------------
  it('exits 0 even when LINK_MISSING_TARGET fires (severity=error)', () => {
    const tempDir = ctx.createTempDir();
    const projectDir = setupProjectWithBrokenLink(tempDir);

    const { result } = executeCliAndParseYaml(ctx.binPath, ['audit', projectDir]);

    // Audit must ALWAYS exit 0 for validation results
    expect(result.status).toBe(0);
    // The YAML should contain the error code in some form (stdout or stderr combined)
    expect(result.stderr + result.stdout).toContain('LINK_MISSING_TARGET');
  });

  // -------------------------------------------------------------------------
  // (a) Audit shows LINK_MISSING_TARGET even when validation.allow would
  //     silence it in `vat skills validate`
  // -------------------------------------------------------------------------
  it('shows LINK_MISSING_TARGET even when validation.allow is set (allow is ignored by audit)', () => {
    const tempDir = ctx.createTempDir();
    const projectDir = setupProjectWithBrokenLinkAllowed(tempDir);

    const { result } = executeCliAndParseYaml(ctx.binPath, ['audit', projectDir]);

    // Status must be 0 regardless
    expect(result.status).toBe(0);
    // The broken link code must still appear — allow is NOT honoured by audit
    expect(result.stderr + result.stdout).toContain('LINK_MISSING_TARGET');
  });

  // -------------------------------------------------------------------------
  // (b) Audit hides codes when severity is 'ignore' in config
  // -------------------------------------------------------------------------
  it('hides LINK_OUTSIDE_PROJECT when severity.LINK_OUTSIDE_PROJECT is ignore', () => {
    const tempDir = ctx.createTempDir();
    const projectDir = setupProjectWithIgnoredSeverity(tempDir);

    const { result, parsed } = executeCliAndParseYaml(ctx.binPath, ['audit', projectDir]);

    expect(result.status).toBe(0);
    // LINK_OUTSIDE_PROJECT must NOT appear anywhere in the output
    expect(result.stderr + result.stdout).not.toContain('LINK_OUTSIDE_PROJECT');
    // But we should still have a YAML result
    expect(parsed).toHaveProperty('status');
  });

  // -------------------------------------------------------------------------
  // Sanity: audit shows LINK_OUTSIDE_PROJECT when no severity override
  // -------------------------------------------------------------------------
  it('shows LINK_OUTSIDE_PROJECT when no severity override (default behavior)', () => {
    const tempDir = ctx.createTempDir();
    const projectDir = setupProjectWithOutsideLink(tempDir);

    const { result } = executeCliAndParseYaml(ctx.binPath, ['audit', projectDir]);

    expect(result.status).toBe(0);
    expect(result.stderr + result.stdout).toContain('LINK_OUTSIDE_PROJECT');
  });

  // -------------------------------------------------------------------------
  // Help text: audit exit codes updated to reflect advisory-only behavior
  // -------------------------------------------------------------------------
  it('help text documents that audit always exits 0 for validation results', () => {
    const result = executeCli(ctx.binPath, ['audit', '--help']);

    // --help must exit 0
    expect(result.status).toBe(0);
    // Help must convey that 0 is always the exit code for validation results
    expect(result.stdout).toContain('0 - Always');
    // Must reference vat skills validate for gated validation
    expect(result.stdout).toContain('skills validate');
    // Must reference validation-codes.md
    expect(result.stdout).toContain('docs/validation-codes.md');
  });

  // -------------------------------------------------------------------------
  // Audit does NOT use --user path here (just path-based test)
  // This verifies the flat audit path (non-hierarchical) exits 0 on errors
  // -------------------------------------------------------------------------
  it('exits 0 for broken-link skill passed as direct SKILL.md path', () => {
    const tempDir = ctx.createTempDir();
    const projectDir = setupProjectWithBrokenLink(tempDir);
    const skillPath = safePath.join(projectDir, 'skills', 'SKILL.md');

    const { result } = executeCliAndParseYaml(ctx.binPath, ['audit', skillPath]);

    expect(result.status).toBe(0);
    expect(result.stderr + result.stdout).toContain('LINK_MISSING_TARGET');
  });
});
