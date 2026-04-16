/**
 * System tests for vat audit — validation framework behavior (Task 14)
 *
 * Locks in three invariants:
 * 1. Audit always exits 0, even when severity=error issues are present.
 * 2. Audit ignores validation.accept — accepted codes are still shown.
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
 * are present. Use LINK_INTEGRITY_BROKEN (a broken link) to get severity=error.
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
 * Create a project whose SKILL.md has a broken link (LINK_INTEGRITY_BROKEN,
 * severity=error).  No validation.accept in the config.
 *
 * Used to assert that audit exits 0 even when severity=error issues fire.
 */
function setupProjectWithBrokenLink(tempDir: string): string {
  const projectDir = safePath.join(tempDir, 'broken-link');
  mkdirSyncReal(safePath.join(projectDir, 'skills'), { recursive: true });

  // SKILL.md with a link to a non-existent file → LINK_INTEGRITY_BROKEN (error)
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
 * Create a project with a broken link AND a validation.accept for that code.
 *
 * vat audit must NOT honour accept — the code must still appear in the YAML
 * output and audit must still exit 0.
 */
function setupProjectWithBrokenLinkAccepted(tempDir: string): string {
  const projectDir = safePath.join(tempDir, 'broken-link-accepted');
  mkdirSyncReal(safePath.join(projectDir, 'skills'), { recursive: true });

  writeTestFile(
    safePath.join(projectDir, 'skills', 'SKILL.md'),
    makeSkillMd(SKILL_NAME, 'See [missing](does-not-exist.md).'),
  );

  // Config: accept suppresses LINK_INTEGRITY_BROKEN — audit must ignore this
  const configContent = [
    'version: 1',
    'skills:',
    '  include:',
    `    - "${SKILL_MD_RELATIVE}"`,
    '  config:',
    `    ${SKILL_NAME}:`,
    '      validation:',
    '        accept:',
    '          LINK_INTEGRITY_BROKEN:',
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
 * but it does NOT apply accept. Only vat skills validate uses accept.
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
  it('exits 0 even when LINK_INTEGRITY_BROKEN fires (severity=error)', () => {
    const tempDir = ctx.createTempDir();
    const projectDir = setupProjectWithBrokenLink(tempDir);

    const { result } = executeCliAndParseYaml(ctx.binPath, ['audit', projectDir]);

    // Audit must ALWAYS exit 0 for validation results
    expect(result.status).toBe(0);
    // The YAML should contain the error code in some form (stdout or stderr combined)
    expect(result.stderr + result.stdout).toContain('LINK_INTEGRITY_BROKEN');
  });

  // -------------------------------------------------------------------------
  // (a) Audit shows LINK_INTEGRITY_BROKEN even when validation.accept would
  //     silence it in `vat skills validate`
  // -------------------------------------------------------------------------
  it('shows LINK_INTEGRITY_BROKEN even when validation.accept is set (accept is ignored by audit)', () => {
    const tempDir = ctx.createTempDir();
    const projectDir = setupProjectWithBrokenLinkAccepted(tempDir);

    const { result } = executeCliAndParseYaml(ctx.binPath, ['audit', projectDir]);

    // Status must be 0 regardless
    expect(result.status).toBe(0);
    // The broken link code must still appear — accept is NOT honoured by audit
    expect(result.stderr + result.stdout).toContain('LINK_INTEGRITY_BROKEN');
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
    expect(result.stderr + result.stdout).toContain('LINK_INTEGRITY_BROKEN');
  });
});
