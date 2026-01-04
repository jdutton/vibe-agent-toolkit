/**
 * System tests for doctor command
 *
 * Run the REAL doctor command against THIS project (VAT itself)
 * to verify self-hosting works correctly. No mocks - real execution.
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Get the project root (VAT repo root)
const PROJECT_ROOT = join(__dirname, '../../../..');
const PACKAGES_DIR = join(PROJECT_ROOT, 'packages');
const CLI_DIR = join(PROJECT_ROOT, 'packages/cli');

// Use the built CLI binary directly
const CLI_BIN = join(PROJECT_ROOT, 'packages/cli/dist/bin.js');

/**
 * Execute vat doctor command and return parsed result
 */
function runVatDoctor(cwd: string, options?: { verbose?: boolean }): {
  exitCode: number;
  output: string;
  allPassed: boolean;
} {
  try {
    const verboseFlag = options?.verbose ? ' --verbose' : '';
    // eslint-disable-next-line sonarjs/os-command, local/no-child-process-execSync -- System test requires running real CLI with execSync
    const output = execSync(`node ${CLI_BIN} doctor${verboseFlag}`, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    return {
      exitCode: 0,
      output,
      allPassed: !output.includes('❌') && output.includes('All checks passed'),
    };
  } catch (error: unknown) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: err.status ?? 1,
      output: (err.stdout ?? '') + (err.stderr ?? ''),
      allPassed: false,
    };
  }
}

describe('vat doctor - system tests (self-hosting)', () => {
  describe('running from project root', () => {
    it('passes all checks when run from project root', () => {
      const result = runVatDoctor(PROJECT_ROOT);

      expect(result.exitCode).toBe(0);
      expect(result.allPassed).toBe(true);
      expect(result.output).toContain('vat doctor');
      expect(result.output).toContain('All checks passed');
    });

    it('reports correct summary counts', () => {
      const result = runVatDoctor(PROJECT_ROOT);

      // Simple regex is safe - just matching digit/digit pattern
      // eslint-disable-next-line sonarjs/slow-regex -- Simple pattern, not vulnerable
      expect(result.output).toMatch(/\d+\/\d+ checks passed/);
    });
  });

  describe('running from subdirectories', () => {
    it('passes all checks when run from packages/ subdirectory', () => {
      const result = runVatDoctor(PACKAGES_DIR);

      expect(result.exitCode).toBe(0);
      expect(result.allPassed).toBe(true);
    });

    it('passes all checks when run from packages/cli/ subdirectory', () => {
      const result = runVatDoctor(CLI_DIR);

      expect(result.exitCode).toBe(0);
      expect(result.allPassed).toBe(true);
    });

    it('shows context when running from subdirectory', () => {
      const result = runVatDoctor(PACKAGES_DIR);

      expect(result.output).toContain('📍 Project Context');
      expect(result.output).toContain('Current directory:');
      expect(result.output).toContain('Project root:');
    });
  });

  describe('verbose mode', () => {
    it('shows all checks with --verbose', () => {
      const normal = runVatDoctor(PROJECT_ROOT);
      const verbose = runVatDoctor(PROJECT_ROOT, { verbose: true });

      // Verbose shows more checks (all passing checks)
      const normalChecks = (normal.output.match(/✅/g) ?? []).length;
      const verboseChecks = (verbose.output.match(/✅/g) ?? []).length;

      expect(verboseChecks).toBeGreaterThanOrEqual(normalChecks);
    });
  });
});
