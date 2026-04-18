/**
 * System tests for `vat skill review <path>`.
 *
 * Verifies the end-to-end command: it runs, prints the expected sections,
 * and exits with the expected code for clean vs. problematic fixtures.
 */

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createSuiteContext,
  executeCli,
  writeTestFile,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-skill-review-';

/** SKILL.md with clean frontmatter and no issues worth reporting. */
function makeCleanSkill(name: string): string {
  // Description starts with a verb phrase, is specific, >=50 chars, <=250 chars.
  const description =
    `Reviews widgets for quality. Use when a reviewer wants a checklist walkthrough of a widget in depth.`;
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nPurpose statement goes here.\n\nDoes one thing well.\n`;
}

/** SKILL.md that will trigger at least one quality finding. */
function makeProblemSkill(name: string): string {
  // Filler opener "This skill..." triggers SKILL_DESCRIPTION_FILLER_OPENER.
  const description =
    `This skill is used for when you need to review widgets for quality and completeness of the widget content.`;
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;
}

function setupCleanSkillDir(tempDir: string): string {
  const skillDir = safePath.join(tempDir, 'clean-skill');
  mkdirSyncReal(skillDir, { recursive: true });
  writeTestFile(safePath.join(skillDir, 'SKILL.md'), makeCleanSkill('clean-skill'));
  return skillDir;
}

function setupProblemSkillDir(tempDir: string): string {
  const skillDir = safePath.join(tempDir, 'problem-skill');
  mkdirSyncReal(skillDir, { recursive: true });
  writeTestFile(safePath.join(skillDir, 'SKILL.md'), makeProblemSkill('problem-skill'));
  return skillDir;
}

const ctx = createSuiteContext(TEMP_DIR_PREFIX, import.meta.url);

describe('vat skill review (system test)', () => {
  beforeAll(ctx.setup);
  afterEach(ctx.cleanup);

  it('exits 0 and prints manual checklist for a clean skill', () => {
    const tempDir = ctx.createTempDir();
    const skillDir = setupCleanSkillDir(tempDir);

    const result = executeCli(ctx.binPath, ['skill', 'review', skillDir]);

    expect(result.status).toBe(0);
    // Manual checklist always rendered
    expect(result.stderr).toContain('Manual review checklist');
    // Human report identifies the skill
    expect(result.stderr).toContain('Reviewing skill: clean-skill');
    // Summary line is present
    expect(result.stderr).toMatch(/Summary: \d+ error/);
  });

  it('accepts a path to SKILL.md directly', () => {
    const tempDir = ctx.createTempDir();
    const skillDir = setupCleanSkillDir(tempDir);
    const skillPath = safePath.join(skillDir, 'SKILL.md');

    const result = executeCli(ctx.binPath, ['skill', 'review', skillPath]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Reviewing skill: clean-skill');
  });

  it('exits 1 when a skill has warnings and reports findings under the correct section', () => {
    const tempDir = ctx.createTempDir();
    const skillDir = setupProblemSkillDir(tempDir);

    const result = executeCli(ctx.binPath, ['skill', 'review', skillDir]);

    expect(result.status).toBe(1);
    // Filler-opener warning should be emitted in the Description section
    expect(result.stderr).toContain('SKILL_DESCRIPTION_FILLER_OPENER');
    expect(result.stderr).toContain('Description');
    // Manual checklist still printed for reviewer walkthrough
    expect(result.stderr).toContain('Manual review checklist');
  });

  it('emits YAML on stdout when --yaml is passed', () => {
    const tempDir = ctx.createTempDir();
    const skillDir = setupCleanSkillDir(tempDir);

    const result = executeCli(ctx.binPath, ['skill', 'review', skillDir, '--yaml']);

    expect(result.status).toBe(0);
    // YAML block begins with the document marker
    expect(result.stdout.startsWith('---\n')).toBe(true);
    expect(result.stdout).toContain('skill: clean-skill');
    expect(result.stdout).toContain('manual:');
  });

  it('exits 2 when the path does not exist', () => {
    const tempDir = ctx.createTempDir();
    const missing = safePath.join(tempDir, 'nope', 'SKILL.md');

    const result = executeCli(ctx.binPath, ['skill', 'review', missing]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Path does not exist');
  });

  it('exits 2 when the directory has no SKILL.md', () => {
    const tempDir = ctx.createTempDir();
    const emptyDir = safePath.join(tempDir, 'empty');
    mkdirSyncReal(emptyDir, { recursive: true });

    const result = executeCli(ctx.binPath, ['skill', 'review', emptyDir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('No SKILL.md found');
  });

  it('help text documents input, exit codes, and yaml mode', () => {
    const result = executeCli(ctx.binPath, ['skill', 'review', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Description:');
    expect(result.stdout).toContain('Exit Codes:');
    expect(result.stdout).toContain('--yaml');
    expect(result.stdout).toContain('Example:');
  });
});
