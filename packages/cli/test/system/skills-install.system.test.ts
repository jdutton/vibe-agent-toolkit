/* eslint-disable security/detect-non-literal-fs-filename */
// Test fixtures legitimately use dynamic file paths

/**
 * System tests for skills install command
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  executeCommandAndParse,
  setupInstallTestSuite,
} from './test-helpers/index.js';

const suite = setupInstallTestSuite('vat-skills-install-test-');

/**
 * Helper: Create a simple skill directory with SKILL.md
 */
async function createSimpleSkill(tempDir: string, skillName: string): Promise<string> {
  const skillDir = join(tempDir, skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '# Test Skill\nA test skill');
  return skillDir;
}

/**
 * Helper: Execute install command and verify success
 */
function executeInstallAndExpectSuccess(
  binPath: string,
  args: string[],
  projectDir: string,
  expectedSkillName: string,
  expectedSourceType: string
): void {
  const { result, parsed } = executeCommandAndParse(binPath, args, projectDir);

  expect(result.status).toBe(0);
  expect(parsed.status).toBe('success');
  expect(parsed.sourceType).toBe(expectedSourceType);

  const skills = parsed.skills as Array<Record<string, unknown>>;
  expect(skills).toHaveLength(1);
  expect(skills[0]).toHaveProperty('name', expectedSkillName);
}

describe('skills install command (system test)', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  describe('source detection', () => {
    it('should detect ZIP source', async () => {
      const zipPath = join(suite.tempDir, 'test-skill.zip');
      await writeFile(zipPath, 'fake zip content');

      const { result, parsed } = executeCommandAndParse(
        suite.binPath,
        ['skills', 'install', zipPath, '-s', suite.skillsDir, '--dry-run'],
        suite.projectDir
      );

      expect(result.status).toBe(0);
      expect(parsed.status).toBe('success');
      expect(parsed.sourceType).toBe('zip');
      expect(parsed.dryRun).toBe(true);
    });

    it('should detect local directory source', async () => {
      const dirPath = join(suite.tempDir, 'test-skill-dir');
      await mkdir(dirPath, { recursive: true });

      const { result, parsed } = executeCommandAndParse(
        suite.binPath,
        ['skills', 'install', dirPath, '-s', suite.skillsDir, '--dry-run'],
        suite.projectDir
      );

      expect(result.status).toBe(0);
      expect(parsed.status).toBe('success');
      expect(parsed.sourceType).toBe('local');
      expect(parsed.dryRun).toBe(true);
    });

    it('should throw error for invalid source', () => {
      const { result } = executeCommandAndParse(
        suite.binPath,
        ['skills', 'install', '/nonexistent/path', '-s', suite.skillsDir],
        suite.projectDir
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Cannot detect source type');
    });
  });

  describe('local directory installation', () => {
    it('should install from plain directory', async () => {
      // Create test skill directory
      const skillDir = await createSimpleSkill(suite.tempDir, 'my-skill');

      executeInstallAndExpectSuccess(
        suite.binPath,
        ['skills', 'install', skillDir, '-s', suite.skillsDir],
        suite.projectDir,
        'my-skill',
        'local'
      );

      // Verify skill was installed
      const installedPath = join(suite.skillsDir, 'my-skill');
      expect(existsSync(installedPath)).toBe(true);
      expect(existsSync(join(installedPath, 'SKILL.md'))).toBe(true);
    });

    it('should install from directory with package.json vat metadata', async () => {
      const skillName = 'my-vat-skill';

      // Create package directory
      const packageDir = join(suite.tempDir, 'test-package');
      await mkdir(packageDir, { recursive: true });

      // Create skill output directory
      const skillOutputDir = join(packageDir, 'dist', 'skills', skillName);
      await mkdir(skillOutputDir, { recursive: true });
      await writeFile(join(skillOutputDir, 'SKILL.md'), '# VAT Skill\nFrom package');

      // Create package.json with vat metadata
      const packageJson = {
        name: '@test/my-package',
        version: '1.0.0',
        vat: {
          version: '1.0',
          type: 'agent-bundle',
          skills: [
            {
              name: skillName,
              source: './resources/skills/SKILL.md',
              path: `./dist/skills/${skillName}`,
            },
          ],
        },
      };
      await writeFile(join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2));

      const { result, parsed } = executeCommandAndParse(
        suite.binPath,
        ['skills', 'install', packageDir, '-s', suite.skillsDir],
        suite.projectDir
      );

      expect(result.status).toBe(0);
      expect(parsed.status).toBe('success');
      expect(parsed.sourceType).toBe('local');

      const skills = parsed.skills as Array<Record<string, unknown>>;
      expect(skills).toHaveLength(1);
      expect(skills[0]).toHaveProperty('name', skillName);

      // Verify skill was installed
      const installedPath = join(suite.skillsDir, skillName);
      expect(existsSync(installedPath)).toBe(true);
      expect(existsSync(join(installedPath, 'SKILL.md'))).toBe(true);
    });

    it('should use custom name when --name provided', async () => {
      const customName = 'custom-name';
      const originalName = 'original-name';
      const skillDir = join(suite.tempDir, originalName);
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# Test');

      const { result, parsed } = executeCommandAndParse(
        suite.binPath,
        ['skills', 'install', skillDir, '-s', suite.skillsDir, '--name', customName],
        suite.projectDir
      );

      expect(result.status).toBe(0);
      const skills = parsed.skills as Array<Record<string, unknown>>;
      expect(skills[0]).toHaveProperty('name', customName);

      // Verify installed with custom name
      expect(existsSync(join(suite.skillsDir, customName))).toBe(true);
      expect(existsSync(join(suite.skillsDir, originalName))).toBe(false);
    });
  });

  describe('ZIP installation', () => {
    it('should install from ZIP file', async () => {
      // Note: Would need adm-zip to create real ZIP, testing with mock
      // For now, test dry-run mode
      const zipPath = join(suite.tempDir, 'skill.zip');
      await writeFile(zipPath, 'fake zip');

      executeInstallAndExpectSuccess(
        suite.binPath,
        ['skills', 'install', zipPath, '-s', suite.skillsDir, '--dry-run'],
        suite.projectDir,
        'skill',
        'zip'
      );

      const { parsed } = executeCommandAndParse(
        suite.binPath,
        ['skills', 'install', zipPath, '-s', suite.skillsDir, '--dry-run'],
        suite.projectDir
      );
      expect(parsed.dryRun).toBe(true);
    });
  });

  describe('--force flag', () => {
    it('should overwrite existing skill with --force', async () => {
      const skillDir = join(suite.tempDir, 'my-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# Version 1');

      // Install first time
      executeCommandAndParse(
        suite.binPath,
        ['skills', 'install', skillDir, '-s', suite.skillsDir],
        suite.projectDir
      );

      // Update skill content
      await writeFile(join(skillDir, 'SKILL.md'), '# Version 2');

      // Install again with --force
      const { result, parsed } = executeCommandAndParse(
        suite.binPath,
        ['skills', 'install', skillDir, '-s', suite.skillsDir, '--force'],
        suite.projectDir
      );

      expect(result.status).toBe(0);
      expect(parsed.status).toBe('success');
    });

    it('should fail without --force if skill exists', async () => {
      const skillDir = join(suite.tempDir, 'my-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# Test');

      // Install first time
      executeCommandAndParse(
        suite.binPath,
        ['skills', 'install', skillDir, '-s', suite.skillsDir],
        suite.projectDir
      );

      // Try to install again without --force
      const { result } = executeCommandAndParse(
        suite.binPath,
        ['skills', 'install', skillDir, '-s', suite.skillsDir],
        suite.projectDir
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('already exists');
      expect(result.stderr).toContain('--force');
    });
  });

  describe('--dry-run mode', () => {
    it('should preview installation without creating files', async () => {
      const skillDir = await createSimpleSkill(suite.tempDir, 'my-skill');

      executeInstallAndExpectSuccess(
        suite.binPath,
        ['skills', 'install', skillDir, '-s', suite.skillsDir, '--dry-run'],
        suite.projectDir,
        'my-skill',
        'local'
      );

      const { parsed } = executeCommandAndParse(
        suite.binPath,
        ['skills', 'install', skillDir, '-s', suite.skillsDir, '--dry-run'],
        suite.projectDir
      );
      expect(parsed.dryRun).toBe(true);

      // Verify nothing was actually installed
      expect(existsSync(join(suite.skillsDir, 'my-skill'))).toBe(false);
    });
  });
});
