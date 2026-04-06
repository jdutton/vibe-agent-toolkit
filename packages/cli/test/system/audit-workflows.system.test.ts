/**
 * Task 9: End-to-End Workflow Tests
 *
 * Tests complete audit workflows from start to finish.
 * Verifies mixed resource types, error detection, and successful validation.
 */

import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCli,
  getBinPath,
  writeTestFile,
} from './test-common.js';

describe('Audit Workflows (system test)', () => {
  let binPath: string;
  let tempDir: string;

  // Constant for no-recursive flag to avoid string duplication
  const NO_RECURSIVE_FLAG = '--no-recursive';

  beforeAll(() => {
    binPath = getBinPath(import.meta.url);
    tempDir = createTestTempDir('vat-audit-workflow-');
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it('should handle mixed resource directory (marketplace + plugins + skills)', () => {
    const mixedDir = safePath.join(tempDir, 'mixed');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mixedDir is controlled in tests
    fs.mkdirSync(mixedDir, { recursive: true });

    // Create a marketplace structure
    const marketplaceDir = safePath.join(mixedDir, 'my-marketplace');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- marketplaceDir is controlled in tests
    fs.mkdirSync(marketplaceDir, { recursive: true });
    writeTestFile(
      safePath.join(marketplaceDir, '.claude-plugin'),
      JSON.stringify({
        type: 'marketplace',
        name: 'my-marketplace',
        resources: [{ path: 'skill.skill.md' }],
      })
    );
    writeTestFile(
      safePath.join(marketplaceDir, 'SKILL.md'),
      `---
name: marketplace-skill
description: Marketplace skill
---

# Marketplace Skill

Test content.
`
    );

    // Create a standalone plugin
    const pluginDir = safePath.join(mixedDir, 'my-plugin');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pluginDir is controlled in tests
    fs.mkdirSync(pluginDir, { recursive: true });
    writeTestFile(
      safePath.join(pluginDir, '.claude-plugin'),
      JSON.stringify({
        type: 'plugin',
        name: 'my-plugin',
        resources: [{ path: 'skill2.skill.md' }],
      })
    );
    writeTestFile(
      safePath.join(pluginDir, 'SKILL.md'),
      `---
name: plugin-skill
description: Plugin skill
---

# Plugin Skill

Test content.
`
    );

    // Create a standalone skill (no .claude-plugin)
    writeTestFile(
      safePath.join(mixedDir, 'SKILL.md'),
      `---
name: standalone-skill
description: Standalone skill
---

# Standalone Skill

Test content.
`
    );

    // Recursive is now the default — no flag needed
    const result = executeCli(binPath, ['audit', mixedDir], {
      cwd: tempDir,
    });

    // Should handle mixed resources without crashing
    expect([0, 1]).toContain(result.status);

    // Should produce output
    expect(result.stdout).toBeTruthy();

    // Should not have system errors
    expect(result.status).not.toBe(2);
  });

  it('should detect and report multiple validation errors', () => {
    const errorDir = safePath.join(tempDir, 'errors');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- errorDir is controlled in tests
    fs.mkdirSync(errorDir, { recursive: true });

    // Create an invalid skill (invalid name format — uppercase not allowed)
    // Note: must create subdirectory since scanDirectory only finds SKILL.md in directories
    const errorDir1 = safePath.join(errorDir, 'skill1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- errorDir1 is controlled in tests
    fs.mkdirSync(errorDir1, { recursive: true });
    writeTestFile(
      safePath.join(errorDir1, 'SKILL.md'),
      `---
name: Invalid_Skill_Name
description: Has invalid name format
---

# Invalid Skill

Test content.
`
    );

    // Create another invalid skill (name too long — exceeds 64 chars)
    const errorDir2 = safePath.join(errorDir, 'skill2');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- errorDir2 is controlled in tests
    fs.mkdirSync(errorDir2, { recursive: true });
    writeTestFile(
      safePath.join(errorDir2, 'SKILL.md'),
      `---
name: ${'a'.repeat(65)}
description: Name exceeds max length
---

# Another Invalid Skill

Test content.
`
    );

    // Recursive is now the default — no flag needed
    const result = executeCli(binPath, ['audit', errorDir], {
      cwd: tempDir,
    });

    // Should exit with validation error code (1)
    expect(result.status).toBe(1);

    // Should report errors in stderr
    expect(result.stderr).toBeTruthy();

    // Should include error details (field validation errors)
    expect(result.stderr.toLowerCase()).toContain('name');
  });

  it('should exit with 0 for fully valid resources', () => {
    const validDir = safePath.join(tempDir, 'valid');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- validDir is controlled in tests
    fs.mkdirSync(validDir, { recursive: true });

    // Create valid skills (each in subdirectory since scanDirectory looks for SKILL.md)
    const validDir1 = safePath.join(validDir, 'skill1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- validDir1 is controlled in tests
    fs.mkdirSync(validDir1, { recursive: true });
    writeTestFile(
      safePath.join(validDir1, 'SKILL.md'),
      `---
name: valid-skill-1
description: Valid skill 1
---

# Valid Skill 1

Test content.
`
    );

    const validDir2 = safePath.join(validDir, 'skill2');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- validDir2 is controlled in tests
    fs.mkdirSync(validDir2, { recursive: true });
    writeTestFile(
      safePath.join(validDir2, 'SKILL.md'),
      `---
name: valid-skill-2
description: Valid skill 2
---

# Valid Skill 2

Test content.
`
    );

    // Recursive is now the default — no flag needed
    const result = executeCli(binPath, ['audit', validDir], {
      cwd: tempDir,
    });

    // Should exit with success code
    expect(result.status).toBe(0);

    // Should produce output
    expect(result.stdout).toBeTruthy();

    // Should have minimal or no errors in stderr (success message may appear)
    // Success messages in CLI may go to stderr for human-readable output
    if (result.stderr) {
      expect(result.stderr.toLowerCase()).toContain('success');
    }
  });

  it('should scan recursively by default without --recursive flag', () => {
    const nestedDir = safePath.join(tempDir, 'nested-default');
    const nestedSkillDir = safePath.join(nestedDir, 'deeply', 'nested', 'skill-dir');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- nestedSkillDir is controlled in tests
    fs.mkdirSync(nestedSkillDir, { recursive: true });

    writeTestFile(
      safePath.join(nestedSkillDir, 'SKILL.md'),
      `---
name: nested-skill
description: A deeply nested skill for testing recursive default
---

# Nested Skill

This skill is deeply nested to verify recursive scanning is the default.
`
    );

    // Run audit WITHOUT any recursive flag — should find the nested skill by default
    const result = executeCli(binPath, ['audit', nestedDir], {
      cwd: tempDir,
    });

    // Should exit successfully (skill is valid)
    expect(result.status).toBe(0);

    // Should produce output (skill was found and audited)
    expect(result.stdout).toBeTruthy();

    // The nested skill should appear in output, confirming recursive scan found it
    expect(result.stdout).toContain('nested-skill');
  });

  it('should NOT scan subdirectories with --no-recursive flag', () => {
    const noRecurseDir = safePath.join(tempDir, 'no-recurse');
    const subDir = safePath.join(noRecurseDir, 'subdir');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- subDir is controlled in tests
    fs.mkdirSync(subDir, { recursive: true });

    // Create SKILL.md only in the subdirectory (not the top level)
    writeTestFile(
      safePath.join(subDir, 'SKILL.md'),
      `---
name: subdir-skill
description: A skill in a subdirectory that should not be found with --no-recursive
---

# Subdir Skill

This skill should not be found when using --no-recursive.
`
    );

    // Run audit WITH --no-recursive — should NOT find the nested skill
    const result = executeCli(binPath, ['audit', noRecurseDir, NO_RECURSIVE_FLAG], {
      cwd: tempDir,
    });

    // Should exit 0 (no resources found at top level = no errors, just nothing audited)
    expect(result.status).toBe(0);

    // The scan ran and produced output (e.g., filesScanned count)
    expect(result.stdout).toContain('filesScanned');

    // The subdir skill should NOT appear in output
    expect(result.stdout).not.toContain('subdir-skill');
  });

  it('should exclude paths matching --exclude glob', () => {
    const excludeDir = safePath.join(tempDir, 'exclude-test');
    const distDir = safePath.join(excludeDir, 'dist');
    const srcDir = safePath.join(excludeDir, 'src');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(distDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(srcDir, { recursive: true });

    // Create a skill in dist/ (should be excluded)
    writeTestFile(
      safePath.join(distDir, 'SKILL.md'),
      `---
name: dist-skill
description: A skill in the dist directory that should be excluded
---

# Dist Skill

This skill is in dist/ and should be excluded by --exclude.
`
    );

    // Create a valid skill in src/ (should NOT be excluded)
    writeTestFile(
      safePath.join(srcDir, 'SKILL.md'),
      `---
name: src-skill
description: A skill in the src directory that should be included
---

# Src Skill

This skill is in src/ and should be included.
`
    );

    // Run audit with --exclude "dist/**" — should exclude the dist skill
    const result = executeCli(binPath, ['audit', excludeDir, '--exclude', 'dist/**'], {
      cwd: tempDir,
    });

    // Should exit 0 (src-skill is valid)
    expect(result.status).toBe(0);

    // src-skill SHOULD appear in output (it was not excluded)
    expect(result.stdout).toContain('src-skill');

    // dist-skill should NOT be in output
    expect(result.stdout).not.toContain('dist-skill');
  });
});
