/**
 * Common imports and utilities for system tests
 * Extracts common setup to reduce duplication across test files
 */

import type { SpawnSyncReturns } from 'node:child_process';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname as pathDirname, join as pathJoin, resolve as pathResolve } from 'node:path';
import { fileURLToPath as urlFileURLToPath } from 'node:url';

import * as yaml from 'js-yaml';

// Re-export commonly used functions
export { spawnSync } from 'node:child_process';
export * as fs from 'node:fs';
export { join, resolve, dirname } from 'node:path';
export { fileURLToPath } from 'node:url';
export { describe, expect } from 'vitest';

/**
 * Get bin path from current test file location
 */
export function getBinPath(testFileUrl: string): string {
  const testDir = pathDirname(urlFileURLToPath(testFileUrl));
  return pathResolve(testDir, '../../dist/bin.js');
}

/**
 * Get wrapper path from current test file location
 */
export function getWrapperPath(testFileUrl: string): string {
  const testDir = pathDirname(urlFileURLToPath(testFileUrl));
  return pathResolve(testDir, '../../dist/bin/vat.js');
}

/**
 * Create a temporary directory for testing
 * Automatically generates a unique directory name
 */
export function createTestTempDir(prefix: string): string {
  return fs.mkdtempSync(pathJoin(os.tmpdir(), prefix));
}

/**
 * Clean up a temporary directory
 * Safe wrapper around fs.rmSync with proper error handling
 */
export function cleanupTestTempDir(tempDir: string): void {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors in tests
  }
}

/**
 * Write a test file with proper ESLint suppressions
 * Path is controlled by test code, so security warning is suppressed
 */
export function writeTestFile(filePath: string, content: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is controlled in tests
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Execute CLI command and return result
 * Handles ESLint suppressions for test execution
 */
export function executeCli(
  binPath: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> }
): SpawnSyncReturns<string> {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
  return nodeSpawnSync('node', [binPath, ...args], {
    encoding: 'utf-8',
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : undefined,
  });
}

/**
 * Execute CLI command and parse YAML output
 * Returns both the raw result and parsed YAML
 */
export function executeCliAndParseYaml(
  binPath: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> }
): {
  result: SpawnSyncReturns<string>;
  parsed: Record<string, unknown>;
} {
  const result = executeCli(binPath, args, options);

  // Parse YAML output (use loadAll to handle document markers)
  const docs = yaml.loadAll(result.stdout) as Array<Record<string, unknown>>;
  const parsed = docs[0] ?? {};

  return { result, parsed };
}

/**
 * Execute bun run vat command (for testing the wrapper)
 * Used specifically for bin-wrapper tests
 */
export function executeBunVat(
  args: string[],
  options?: { cwd?: string }
): SpawnSyncReturns<string> {
  // Find the monorepo root (where the vat script is defined)
  const monorepoRoot = pathResolve(process.cwd(), '../..');

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- bun is required for wrapper tests
  const result = nodeSpawnSync('bun', ['run', 'vat', ...args], {
    encoding: 'utf-8',
    cwd: options?.cwd ?? monorepoRoot,
  });

  // DIAGNOSTIC: If command fails, augment result with diagnostic info
  if (result.status !== 0) {
    const diagnostics = `
DIAGNOSTIC INFO:
  process.cwd(): ${process.cwd()}
  Resolved monorepo root: ${monorepoRoot}
  Command: bun run vat ${args.join(' ')}
  Working directory: ${options?.cwd ?? monorepoRoot}
  Exit code: ${result.status}
  Signal: ${result.signal}
  Error: ${result.error?.message ?? 'none'}
  stdout: ${result.stdout}
  stderr: ${result.stderr}
`;
    // Prepend diagnostics to stderr for visibility in test output
    result.stderr = diagnostics + result.stderr;
  }

  return result;
}
