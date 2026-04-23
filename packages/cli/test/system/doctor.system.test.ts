/**
 * System tests for doctor command
 *
 * Run the REAL doctor command against THIS project (VAT itself)
 * to verify self-hosting works correctly. No mocks - real execution.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { executeCli, getBinPath } from './test-common.js';

// Get the project root (VAT repo root)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = safePath.join(__dirname, '../../../..'); // from packages/cli/test/system/ to project root
const PACKAGES_DIR = safePath.join(PROJECT_ROOT, 'packages');
const CLI_DIR = safePath.join(PROJECT_ROOT, 'packages/cli');

// Use the built CLI binary directly
const CLI_BIN = getBinPath(import.meta.url);

/**
 * Execute vat doctor command and return parsed result
 */
async function runVatDoctor(cwd: string, options?: { verbose?: boolean }): Promise<{
  exitCode: number;
  output: string;
  allPassed: boolean;
}> {
  const args = options?.verbose ? ['doctor', '--verbose'] : ['doctor'];
  const result = await executeCli(CLI_BIN, args, { cwd });

  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const exitCode = result.status ?? 1;

  return {
    exitCode,
    output,
    allPassed:
      exitCode === 0 && !output.includes('❌') && output.includes('All checks passed'),
  };
}

describe('vat doctor - system tests (self-hosting)', () => {
  describe('running from project root', () => {
    it('passes all checks when run from project root', async () => {
      const result = await runVatDoctor(PROJECT_ROOT);

      expect(result.exitCode).toBe(0);
      expect(result.allPassed).toBe(true);
      expect(result.output).toContain('vat doctor');
      expect(result.output).toContain('All checks passed');
    });

    it('reports correct summary counts', async () => {
      const result = await runVatDoctor(PROJECT_ROOT);

      // Simple digit/digit pattern - not vulnerable to ReDoS
      // eslint-disable-next-line sonarjs/slow-regex -- Safe pattern: \d+\/\d+ has no backtracking
      expect(result.output).toMatch(/\d+\/\d+ checks passed/);
    });
  });

  describe('running from subdirectories', () => {
    it('passes all checks when run from packages/ subdirectory', async () => {
      const result = await runVatDoctor(PACKAGES_DIR);

      expect(result.exitCode).toBe(0);
      expect(result.allPassed).toBe(true);
    });

    it('passes all checks when run from packages/cli/ subdirectory', async () => {
      const result = await runVatDoctor(CLI_DIR);

      expect(result.exitCode).toBe(0);
      expect(result.allPassed).toBe(true);
    });

    it('shows context when running from subdirectory', async () => {
      const result = await runVatDoctor(PACKAGES_DIR);

      expect(result.output).toContain('📍 Project Context');
      expect(result.output).toContain('Current directory:');
      expect(result.output).toContain('Project root:');
    });
  });

  describe('verbose mode', () => {
    it('shows all checks with --verbose', async () => {
      const normal = await runVatDoctor(PROJECT_ROOT);
      const verbose = await runVatDoctor(PROJECT_ROOT, { verbose: true });

      // Verbose shows more checks (all passing checks)
      const normalChecks = (normal.output.match(/✅/g) ?? []).length;
      const verboseChecks = (verbose.output.match(/✅/g) ?? []).length;

      expect(verboseChecks).toBeGreaterThanOrEqual(normalChecks);
    });
  });
});
