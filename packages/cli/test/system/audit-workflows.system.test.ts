/**
 * Task 9: End-to-End Workflow Tests
 *
 * Tests complete audit workflows from start to finish.
 * Verifies mixed resource types, error detection, and successful validation.
 */

import * as fs from 'node:fs';
import { join } from 'node:path';

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

  // Constant for recursive flag to avoid string duplication
  const RECURSIVE_FLAG = '--recursive';

  beforeAll(() => {
    binPath = getBinPath(import.meta.url);
    tempDir = createTestTempDir('vat-audit-workflow-');
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it('should handle mixed resource directory (marketplace + plugins + skills)', () => {
    const mixedDir = join(tempDir, 'mixed');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mixedDir is controlled in tests
    fs.mkdirSync(mixedDir, { recursive: true });

    // Create a marketplace structure
    const marketplaceDir = join(mixedDir, 'my-marketplace');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- marketplaceDir is controlled in tests
    fs.mkdirSync(marketplaceDir, { recursive: true });
    writeTestFile(
      join(marketplaceDir, '.claude-plugin'),
      JSON.stringify({
        type: 'marketplace',
        name: 'my-marketplace',
        resources: [{ path: 'skill.skill.md' }],
      })
    );
    writeTestFile(
      join(marketplaceDir, 'SKILL.md'),
      `---
name: marketplace-skill
description: Marketplace skill
---

# Marketplace Skill

Test content.
`
    );

    // Create a standalone plugin
    const pluginDir = join(mixedDir, 'my-plugin');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pluginDir is controlled in tests
    fs.mkdirSync(pluginDir, { recursive: true });
    writeTestFile(
      join(pluginDir, '.claude-plugin'),
      JSON.stringify({
        type: 'plugin',
        name: 'my-plugin',
        resources: [{ path: 'skill2.skill.md' }],
      })
    );
    writeTestFile(
      join(pluginDir, 'SKILL.md'),
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
      join(mixedDir, 'SKILL.md'),
      `---
name: standalone-skill
description: Standalone skill
---

# Standalone Skill

Test content.
`
    );

    const result = executeCli(binPath, ['audit', mixedDir, RECURSIVE_FLAG], {
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
    const errorDir = join(tempDir, 'errors');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- errorDir is controlled in tests
    fs.mkdirSync(errorDir, { recursive: true });

    // Create an invalid skill (missing required description field)
    // Note: must create subdirectory since scanDirectory only finds SKILL.md in directories
    const errorDir1 = join(errorDir, 'skill1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- errorDir1 is controlled in tests
    fs.mkdirSync(errorDir1, { recursive: true });
    writeTestFile(
      join(errorDir1, 'SKILL.md'),
      `---
name: invalid-skill
---

# Invalid Skill

Test content.
`
    );

    // Create another invalid skill (missing required name field)
    const errorDir2 = join(errorDir, 'skill2');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- errorDir2 is controlled in tests
    fs.mkdirSync(errorDir2, { recursive: true });
    writeTestFile(
      join(errorDir2, 'SKILL.md'),
      `---
description: Missing name
---

# Another Invalid Skill

Test content.
`
    );

    const result = executeCli(binPath, ['audit', errorDir, RECURSIVE_FLAG], {
      cwd: tempDir,
    });

    // Should exit with validation error code (1)
    expect(result.status).toBe(1);

    // Should report errors in stderr
    expect(result.stderr).toBeTruthy();

    // Should include error details (field validation errors)
    expect(result.stderr.toLowerCase()).toContain('missing');
  });

  it('should exit with 0 for fully valid resources', () => {
    const validDir = join(tempDir, 'valid');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- validDir is controlled in tests
    fs.mkdirSync(validDir, { recursive: true });

    // Create valid skills (each in subdirectory since scanDirectory looks for SKILL.md)
    const validDir1 = join(validDir, 'skill1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- validDir1 is controlled in tests
    fs.mkdirSync(validDir1, { recursive: true });
    writeTestFile(
      join(validDir1, 'SKILL.md'),
      `---
name: valid-skill-1
description: Valid skill 1
---

# Valid Skill 1

Test content.
`
    );

    const validDir2 = join(validDir, 'skill2');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- validDir2 is controlled in tests
    fs.mkdirSync(validDir2, { recursive: true });
    writeTestFile(
      join(validDir2, 'SKILL.md'),
      `---
name: valid-skill-2
description: Valid skill 2
---

# Valid Skill 2

Test content.
`
    );

    const result = executeCli(binPath, ['audit', validDir, RECURSIVE_FLAG], {
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
});
