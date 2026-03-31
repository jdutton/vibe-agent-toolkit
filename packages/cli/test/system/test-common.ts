/**
 * Common imports and utilities for system tests
 * Extracts common setup to reduce duplication across test files
 */

import type { SpawnSyncReturns } from 'node:child_process';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname as pathDirname, join as pathJoin, resolve as pathResolve } from 'node:path';
import { fileURLToPath as urlFileURLToPath } from 'node:url';

import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
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
 * Get fixture path from current test file location
 * @param testFileUrl - import.meta.url from the test file
 * @param fixtureName - Name of the fixture directory (e.g., 'skills-minimal')
 * @returns Absolute path to the fixture directory
 */
export function getFixturePath(testFileUrl: string, fixtureName: string): string {
  const testDir = pathDirname(urlFileURLToPath(testFileUrl));
  return pathResolve(testDir, '../fixtures', fixtureName);
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
 * Create a tracked temp dir factory for use in test suites.
 *
 * Returns a `createTempDir` function that tracks created directories, and a
 * `cleanupTempDirs` function that removes them all. Use this instead of
 * duplicating the tracking boilerplate in every suite setup function.
 *
 * @example
 * ```typescript
 * const { createTempDir, cleanupTempDirs } = createTempDirTracker(TEMP_DIR_PREFIX);
 * afterEach(() => cleanupTempDirs());
 * ```
 */
export function createTempDirTracker(prefix: string): {
  createTempDir: () => string;
  cleanupTempDirs: () => void;
} {
  const tempDirs: string[] = [];

  const createTempDir = () => {
    const dir = createTestTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  };

  const cleanupTempDirs = () => {
    for (const dir of tempDirs) {
      cleanupTestTempDir(dir);
    }
    tempDirs.length = 0;
  };

  return { createTempDir, cleanupTempDirs };
}

/**
 * Create an isolated package + home directory pair inside a temp dir.
 * Used by postinstall and uninstall tests that need a fake npm package context
 * and a fake Claude home directory.
 */
export function createPackageAndHomeContext(tempDir: string): {
  packageDir: string;
  fakeHome: string;
} {
  const packageDir = pathJoin(tempDir, 'package');
  const fakeHome = pathJoin(tempDir, 'home');
  mkdirSyncReal(packageDir, { recursive: true });
  mkdirSyncReal(fakeHome, { recursive: true });
  return { packageDir, fakeHome };
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
 * Merge base environment with overrides, deduplicating case-insensitive keys.
 *
 * On Windows, environment variable names are case-insensitive. A plain object spread
 * `{ ...process.env, npm_config_global: 'true' }` can produce an object with BOTH
 * `NPM_CONFIG_GLOBAL` (from process.env, uppercase as Windows stores it) AND
 * `npm_config_global` (our lowercase override) as *separate* JavaScript properties.
 * Node.js passes both to Windows `CreateProcess`, and its behavior for duplicate
 * case-insensitive names is undefined — the uppercase version from process.env
 * often wins, silently defeating our intended override.
 *
 * This function builds the merged env so that each case-insensitive key appears
 * exactly once, with the override value winning.
 */
function mergeEnvWithOverrides(overrides: Record<string, string>): NodeJS.ProcessEnv {
  // Start with process.env and then apply overrides, removing any existing
  // case-insensitive duplicate before setting each override value.
  const merged: NodeJS.ProcessEnv = { ...process.env };

  for (const [overrideKey, overrideValue] of Object.entries(overrides)) {
    // Remove any existing key that is case-insensitively equivalent to the override key
    // (handles Windows normalizing npm_config_global → NPM_CONFIG_GLOBAL).
    const lowerOverride = overrideKey.toLowerCase();
    for (const existingKey of Object.keys(merged)) {
      if (existingKey !== overrideKey && existingKey.toLowerCase() === lowerOverride) {
        delete merged[existingKey];
      }
    }
    merged[overrideKey] = overrideValue;
  }

  return merged;
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
    env: options?.env ? mergeEnvWithOverrides(options.env) : undefined,
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
 * Build an env object that overrides the home directory for both Unix and Windows.
 *
 * `os.homedir()` reads different env vars depending on platform:
 *   - Unix/macOS → `HOME`
 *   - Windows    → `USERPROFILE`
 *
 * Always set both so tests that spawn child processes receive the fake home on
 * every platform. Pass the result as (or merge into) `options.env` whenever a
 * spawned process calls `os.homedir()` internally.
 *
 * @example
 * ```typescript
 * executeCli(binPath, args, {
 *   cwd: packageDir,
 *   env: { ...NPM_POSTINSTALL_ENV, ...fakeHomeEnv(fakeHome) },
 * });
 * ```
 */
export function fakeHomeEnv(fakeHome: string): Record<string, string> {
  return {
    HOME: fakeHome,
    // Windows: os.homedir() reads USERPROFILE, not HOME. Set both to ensure
    // the fake directory is used on all platforms.
    USERPROFILE: fakeHome,
  };
}

/**
 * Skills test fixture - VAT skill metadata (new format: just skill name strings)
 */
export interface TestVatSkill {
  name: string;
}

/**
 * Create package.json content for skills testing.
 * In the new API, vat.skills is a flat string array (just names for npm discoverability).
 * Build config comes from vibe-agent-toolkit.config.yaml, not package.json.
 *
 * @param packageName - Name of the package
 * @param skills - Array of skill configurations (only name is used)
 * @returns Package.json content as string
 */
export function createSkillsPackageJson(packageName: string, skills: TestVatSkill[]): string {
  return JSON.stringify({
    name: packageName,
    version: '1.0.0',
    vat: {
      version: '1.0',
      type: 'agent-bundle',
      skills: skills.map(s => s.name),
    },
  });
}

/**
 * Create a vibe-agent-toolkit.config.yaml content for skills build testing.
 * The new skills build reads globs from this config instead of package.json.
 *
 * @param includeGlobs - Glob patterns for finding SKILL.md files
 * @param excludeGlobs - Optional exclude patterns
 * @returns YAML config content as string
 */
export function createSkillsConfigYaml(
  includeGlobs: string[],
  excludeGlobs?: string[]
): string {
  let content = `version: 1\nskills:\n  include:\n`;
  for (const glob of includeGlobs) {
    content += `    - "${glob}"\n`;
  }
  if (excludeGlobs && excludeGlobs.length > 0) {
    content += `  exclude:\n`;
    for (const glob of excludeGlobs) {
      content += `    - "${glob}"\n`;
    }
  }
  return content;
}

/**
 * Create a SKILL.md markdown file content
 * @param skillName - Name of the skill
 * @param description - Optional description
 * @returns SKILL.md content
 */
export function createSkillMarkdown(skillName: string, description?: string): string {
  // Ensure description meets minimum length requirement (50 chars)
  const desc = description ?? `${skillName} - comprehensive test skill for validation and packaging`;
  return `---
name: ${skillName}
description: ${desc}
version: 1.0.0
---

# ${skillName}

This is ${description ?? 'a test skill'}.
`;
}
