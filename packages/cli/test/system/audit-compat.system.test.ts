/**
 * System tests for vat audit --compat flag
 *
 * Tests per-surface compatibility analysis output produced by the --compat flag.
 * Verifies that analyzeCompatibility() output is merged into audit YAML for
 * plugin directories.
 */

import * as fs from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  getBinPath,
  writeTestFile,
} from './test-common.js';
import { executeCli, parseYamlOutput } from './test-helpers/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid Claude plugin directory for testing
 */
function createMinimalPlugin(
  parentDir: string,
  pluginName: string,
  extraFiles?: Record<string, string>
): string {
  const pluginDir = join(parentDir, pluginName);
  const metaDir = join(pluginDir, '.claude-plugin');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper, paths are controlled
  fs.mkdirSync(metaDir, { recursive: true });

  writeTestFile(
    join(metaDir, 'plugin.json'),
    JSON.stringify({
      type: 'plugin',
      name: pluginName,
      version: '1.0.0',
    })
  );

  writeTestFile(
    join(pluginDir, 'SKILL.md'),
    `---
name: ${pluginName}
description: Test plugin skill for compatibility analysis testing
---

# ${pluginName}

This is a test skill.
`
  );

  if (extraFiles) {
    for (const [relativePath, content] of Object.entries(extraFiles)) {
      const fullPath = join(pluginDir, relativePath);
      const fileDir = join(fullPath, '..');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper, paths are controlled
      fs.mkdirSync(fileDir, { recursive: true });
      writeTestFile(fullPath, content);
    }
  }

  return pluginDir;
}

/**
 * Execute `vat audit <dir> --compat` and parse the YAML output.
 * Asserts the command exits 0 and produces non-empty stdout.
 */
function runCompatAuditAndParse(
  binPath: string,
  targetDir: string,
  extraArgs: string[] = []
): { files: Array<Record<string, unknown>> } {
  const { stdout, status } = executeCli(binPath, ['audit', targetDir, '--compat', ...extraArgs]);

  expect(status).toBe(0);
  expect(stdout).toBeTruthy();

  const output = parseYamlOutput(stdout);
  const files = output['files'] as Array<Record<string, unknown>>;
  expect(files).toBeDefined();

  return { files };
}

/** Valid verdict values from CompatibilityResult.analyzed */
const VALID_VERDICTS = ['compatible', 'needs-review', 'incompatible'] as const;

/**
 * Assert that a compat entry has the expected per-target analyzed verdicts structure.
 * Also validates that each verdict value is one of the known Verdict types.
 */
function assertCompatAnalyzed(entry: Record<string, unknown>): void {
  const compat = entry['compatibility'] as Record<string, unknown>;
  expect(compat).toHaveProperty('analyzed');

  const analyzed = compat['analyzed'] as Record<string, unknown>;
  expect(analyzed).toHaveProperty('claude-code');
  expect(analyzed).toHaveProperty('cowork');
  expect(analyzed).toHaveProperty('claude-desktop');

  // Validate that each verdict value is one of the known Verdict types
  for (const target of ['claude-code', 'cowork', 'claude-desktop'] as const) {
    expect(VALID_VERDICTS).toContain(analyzed[target]);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audit --compat flag (system test)', () => {
  let binPath: string;
  let tempDir: string;

  beforeAll(() => {
    binPath = getBinPath(import.meta.url);
    tempDir = createTestTempDir('vat-audit-compat-');
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it('--compat produces compatibility analysis for a claude plugin', () => {
    const testDir = join(tempDir, 'single-plugin');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test, path is controlled
    fs.mkdirSync(testDir, { recursive: true });

    createMinimalPlugin(testDir, 'my-test-plugin');

    const { files } = runCompatAuditAndParse(binPath, testDir);
    expect(files.length).toBeGreaterThan(0);

    // At least one file entry should have compatibility data
    const withCompat = files.filter(f => f['compatibility'] !== undefined);
    expect(withCompat.length).toBeGreaterThan(0);

    // Verify the compatibility structure for the plugin entry
    assertCompatAnalyzed(withCompat[0] as Record<string, unknown>);
  });

  it('--compat with multiple plugins produces analysis for each', () => {
    const testDir = join(tempDir, 'multi-plugin');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test, path is controlled
    fs.mkdirSync(testDir, { recursive: true });

    createMinimalPlugin(testDir, 'plugin-alpha');
    createMinimalPlugin(testDir, 'plugin-beta');

    const { files } = runCompatAuditAndParse(binPath, testDir);

    // Both plugins should have compatibility data
    const withCompat = files.filter(f => f['compatibility'] !== undefined);
    expect(withCompat.length).toBe(2);

    // Each compat entry should have analyzed per-target verdicts
    for (const entry of withCompat) {
      assertCompatAnalyzed(entry as Record<string, unknown>);
    }
  });

  it('--compat without a plugin (skill only) produces no compatibility data', () => {
    const testDir = join(tempDir, 'skill-only');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test, path is controlled
    fs.mkdirSync(testDir, { recursive: true });

    // Create a standalone SKILL.md (not a plugin directory)
    const skillDir = join(testDir, 'my-skill');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test, path is controlled
    fs.mkdirSync(skillDir, { recursive: true });
    writeTestFile(
      join(skillDir, 'SKILL.md'),
      `---
name: my-standalone-skill
description: A standalone skill without a plugin manifest
---

# My Standalone Skill

This skill has no plugin.json so no compat analysis applies.
`
    );

    const { files } = runCompatAuditAndParse(binPath, testDir);

    // No compat data on skill entries (they are not plugins)
    const withCompat = files.filter(f => f['compatibility'] !== undefined);
    expect(withCompat.length).toBe(0);
  });

  it('--compat works with --no-recursive flag', () => {
    const testDir = join(tempDir, 'no-recurse-compat');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test, path is controlled
    fs.mkdirSync(testDir, { recursive: true });

    createMinimalPlugin(testDir, 'top-level-plugin');

    // Should not crash when combined with --no-recursive
    const { status } = executeCli(binPath, ['audit', testDir, '--compat', '--no-recursive']);
    expect(status).not.toBe(2);
  });

  it('--compat with --user flag produces compatibility analysis', () => {
    // Create a fake HOME with a .claude/plugins directory containing a plugin
    const fakeHome = join(tempDir, 'fake-home-compat');
    const pluginsDir = join(fakeHome, '.claude', 'plugins');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test, path is controlled
    fs.mkdirSync(pluginsDir, { recursive: true });

    createMinimalPlugin(pluginsDir, 'user-compat-plugin');

    // Override HOME so getClaudeUserPaths() resolves to our temp directory.
    // Merge with process.env so PATH and other vars are preserved.
    const { stdout, status } = executeCli(binPath, ['audit', '--user', '--compat'], {
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });

    expect(status).toBe(0);
    expect(stdout).toBeTruthy();

    const output = parseYamlOutput(stdout);

    // The --user path outputs a hierarchical summary plus a files array when compat is active
    expect(output).toHaveProperty('files');
    const files = output['files'] as Array<Record<string, unknown>>;
    expect(files.length).toBeGreaterThan(0);

    // At least one file entry should have compatibility data (the plugin)
    const withCompat = files.filter(f => f['compatibility'] !== undefined);
    expect(withCompat.length).toBeGreaterThan(0);

    // Verify the compatibility structure and verdict values
    assertCompatAnalyzed(withCompat[0] as Record<string, unknown>);
  });
});
