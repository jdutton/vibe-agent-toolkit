/**
 * System tests for `vat skills package --target` option
 *
 * Tests that:
 * - `--target claude-web` produces references/ directory (not resources/)
 * - `--target claude-code` (default) still produces resources/ directory
 * - the document is the report envelope (`SKILLS_PACKAGE_REPORT_SCHEMA`), and the
 *   validation gate's failure is a findings report at exit 1
 * - a claude-web ZIP over claude.ai's 8 MB limit is a `SKILL_PACKAGE_TOO_LARGE`
 *   findings report at exit 1 (one incompressible fixture, written once)
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';


import { exitCodeForReport } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import AdmZip from 'adm-zip';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { SKILLS_PACKAGE_REPORT_SCHEMA } from '../../src/commands/skills/package-schema.js';

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
 * "Packaged successfully" means the gate passed: exit 0 and ZERO errors.
 *
 * The document is the report envelope, so `status` is the literal `ok` /
 * `findings` — this fixture's frontmatter carries a `version` field, a
 * non-blocking finding, so `findings` at exit 0 is a successful package.
 */
function assertPackagedWithoutErrors(parsed: Record<string, unknown>): void {
  const report = SKILLS_PACKAGE_REPORT_SCHEMA.parse(parsed);
  expect(['ok', 'findings']).toContain(report.status);
  expect(report.summary).toMatchObject({ errors: 0 });
  expect(report.examined).toBe(1);
}

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
    const skillDir = safePath.join(tempDir, 'my-skill');
    mkdirSyncReal(skillDir, { recursive: true });
    writeTestFile(safePath.join(skillDir, 'SKILL.md'), createSkillMarkdown(SKILL_NAME));
    return skillDir;
  };

  /**
   * Get entries from a ZIP file
   */
  const getZipEntries = (zipPath: string): string[] => {
    const zip = new AdmZip(zipPath);
    return zip.getEntries().map(e => e.entryName);
  };

  const runPackageCommand = async (
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
  const runPackageAndAssertSuccess = async (
    skillMdPath: string,
    outputDir: string,
    target: string
  ): Promise<ReturnType<typeof assertZipStructure>> => {
    const { result, parsed } = await runPackageCommand(
      skillMdPath,
      outputDir,
      ['--target', target, '-f', 'zip']
    );
    expect(result.status).toBe(0);
    assertPackagedWithoutErrors(parsed);
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

  it('--target claude-web produces references/ and no resources/ directory', async () => {
    const tempDir = suite.createTempDir();
    const skillDir = suite.createMinimalSkill(tempDir);
    const skillMdPath = safePath.join(skillDir, 'SKILL.md');
    const outputDir = safePath.join(tempDir, 'output-claude-web');

    // Verify ZIP structure: no linked resources → neither references/ nor resources/ dir
    const { hasReferences, hasResources } = await suite.runPackageAndAssertSuccess(
      skillMdPath,
      outputDir,
      TARGET_CLAUDE_WEB
    );
    expect(hasReferences).toBe(false); // No linked resources = no references/ dir
    expect(hasResources).toBe(false);  // resources/ directory must NOT appear
  });

  it('--target claude-web with linked resources places them in references/ not resources/', async () => {
    const tempDir = suite.createTempDir();

    // Create a skill with a linked resource
    const skillDir = safePath.join(tempDir, 'skill-with-refs');
    mkdirSyncReal(skillDir, { recursive: true });

    const refContent = `---
title: Reference Doc
---

# Reference Documentation

This is a reference document.
`;
    writeTestFile(safePath.join(skillDir, 'reference.md'), refContent);
    const skillContent = `---
name: ${SKILL_NAME}
description: ${SKILL_NAME} - comprehensive test skill for validation and packaging
version: 1.0.0
---

# ${SKILL_NAME}

See [Reference](./reference.md) for details.
`;
    writeTestFile(safePath.join(skillDir, 'SKILL.md'), skillContent);

    const skillMdPath = safePath.join(skillDir, 'SKILL.md');
    const outputDir = safePath.join(tempDir, 'output-refs');

    // references/ must exist (linked resource goes there); resources/ must NOT exist
    const { hasReferences, hasResources } = await suite.runPackageAndAssertSuccess(
      skillMdPath,
      outputDir,
      TARGET_CLAUDE_WEB
    );
    expect(hasReferences).toBe(true);
    expect(hasResources).toBe(false);
  });

  it('--target claude-code (default) still produces resources/ directory', async () => {
    const tempDir = suite.createTempDir();

    // Create skill with a linked resource so resources/ gets populated
    const skillDir = safePath.join(tempDir, 'skill-with-resource');
    mkdirSyncReal(skillDir, { recursive: true });

    writeTestFile(
      safePath.join(skillDir, 'guide.md'),
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
    writeTestFile(safePath.join(skillDir, 'SKILL.md'), skillContent);

    const skillMdPath = safePath.join(skillDir, 'SKILL.md');
    const outputDir = safePath.join(tempDir, 'output-claude-code');

    // resources/ must exist (claude-code uses resources/); references/ must NOT exist
    const { hasResources, hasReferences } = await suite.runPackageAndAssertSuccess(
      skillMdPath,
      outputDir,
      TARGET_CLAUDE_CODE
    );
    expect(hasResources).toBe(true);
    expect(hasReferences).toBe(false);
  });

  it('no --target flag defaults to claude-code behavior (resources/ directory)', async () => {
    const tempDir = suite.createTempDir();

    const skillDir = safePath.join(tempDir, 'default-skill');
    mkdirSyncReal(skillDir, { recursive: true });

    writeTestFile(
      safePath.join(skillDir, 'extra.md'),
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
    writeTestFile(safePath.join(skillDir, 'SKILL.md'), skillContent);

    const skillMdPath = safePath.join(skillDir, 'SKILL.md');
    const outputDir = safePath.join(tempDir, 'output-default');

    // No --target flag at all — default should behave like claude-code
    const { result, parsed } = await suite.runPackageCommand(skillMdPath, outputDir, ['-f', 'zip']);
    expect(result.status).toBe(0);
    assertPackagedWithoutErrors(parsed);

    // Default: resources/ should be present, references/ should not
    const { hasResources, hasReferences } = suite.assertZipStructure(outputDir);
    expect(hasResources).toBe(true);
    expect(hasReferences).toBe(false);
  });

  it('package gate failure publishes findings with the skill as location, exit 1', async () => {
    const tempDir = suite.createTempDir();
    const skillDir = safePath.join(tempDir, 'broken-skill');
    mkdirSyncReal(skillDir, { recursive: true });
    // No frontmatter at all: the validation gate's own error, before packaging.
    writeTestFile(safePath.join(skillDir, 'SKILL.md'), '# broken\n\nNo frontmatter.\n');
    const outputDir = safePath.join(tempDir, 'output-broken');

    const { result, parsed } = await suite.runPackageCommand(safePath.join(skillDir, 'SKILL.md'), outputDir);
    const report = SKILLS_PACKAGE_REPORT_SCHEMA.parse(parsed);

    expect(result.status, result.stderr).toBe(1);
    expect(exitCodeForReport(report)).toBe(1);
    expect(report.status).toBe('findings');
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'SKILL_MISSING_FRONTMATTER',
      severity: 'error',
      location: expect.stringMatching(/SKILL\.md$/),
    }));
    // Nothing was packaged, and the document says so.
    expect(report.data).toMatchObject({ outputPath: null, dryRun: false });
    expect(existsSync(outputDir)).toBe(false);
  });

  // An output directory the OS will not let the build write says nothing about the
  // skill: the run did not finish (exit 2), and no finding is published against it.
  // Needs a directory whose mode denies a write; Windows and root cannot deny one by mode.
  it.skipIf(CANNOT_DENY_READS)('an output directory that cannot be written is RUN_INCOMPLETE, exit 2 — never a finding about the skill', async () => {
    const tempDir = suite.createTempDir();
    const skillDir = suite.createMinimalSkill(tempDir);
    const readOnly = safePath.join(tempDir, 'read-only');
    mkdirSyncReal(readOnly, { recursive: true });
    chmodSync(readOnly, 0o555);

    try {
      const result = await executeCli(suite.binPath, ['skills', 'package', safePath.join(skillDir, 'SKILL.md'), '-o', safePath.join(readOnly, 'out')]);
      const report = SKILLS_PACKAGE_REPORT_SCHEMA.parse(yaml.parse(result.stdout));

      expect(result.status, result.stderr).toBe(2);
      expect(report).toMatchObject({ status: 'error', error: { code: 'RUN_INCOMPLETE' }, findings: [] });
    } finally {
      chmodSync(readOnly, 0o755);
    }
  });

  // Run from inside this repo, so the project root is found and the ARGUMENT is
  // what is judged: a SKILL.md path naming nothing is the invocation's mistake,
  // in both lanes — never a finding about a skill that was never there.
  it.each([[[]], [['--dry-run']]])('refuses a SKILL.md path naming nothing as USAGE_INVALID, exit 2 (%j)', async (extra) => {
    const tempDir = suite.createTempDir();
    const result = await executeCli(
      suite.binPath,
      ['skills', 'package', safePath.join(tempDir, 'never-created', 'SKILL.md'), '-o', safePath.join(tempDir, 'out'), ...extra],
    );

    expect(result.status, result.stderr).toBe(2);
    expect(SKILLS_PACKAGE_REPORT_SCHEMA.parse(yaml.parse(result.stdout))).toMatchObject({
      status: 'error',
      error: { code: 'USAGE_INVALID' },
    });
  });

  it('--target with invalid value exits with error', async () => {
    const tempDir = suite.createTempDir();
    const skillDir = suite.createMinimalSkill(tempDir);
    const skillMdPath = safePath.join(skillDir, 'SKILL.md');
    const outputDir = safePath.join(tempDir, 'output-bad-target');

    const result = await executeCli(
      suite.binPath,
      ['skills', 'package', skillMdPath, '-o', outputDir, '--target', 'invalid-target']
    );

    expect(result.status).toBe(2);
    expect(SKILLS_PACKAGE_REPORT_SCHEMA.parse(yaml.parse(result.stdout))).toMatchObject({
      status: 'error',
      error: { code: 'USAGE_INVALID' },
    });
  });

  it('shows --target option in help text', async () => {
    const result = await executeCli(suite.binPath, ['skills', 'package', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--target');
    expect(result.stdout).toContain(TARGET_CLAUDE_WEB);
  });
});

describe('skills package — the claude.ai ZIP ceiling (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-package-zip-ceiling-');
  let skillMdPath: string;
  let outputDir: string;

  beforeAll(() => {
    const tempDir = createTempDir();
    const skillDir = safePath.join(tempDir, 'big-skill');
    mkdirSyncReal(skillDir, { recursive: true });
    // Random bytes do not compress: just over 8 MiB of them is a ZIP over the ceiling.
    writeFileSync(safePath.join(skillDir, 'blob.bin'), randomBytes(8_500_000));
    writeTestFile(
      safePath.join(skillDir, 'SKILL.md'),
      `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_NAME} - comprehensive test skill for validation and packaging\n---\n\n# ${SKILL_NAME}\n\nSee [blob](./blob.bin).\n`,
    );
    skillMdPath = safePath.join(skillDir, 'SKILL.md');
    outputDir = safePath.join(tempDir, 'out');
  });

  afterAll(() => {
    cleanupTempDirs();
  });

  it('publishes SKILL_PACKAGE_TOO_LARGE at the skill, exit 1, and lands nothing: the package is one plan', async () => {
    const { result, parsed } = await executeCliAndParseYaml(
      binPath,
      ['skills', 'package', skillMdPath, '-o', outputDir, '--target', TARGET_CLAUDE_WEB, '-f', 'zip'],
    );
    const report = SKILLS_PACKAGE_REPORT_SCHEMA.parse(parsed);

    expect(result.status, result.stderr).toBe(1);
    expect(report.status).toBe('findings');
    expect(report.findings).toEqual([expect.objectContaining({
      code: 'SKILL_PACKAGE_TOO_LARGE',
      severity: 'error',
      location: expect.stringMatching(/SKILL\.md$/),
    })]);
    expect(report.data.outputPath).toBeNull();
    expect(existsSync(`${outputDir}.zip`)).toBe(false);
    expect(existsSync(outputDir)).toBe(false);
  });
});
