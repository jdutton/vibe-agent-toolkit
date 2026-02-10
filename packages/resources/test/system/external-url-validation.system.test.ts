/**
 * External URL validation system test - validates CLI flag integration.
 *
 * Tests that --check-external-urls and --no-cache flags are properly passed
 * through the CLI to the ResourceRegistry.validate() method.
 *
 * Note: Full end-to-end HTTP validation is tested in integration tests.
 * This system test focuses on CLI command parsing and option forwarding.
 */

/* eslint-disable sonarjs/no-duplicate-string */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('External URL validation CLI flags (system test)', () => {
  let tempDir: string;
  let binPath: string;

  const BASE_CMD = ['resources', 'validate'];
  const VALIDATE_CMD = [...BASE_CMD, '--check-external-urls'];
  const SUCCESS_OUTPUT = 'status: success';
  const NO_CACHE_CMD = [...BASE_CMD, '--no-cache'];

  /**
   * Helper to run vat validation command.
   */
  function runValidate(args: string[]) {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- binPath from import.meta.url, safe
    return spawnSync('node', [binPath, ...args], {
      cwd: tempDir,
      encoding: 'utf-8',
      timeout: 10000,
    });
  }

  beforeAll(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'vat-external-url-test-'));

    // Path to vat CLI binary
    const currentDir = path.dirname(new URL(import.meta.url).pathname);
    binPath = path.resolve(currentDir, '../../../cli/dist/bin/vat.js');

    // Create minimal test structure
    const docsDir = path.join(tempDir, 'docs');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir from mkdtempSync, safe
    fs.mkdirSync(docsDir, { recursive: true });

    // File with no external links (ensures validation passes)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir from mkdtempSync, safe
    fs.writeFileSync(
      path.join(docsDir, 'test.md'),
      `# Test

This file has no external links.
`
    );

    // Minimal valid config
    const configContent = `
version: 1
resources:
  include:
    - "docs/**/*.md"
`;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir from mkdtempSync, safe
    fs.writeFileSync(path.join(tempDir, 'vibe-agent-toolkit.config.yaml'), configContent);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should accept --check-external-urls flag', () => {
    const result = runValidate(VALIDATE_CMD);

    // Should succeed (no external URLs to check)
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SUCCESS_OUTPUT);
  });

  it('should accept --no-cache flag', () => {
    const result = runValidate(NO_CACHE_CMD);

    // Should succeed
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SUCCESS_OUTPUT);
  });

  it('should accept both flags together', () => {
    const result = runValidate([...VALIDATE_CMD, '--no-cache']);

    // Should succeed
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SUCCESS_OUTPUT);
  });

  it('should show help text mentioning external URL validation', () => {
    // Check help text
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- binPath from import.meta.url, safe
    const result = spawnSync('node', [binPath, 'resources', 'validate', '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--check-external-urls');
    expect(result.stdout).toContain('--no-cache');
    expect(result.stdout).toContain('External URL Validation');
  });
});
