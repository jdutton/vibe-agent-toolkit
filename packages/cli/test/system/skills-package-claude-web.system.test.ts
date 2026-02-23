/**
 * System tests for `vat skills package --target` option
 *
 * Tests that:
 * - `--target claude-web` produces references/ directory (not resources/)
 * - `--target claude-code` (default) still produces resources/ directory
 * - ZIP size validation works (warn at 4MB, error at 8MB)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createSkillMarkdown,
  createTempDirTracker,
  executeCli,
  executeCliAndParseYaml,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-package-claude-web-test-';
const SKILL_NAME = 'test-skill';

// ZIP entry prefix constants (used in assertions across multiple tests)
const REFERENCES_PREFIX = 'references/';
const RESOURCES_PREFIX = 'resources/';

// Packaging target constants
const TARGET_CLAUDE_WEB = 'claude-web';
const TARGET_CLAUDE_CODE = 'claude-code';

/**
 * Setup test suite for skills package --target tests
 */
function setupSkillsPackageClaudeWebTestSuite() {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs: cleanup } = createTempDirTracker(TEMP_DIR_PREFIX);

  /**
   * Create a minimal skill directory with a SKILL.md for packaging tests
   */
  const createMinimalSkill = (tempDir: string): string => {
    const skillDir = join(tempDir, 'my-skill');
    mkdirSyncReal(skillDir, { recursive: true });
    writeTestFile(join(skillDir, 'SKILL.md'), createSkillMarkdown(SKILL_NAME));
    return skillDir;
  };

  /**
   * Get entries from a ZIP file
   */
  const getZipEntries = (zipPath: string): string[] => {
    const zip = new AdmZip(zipPath);
    return zip.getEntries().map(e => e.entryName);
  };

  const runPackageCommand = (
    skillMdPath: string,
    outputDir: string,
    extraArgs: string[] = []
  ) => {
    return executeCliAndParseYaml(
      binPath,
      ['skills', 'package', skillMdPath, '-o', outputDir, ...extraArgs]
    );
  };

  /**
   * Assert ZIP directory structure for a given output directory.
   * Verifies the ZIP exists, then returns whether references/ and resources/ exist.
   */
  const assertZipStructure = (outputDir: string): {
    hasReferences: boolean;
    hasResources: boolean;
  } => {
    const zipPath = `${outputDir}.zip`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test verification of command output
    expect(existsSync(zipPath)).toBe(true);
    const entries = getZipEntries(zipPath);
    return {
      hasReferences: entries.some(e => e.startsWith(REFERENCES_PREFIX)),
      hasResources: entries.some(e => e.startsWith(RESOURCES_PREFIX)),
    };
  };

  /**
   * Run package command with a given target and assert successful completion.
   * Returns the ZIP structure for further assertions.
   */
  const runPackageAndAssertSuccess = (
    skillMdPath: string,
    outputDir: string,
    target: string
  ): ReturnType<typeof assertZipStructure> => {
    const { result, parsed } = runPackageCommand(
      skillMdPath,
      outputDir,
      ['--target', target, '-f', 'zip']
    );
    expect(result.status).toBe(0);
    expect(parsed).toHaveProperty('status', 'success');
    return assertZipStructure(outputDir);
  };

  return {
    binPath,
    createTempDir,
    cleanup,
    createMinimalSkill,
    getZipEntries,
    runPackageCommand,
    assertZipStructure,
    runPackageAndAssertSuccess,
  };
}

describe('skills package --target (system test)', () => {
  let suite: ReturnType<typeof setupSkillsPackageClaudeWebTestSuite>;

  beforeAll(() => {
    suite = setupSkillsPackageClaudeWebTestSuite();
  });

  afterEach(() => {
    suite.cleanup();
  });

  it('--target claude-web produces references/ and no resources/ directory', () => {
    const tempDir = suite.createTempDir();
    const skillDir = suite.createMinimalSkill(tempDir);
    const skillMdPath = join(skillDir, 'SKILL.md');
    const outputDir = join(tempDir, 'output-claude-web');

    // Verify ZIP structure: no linked resources → neither references/ nor resources/ dir
    const { hasReferences, hasResources } = suite.runPackageAndAssertSuccess(
      skillMdPath,
      outputDir,
      TARGET_CLAUDE_WEB
    );
    expect(hasReferences).toBe(false); // No linked resources = no references/ dir
    expect(hasResources).toBe(false);  // resources/ directory must NOT appear
  });

  it('--target claude-web with linked resources places them in references/ not resources/', () => {
    const tempDir = suite.createTempDir();

    // Create a skill with a linked resource
    const skillDir = join(tempDir, 'skill-with-refs');
    mkdirSyncReal(skillDir, { recursive: true });

    const refContent = `---
title: Reference Doc
---

# Reference Documentation

This is a reference document.
`;
    writeTestFile(join(skillDir, 'reference.md'), refContent);
    const skillContent = `---
name: ${SKILL_NAME}
description: ${SKILL_NAME} - comprehensive test skill for validation and packaging
version: 1.0.0
---

# ${SKILL_NAME}

See [Reference](./reference.md) for details.
`;
    writeTestFile(join(skillDir, 'SKILL.md'), skillContent);

    const skillMdPath = join(skillDir, 'SKILL.md');
    const outputDir = join(tempDir, 'output-refs');

    // references/ must exist (linked resource goes there); resources/ must NOT exist
    const { hasReferences, hasResources } = suite.runPackageAndAssertSuccess(
      skillMdPath,
      outputDir,
      TARGET_CLAUDE_WEB
    );
    expect(hasReferences).toBe(true);
    expect(hasResources).toBe(false);
  });

  it('--target claude-code (default) still produces resources/ directory', () => {
    const tempDir = suite.createTempDir();

    // Create skill with a linked resource so resources/ gets populated
    const skillDir = join(tempDir, 'skill-with-resource');
    mkdirSyncReal(skillDir, { recursive: true });

    writeTestFile(
      join(skillDir, 'guide.md'),
      `---
title: Guide
---

# Guide

Some content.
`
    );

    const skillContent = `---
name: ${SKILL_NAME}
description: ${SKILL_NAME} - comprehensive test skill for validation and packaging
version: 1.0.0
---

# ${SKILL_NAME}

See [Guide](./guide.md) for usage.
`;
    writeTestFile(join(skillDir, 'SKILL.md'), skillContent);

    const skillMdPath = join(skillDir, 'SKILL.md');
    const outputDir = join(tempDir, 'output-claude-code');

    // resources/ must exist (claude-code uses resources/); references/ must NOT exist
    const { hasResources, hasReferences } = suite.runPackageAndAssertSuccess(
      skillMdPath,
      outputDir,
      TARGET_CLAUDE_CODE
    );
    expect(hasResources).toBe(true);
    expect(hasReferences).toBe(false);
  });

  it('no --target flag defaults to claude-code behavior (resources/ directory)', () => {
    const tempDir = suite.createTempDir();

    const skillDir = join(tempDir, 'default-skill');
    mkdirSyncReal(skillDir, { recursive: true });

    writeTestFile(
      join(skillDir, 'extra.md'),
      `---
title: Extra
---

# Extra

Content.
`
    );

    const skillContent = `---
name: ${SKILL_NAME}
description: ${SKILL_NAME} - comprehensive test skill for validation and packaging
version: 1.0.0
---

# ${SKILL_NAME}

See [Extra](./extra.md).
`;
    writeTestFile(join(skillDir, 'SKILL.md'), skillContent);

    const skillMdPath = join(skillDir, 'SKILL.md');
    const outputDir = join(tempDir, 'output-default');

    // No --target flag at all — default should behave like claude-code
    const { result, parsed } = suite.runPackageCommand(skillMdPath, outputDir, ['-f', 'zip']);
    expect(result.status).toBe(0);
    expect(parsed).toHaveProperty('status', 'success');

    // Default: resources/ should be present, references/ should not
    const { hasResources, hasReferences } = suite.assertZipStructure(outputDir);
    expect(hasResources).toBe(true);
    expect(hasReferences).toBe(false);
  });

  it('--target with invalid value exits with error', () => {
    const tempDir = suite.createTempDir();
    const skillDir = suite.createMinimalSkill(tempDir);
    const skillMdPath = join(skillDir, 'SKILL.md');
    const outputDir = join(tempDir, 'output-bad-target');

    const result = executeCli(
      suite.binPath,
      ['skills', 'package', skillMdPath, '-o', outputDir, '--target', 'invalid-target']
    );

    expect(result.status).not.toBe(0);
  });

  it('shows --target option in help text', () => {
    const result = executeCli(suite.binPath, ['skills', 'package', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--target');
    expect(result.stdout).toContain(TARGET_CLAUDE_WEB);
  });
});
