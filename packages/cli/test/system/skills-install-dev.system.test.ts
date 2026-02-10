/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
// Test fixtures legitimately use dynamic file paths

/**
 * System tests for skills install --dev command
 * Tests symlink-based development installation from package.json vat.skills[]
 */

import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  executeCli,
  executeCliAndParseYaml,
  setupDevTestProject,
} from './test-helpers.js';

const binPath = join(process.cwd(), 'packages', 'cli', 'dist', 'bin.js');

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(normalizedTmpdir(), 'vat-install-dev-test-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Setup a dev test case: creates skillsDir and projectDir with given skills
 */
function setupTestCase(
  name: string,
  skills: Array<{ name: string; built: boolean }>
): { skillsDir: string; projectDir: string } {
  const skillsDir = join(tmpDir, `skills-${name}`);
  mkdirSyncReal(skillsDir, { recursive: true });
  const projectDir = setupDevTestProject(tmpDir, `proj-${name}`, skills);
  return { skillsDir, projectDir };
}

/**
 * Execute --dev install and return parsed YAML result
 */
function executeDevInstall(
  skillsDir: string,
  projectDir: string,
  extraArgs: string[] = []
): ReturnType<typeof executeCliAndParseYaml> {
  return executeCliAndParseYaml(
    binPath,
    ['skills', 'install', '--dev', '-s', skillsDir, ...extraArgs],
    { cwd: projectDir }
  );
}

describe('skills install --dev command (system test)', () => {
  it('should symlink a single skill', () => {
    const { skillsDir, projectDir } = setupTestCase('single', [
      { name: 'my-skill', built: true },
    ]);

    const { status, parsed } = executeDevInstall(skillsDir, projectDir);

    expect(status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.sourceType).toBe('dev');
    expect(parsed.symlink).toBe(true);
    expect(parsed.skillsInstalled).toBe(1);

    const installedPath = join(skillsDir, 'my-skill');
    expect(existsSync(installedPath)).toBe(true);
    expect(lstatSync(installedPath).isSymbolicLink()).toBe(true);
  });

  it('should symlink all skills from multi-skill package', () => {
    const { skillsDir, projectDir } = setupTestCase('multi', [
      { name: 'skill-alpha', built: true },
      { name: 'skill-beta', built: true },
    ]);

    const { status, parsed } = executeDevInstall(skillsDir, projectDir);

    expect(status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.skillsInstalled).toBe(2);
    expect(lstatSync(join(skillsDir, 'skill-alpha')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(skillsDir, 'skill-beta')).isSymbolicLink()).toBe(true);
  });

  it('should filter by --name', () => {
    const { skillsDir, projectDir } = setupTestCase('filter', [
      { name: 'wanted-skill', built: true },
      { name: 'other-skill', built: true },
    ]);

    const { status, parsed } = executeDevInstall(skillsDir, projectDir, ['--name', 'wanted-skill']);

    expect(status).toBe(0);
    expect(parsed.skillsInstalled).toBe(1);
    expect(existsSync(join(skillsDir, 'wanted-skill'))).toBe(true);
    expect(existsSync(join(skillsDir, 'other-skill'))).toBe(false);
  });

  it('should fail when skill not built', () => {
    const { skillsDir, projectDir } = setupTestCase('not-built', [
      { name: 'unbuilt-skill', built: false },
    ]);

    const result = executeCli(
      binPath,
      ['skills', 'install', '--dev', '-s', skillsDir],
      { cwd: projectDir }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not built');
  });

  it('should not create symlinks with --dry-run', () => {
    const { skillsDir, projectDir } = setupTestCase('dryrun', [
      { name: 'dry-skill', built: true },
    ]);

    const { status, parsed } = executeDevInstall(skillsDir, projectDir, ['--dry-run']);

    expect(status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.dryRun).toBe(true);
    expect(parsed.skillsInstalled).toBe(1);
    expect(existsSync(join(skillsDir, 'dry-skill'))).toBe(false);
  });

  it('should fail without --force when skill exists', () => {
    const { skillsDir, projectDir } = setupTestCase('exists', [
      { name: 'dup-skill', built: true },
    ]);

    // First install succeeds
    const first = executeDevInstall(skillsDir, projectDir);
    expect(first.status).toBe(0);

    // Second install without --force fails
    const result = executeCli(
      binPath,
      ['skills', 'install', '--dev', '-s', skillsDir],
      { cwd: projectDir }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('already installed');
  });

  it('should overwrite with --force', () => {
    const { skillsDir, projectDir } = setupTestCase('force', [
      { name: 'force-skill', built: true },
    ]);

    // First install
    const first = executeDevInstall(skillsDir, projectDir);
    expect(first.status).toBe(0);

    // Second install with --force
    const { status, parsed } = executeDevInstall(skillsDir, projectDir, ['--force']);

    expect(status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.skillsInstalled).toBe(1);
    expect(lstatSync(join(skillsDir, 'force-skill')).isSymbolicLink()).toBe(true);
  });
});
