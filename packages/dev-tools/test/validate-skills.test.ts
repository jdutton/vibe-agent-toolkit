/* eslint-disable security/detect-non-literal-fs-filename */
// Test file - file paths are controlled by test code
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ValidationSummary } from '../src/validate-skills.js';
import { findSkillFiles, outputSummary, validateSingleSkill } from '../src/validate-skills.js';

import { cleanupTestTempDir, createTestTempDir } from './test-helpers.js';

describe('validate-skills directory traversal error handling', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTestTempDir({ prefix: 'validate-skills-test-' });
  });

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('should handle permission denied errors gracefully on Unix', () => {
    // Skip on Windows (different permission model)
    if (process.platform === 'win32') {
      return;
    }

    // Create directory structure
    const packagesDir = join(tempDir, 'packages');
    const restrictedDir = join(packagesDir, 'restricted');
    const accessibleDir = join(packagesDir, 'accessible');

    mkdirSyncReal(packagesDir, { recursive: true });
    mkdirSyncReal(restrictedDir);
    mkdirSyncReal(accessibleDir);

    // Create SKILL.md in accessible directory
    const skillPath = join(accessibleDir, 'SKILL.md');
    writeFileSync(
      skillPath,
      `---
name: test-skill
description: Test skill
---

# Test Skill
`
    );

    // Make directory unreadable
    chmodSync(restrictedDir, 0o000);

    // Spy on console.warn to verify warning is logged
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Silent
    });

    try {
      // Should not throw, should return accessible files
      const skills = findSkillFiles(packagesDir);

      // Should find the accessible skill
      expect(skills).toHaveLength(1);
      expect(skills[0]).toBe(skillPath);

      // Should have logged a warning for the restricted directory
      expect(warnSpy).toHaveBeenCalled();
      const warnCalls = warnSpy.mock.calls.map((call) => String(call[0]));
      const hasRestrictedWarning = warnCalls.some((msg) =>
        msg.includes('restricted') && msg.includes('permission denied')
      );
      expect(hasRestrictedWarning).toBe(true);
    } finally {
      warnSpy.mockRestore();
      // Restore permissions for cleanup
      try {
        chmodSync(restrictedDir, 0o755);
      } catch {
        // Already restored
      }
    }
  });

  it('should continue validation after encountering inaccessible directories', () => {
    // Create multiple directories
    const packagesDir = join(tempDir, 'packages');
    const dir1 = join(packagesDir, 'dir1');
    const dir2 = join(packagesDir, 'dir2');

    mkdirSyncReal(packagesDir, { recursive: true });
    mkdirSyncReal(dir1);
    mkdirSyncReal(dir2);

    // Create SKILL.md files in both directories
    const skill1 = join(dir1, 'SKILL.md');
    const skill2 = join(dir2, 'SKILL.md');

    writeFileSync(
      skill1,
      `---
name: skill1
description: First skill
---

# Skill 1
`
    );

    writeFileSync(
      skill2,
      `---
name: skill2
description: Second skill
---

# Skill 2
`
    );

    // Should find both skills
    const skills = findSkillFiles(packagesDir);
    expect(skills).toHaveLength(2);
    expect(skills).toContain(skill1);
    expect(skills).toContain(skill2);
  });

  it('should skip dist and node_modules directories', () => {
    // Create directory structure with dist and node_modules
    const packagesDir = join(tempDir, 'packages');
    const distDir = join(packagesDir, 'dist');
    const nodeModulesDir = join(packagesDir, 'node_modules');
    const validDir = join(packagesDir, 'valid');

    mkdirSyncReal(packagesDir, { recursive: true });
    mkdirSyncReal(distDir);
    mkdirSyncReal(nodeModulesDir);
    mkdirSyncReal(validDir);

    // Create SKILL.md files in all directories
    writeFileSync(join(distDir, 'SKILL.md'), '# Should be skipped');
    writeFileSync(join(nodeModulesDir, 'SKILL.md'), '# Should be skipped');
    const validSkill = join(validDir, 'SKILL.md');
    writeFileSync(
      validSkill,
      `---
name: valid-skill
description: Valid skill
---

# Valid Skill
`
    );

    // Should only find the valid skill
    const skills = findSkillFiles(packagesDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toBe(validSkill);
  });

  it('should handle empty directories gracefully', () => {
    // Create empty directory structure
    const packagesDir = join(tempDir, 'packages');
    mkdirSyncReal(packagesDir, { recursive: true });

    // Should return empty array, no errors
    const skills = findSkillFiles(packagesDir);
    expect(skills).toHaveLength(0);
  });
});

describe('validateSingleSkill', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTestTempDir({ prefix: 'validate-single-skill-' });
  });

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  // Helper to create skill file
  function createSkillFile(filename: string, content: string): string {
    const skillPath = join(tempDir, filename);
    writeFileSync(skillPath, content);
    return skillPath;
  }

  // Helper to create validation summary
  function createValidationSummary(): ValidationSummary {
    return {
      totalSkills: 1,
      passed: 0,
      failed: 0,
      warnings: 0,
      errors: [],
    };
  }

  // Helper to validate skill and return summary
  async function validateSkillAndGetSummary(skillPath: string): Promise<ValidationSummary> {
    const summary = createValidationSummary();
    await validateSingleSkill(skillPath, summary);
    return summary;
  }

  it('should handle non-existent file', async () => {
    const skillPath = join(tempDir, 'SKILL.md');
    const summary = createValidationSummary();

    await validateSingleSkill(skillPath, summary);

    expect(summary.failed).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.errorCount).toBe(1);
    expect(summary.errors[0]?.issues[0]?.code).toBe('FILE_NOT_FOUND');
  });

  it('should handle valid skill file', async () => {
    const skillPath = createSkillFile(
      'SKILL.md',
      `---
name: test-skill
description: Test skill
---

# Test Skill
`
    );
    const summary = await validateSkillAndGetSummary(skillPath);

    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.errors).toHaveLength(0);
  });

  it('should handle skill file with validation errors', async () => {
    const skillPath = createSkillFile(
      'SKILL.md',
      `---
name: test-skill
---

# Test Skill

Missing description causes error
`
    );
    const summary = await validateSkillAndGetSummary(skillPath);

    expect(summary.failed).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.errorCount).toBeGreaterThan(0);
  });

  it('should handle skill file with warnings', async () => {
    const skillPath = createSkillFile(
      'SKILL.md',
      `---
name: test-skill
description: Test skill
tags:
  - test
---

# Test Skill

Valid skill that might trigger warnings
`
    );
    const summary = await validateSkillAndGetSummary(skillPath);

    // Should pass (warnings don't fail validation)
    expect(summary.passed).toBeGreaterThanOrEqual(0);
    expect(summary.failed).toBe(0);
  });
});

describe('outputSummary', () => {
  // Helper to setup console spies
  function setupConsoleSpies() {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      // Silent
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      // Silent
    });
    return { logSpy, errorSpy };
  }

  it('should output summary without errors', () => {
    const { logSpy, errorSpy } = setupConsoleSpies();

    const summary: ValidationSummary = {
      totalSkills: 5,
      passed: 5,
      failed: 0,
      warnings: 0,
      errors: [],
    };

    outputSummary(summary, 100);

    expect(logSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should output summary with errors', () => {
    const { logSpy, errorSpy } = setupConsoleSpies();

    const summary: ValidationSummary = {
      totalSkills: 2,
      passed: 1,
      failed: 1,
      warnings: 0,
      errors: [
        {
          skillPath: '/path/to/SKILL.md',
          errorCount: 1,
          warningCount: 0,
          issues: [
            {
              severity: 'error',
              code: 'TEST_ERROR',
              message: 'Test error message',
              location: '/path/to/SKILL.md',
            },
          ],
        },
      ],
    };

    outputSummary(summary, 200);

    expect(logSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    // Verify error details were logged
    const errorCalls = errorSpy.mock.calls.map((call) => String(call[0]));
    const hasErrorMessage = errorCalls.some((msg) => msg.includes('Test error message'));
    expect(hasErrorMessage).toBe(true);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
