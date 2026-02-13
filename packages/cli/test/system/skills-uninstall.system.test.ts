/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
// Test fixtures legitimately use dynamic file paths

/**
 * System tests for skills uninstall command
 * Tests removal of installed skills (directories and symlinks)
 */

import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createInstalledSkillDir,
  executeCli,
  executeCliAndParseYaml,
  parseYamlOutput,
  setupDevTestProject,
} from './test-helpers/index.js';

const binPath = join(process.cwd(), 'packages', 'cli', 'dist', 'bin.js');

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(normalizedTmpdir(), 'vat-uninstall-test-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Execute uninstall and return parsed YAML result
 */
function executeUninstall(
  args: string[]
): ReturnType<typeof executeCliAndParseYaml> {
  return executeCliAndParseYaml(binPath, ['skills', 'uninstall', ...args]);
}

/**
 * Execute uninstall and assert success with 1 skill removed
 */
function executeUninstallAndExpectOneRemoved(
  skillName: string,
  skillsDir: string
): { parsed: Record<string, unknown>; skills: Array<Record<string, unknown>> } {
  const { status, parsed } = executeUninstall([skillName, '-s', skillsDir]);

  expect(status).toBe(0);
  expect(parsed.status).toBe('success');
  expect(parsed.skillsRemoved).toBe(1);

  const skills = parsed.skills as Array<Record<string, unknown>>;
  return { parsed, skills };
}

describe('skills uninstall command (system test)', () => {
  it('should remove a regular directory', () => {
    const skillsDir = join(tmpDir, 'skills-dir-remove');
    mkdirSyncReal(skillsDir, { recursive: true });
    createInstalledSkillDir(skillsDir, 'dir-skill');

    expect(existsSync(join(skillsDir, 'dir-skill'))).toBe(true);

    const { skills } = executeUninstallAndExpectOneRemoved('dir-skill', skillsDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toHaveProperty('name', 'dir-skill');
    expect(skills[0]).toHaveProperty('wasSymlink', false);

    expect(existsSync(join(skillsDir, 'dir-skill'))).toBe(false);
  });

  it('should remove a symlink (target preserved)', () => {
    const skillsDir = join(tmpDir, 'skills-sym-remove');
    mkdirSyncReal(skillsDir, { recursive: true });

    // Create the symlink target (the "built" skill directory)
    const targetDir = join(tmpDir, 'sym-target');
    mkdirSyncReal(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'SKILL.md'), '# Symlinked Skill\nTarget content');

    // Create a symlink in the skills directory pointing to the target
    symlinkSync(targetDir, join(skillsDir, 'sym-skill'), 'dir');

    const { skills } = executeUninstallAndExpectOneRemoved('sym-skill', skillsDir);
    expect(skills[0]).toHaveProperty('wasSymlink', true);

    // Symlink removed, but target still exists
    expect(existsSync(join(skillsDir, 'sym-skill'))).toBe(false);
    expect(existsSync(targetDir)).toBe(true);
    expect(existsSync(join(targetDir, 'SKILL.md'))).toBe(true);
  });

  it('should uninstall all skills from package.json with --all', () => {
    const skillsDir = join(tmpDir, 'skills-all-remove');
    mkdirSyncReal(skillsDir, { recursive: true });

    // Create a project with package.json that declares two skills
    const projectDir = setupDevTestProject(tmpDir, 'proj-all-remove', [
      { name: 'skill-one', built: false },
      { name: 'skill-two', built: false },
    ]);

    // Create the installed skills in the skills directory
    createInstalledSkillDir(skillsDir, 'skill-one');
    createInstalledSkillDir(skillsDir, 'skill-two');

    const result = executeCli(
      binPath,
      ['skills', 'uninstall', '--all', '-s', skillsDir],
      { cwd: projectDir }
    );

    expect(result.status).toBe(0);

    const parsed = parseYamlOutput(result.stdout);
    expect(parsed.status).toBe('success');
    expect(parsed.skillsRemoved).toBe(2);

    expect(existsSync(join(skillsDir, 'skill-one'))).toBe(false);
    expect(existsSync(join(skillsDir, 'skill-two'))).toBe(false);
  });

  it('should fail when skill not installed', () => {
    const skillsDir = join(tmpDir, 'skills-not-found');
    mkdirSyncReal(skillsDir, { recursive: true });

    const result = executeCli(
      binPath,
      ['skills', 'uninstall', 'nonexistent-skill', '-s', skillsDir]
    );

    expect(result.status).not.toBe(0);
  });

  it('should not remove with --dry-run', () => {
    const skillsDir = join(tmpDir, 'skills-dryrun-remove');
    mkdirSyncReal(skillsDir, { recursive: true });
    createInstalledSkillDir(skillsDir, 'kept-skill');

    const { status, parsed } = executeUninstall(['kept-skill', '-s', skillsDir, '--dry-run']);

    expect(status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.dryRun).toBe(true);
    expect(parsed.skillsRemoved).toBe(1);

    // Skill should still exist after dry-run
    expect(existsSync(join(skillsDir, 'kept-skill'))).toBe(true);
    expect(existsSync(join(skillsDir, 'kept-skill', 'SKILL.md'))).toBe(true);
  });
});
