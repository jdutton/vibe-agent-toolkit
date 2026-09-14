/**
 * External URL validation system test - validates CLI flag integration.
 *
 * Tests that --check-external-urls and --no-cache flags are properly passed
 * through the CLI to the ResourceRegistry.validate() method.
 *
 * Note: Full end-to-end HTTP validation is tested in integration tests.
 * This system test focuses on CLI command parsing and option forwarding.
 */


import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Helper to run vat validation command.
 */
function runValidate(binPathValue: string, cwd: string, args: string[]) {
  return spawnSync(NODE_EXECUTABLE, [binPathValue, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 10000,
  });
}

describe('External URL validation CLI flags (system test)', () => {
  let tempDir: string;
  let binPath: string;

  const BASE_CMD = ['resources', 'validate'];
  const VALIDATE_CMD = [...BASE_CMD, '--check-external-urls'];
  const SUCCESS_OUTPUT = 'status: success';
  const NO_CACHE_CMD = [...BASE_CMD, '--no-cache'];

  beforeAll(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-external-url-test-'));

    // Path to vat CLI binary (use fileURLToPath for cross-platform compatibility)
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    binPath = safePath.resolve(currentDir, '../../../cli/dist/bin/vat.js');

    // Create minimal test structure
    const docsDir = safePath.join(tempDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });

    // File with no external links (ensures validation passes)
    fs.writeFileSync(
      safePath.join(docsDir, 'test.md'),
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

    fs.writeFileSync(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), configContent);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should accept --check-external-urls flag', () => {
    const result = runValidate(binPath, tempDir, VALIDATE_CMD);

    // Should succeed (no external URLs to check)
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SUCCESS_OUTPUT);
  });

  it('should accept --no-cache flag', () => {
    const result = runValidate(binPath, tempDir, NO_CACHE_CMD);

    // Should succeed
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SUCCESS_OUTPUT);
  });

  it('should accept both flags together', () => {
    const result = runValidate(binPath, tempDir, [...VALIDATE_CMD, '--no-cache']);

    // Should succeed
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SUCCESS_OUTPUT);
  });

  it('should show help text mentioning external URL validation', () => {
    // Check help text
    const result = spawnSync(NODE_EXECUTABLE, [binPath, 'resources', 'validate', '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--check-external-urls');
    expect(result.stdout).toContain('--no-cache');
    expect(result.stdout).toContain('External URL Validation');
  });
});
