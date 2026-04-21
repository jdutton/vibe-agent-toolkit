/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
import { existsSync, rmSync } from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempDirTracker,
  executeCliAndParseYaml,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const binPath = getBinPath(import.meta.url);
const TEMP_DIR_PREFIX = 'vat-marketplace-validate-test-';
const VALIDATE_ARGS = ['claude', 'marketplace', 'validate'] as const;

/**
 * Create a minimal valid marketplace directory structure.
 */
function createValidMarketplace(tempDir: string): void {
  // marketplace.json
  mkdirSyncReal(safePath.join(tempDir, '.claude-plugin'), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'test-mp',
      description: 'Test marketplace',
      version: '1.0.0',
      owner: { name: 'Test Owner' },
      plugins: [{ name: 'test-plugin', source: './plugins/test-plugin' }],
    }),
  );

  // plugin with valid plugin.json
  mkdirSyncReal(safePath.join(tempDir, 'plugins', 'test-plugin', '.claude-plugin'), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, 'plugins', 'test-plugin', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'test-plugin', description: 'Test plugin', version: '1.0.0' }),
  );

  // skill within plugin
  mkdirSyncReal(safePath.join(tempDir, 'plugins', 'test-plugin', 'skills', 'test-skill'), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, 'plugins', 'test-plugin', 'skills', 'test-skill', 'SKILL.md'),
    [
      '---',
      'name: test-skill',
      'description: A comprehensive test skill for marketplace validation and packaging tests',
      'metadata:',
      '  version: 1.0.0',
      '---',
      '',
      '# test-skill',
      '',
      'This is a test skill for marketplace validation.',
    ].join('\n'),
  );

  // Required files
  writeTestFile(safePath.join(tempDir, 'LICENSE'), 'MIT License\n\nCopyright (c) 2025 Test');
  writeTestFile(safePath.join(tempDir, 'README.md'), '# Test Marketplace\n\nA test marketplace.');
  writeTestFile(safePath.join(tempDir, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0\n\n- Initial release');
}

/**
 * Run marketplace validate and assert a specific issue is present with expected severity.
 */
function validateAndExpectIssue(
  tempDir: string,
  expectedCode: string,
  expectedSeverity: string,
  expectedExitCode: number,
): void {
  const { result, parsed } = executeCliAndParseYaml(binPath, [...VALIDATE_ARGS, tempDir]);

  expect(result.status).toBe(expectedExitCode);
  const issues = parsed['issues'] as Array<{ code: string; severity: string }>;
  const matchingIssue = issues.find(i => i.code === expectedCode);
  expect(matchingIssue).toBeDefined();
  expect(matchingIssue?.severity).toBe(expectedSeverity);
}

describe('vat claude marketplace validate (system)', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker(TEMP_DIR_PREFIX);

  afterEach(() => {
    cleanupTempDirs();
  });

  it('should validate a valid marketplace directory with exit 0', () => {
    const tempDir = createTempDir();
    createValidMarketplace(tempDir);

    expect(existsSync(safePath.join(tempDir, '.claude-plugin', 'marketplace.json'))).toBe(true);

    const { result, parsed } = executeCliAndParseYaml(binPath, [...VALIDATE_ARGS, tempDir]);

    expect(result.status).toBe(0);
    expect(parsed['status']).toBe('success');
  });

  it('should fail with exit 1 when marketplace.json is missing', () => {
    const tempDir = createTempDir();
    mkdirSyncReal(tempDir, { recursive: true });

    const { result, parsed } = executeCliAndParseYaml(binPath, [...VALIDATE_ARGS, tempDir]);

    expect(result.status).toBe(1);
    expect(parsed['status']).toBe('error');
  });

  it('should report MARKETPLACE_MISSING_LICENSE as error when LICENSE is missing', () => {
    const tempDir = createTempDir();
    createValidMarketplace(tempDir);
    rmSync(safePath.join(tempDir, 'LICENSE'));

    validateAndExpectIssue(tempDir, 'MARKETPLACE_MISSING_LICENSE', 'error', 1);
  });

  it('should report PLUGIN_MISSING_VERSION as error (not warning) in strict mode', () => {
    const tempDir = createTempDir();
    createValidMarketplace(tempDir);

    // Overwrite plugin.json without version
    writeTestFile(
      safePath.join(tempDir, 'plugins', 'test-plugin', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'test-plugin', description: 'Test plugin' }),
    );

    validateAndExpectIssue(tempDir, 'PLUGIN_MISSING_VERSION', 'error', 1);
  });

  it('should exit 0 with warning when README.md is missing', () => {
    const tempDir = createTempDir();
    createValidMarketplace(tempDir);
    rmSync(safePath.join(tempDir, 'README.md'));

    validateAndExpectIssue(tempDir, 'MARKETPLACE_MISSING_README', 'warning', 0);
  });
});
