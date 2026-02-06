/**
 * Common imports and utilities for system tests
 * Extracts common setup to reduce duplication across test files
 */

import type { SpawnSyncReturns } from 'node:child_process';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname as pathDirname, join as pathJoin, resolve as pathResolve } from 'node:path';
import { fileURLToPath as urlFileURLToPath } from 'node:url';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
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
  return fs.mkdtempSync(pathJoin(normalizedTmpdir(), prefix));
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
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large audit outputs
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
 * @param testFileUrl - import.meta.url from the calling test file
 * @param args - Arguments to pass to vat command
 * @param options - Optional execution options
 */
export function executeBunVat(
  testFileUrl: string,
  args: string[],
  options?: { cwd?: string }
): SpawnSyncReturns<string> {
  // Find the monorepo root relative to test file location (like getBinPath does)
  const testDir = pathDirname(urlFileURLToPath(testFileUrl));
  const monorepoRoot = pathResolve(testDir, '../../../..');

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- bun is required for wrapper tests
  return nodeSpawnSync('bun', ['run', 'vat', ...args], {
    encoding: 'utf-8',
    cwd: options?.cwd ?? monorepoRoot,
  });
}

/**
 * Skills test fixture - VAT skill metadata
 */
export interface TestVatSkill {
  name: string;
  source: string;
  path: string;
}

/**
 * Create package.json content for skills testing
 * @param packageName - Name of the package
 * @param skills - Array of skill configurations
 * @returns Package.json content as string
 */
export function createSkillsPackageJson(packageName: string, skills: TestVatSkill[]): string {
  return JSON.stringify({
    name: packageName,
    version: '1.0.0',
    vat: {
      version: '1.0',
      type: 'agent-bundle',
      skills,
    },
  });
}

/**
 * Create a SKILL.md markdown file content
 * @param skillName - Name of the skill
 * @param description - Optional description
 * @returns SKILL.md content
 */
export function createSkillMarkdown(skillName: string, description?: string): string {
  return `---
name: ${skillName}
description: ${description ?? `${skillName} description`}
version: 1.0.0
---

# ${skillName}

This is ${description ?? 'a test skill'}.
`;
}
