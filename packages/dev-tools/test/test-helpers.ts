/* eslint-disable security/detect-non-literal-fs-filename */
// Test helper functions - file paths are controlled by test code, not user input
/* eslint-disable security/detect-unsafe-regex */
// Simple semver validation regex for test purposes only

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { normalizePath } from '@vibe-agent-toolkit/utils';

export interface TestTempDirOptions {
  prefix?: string;
}

export function createTestTempDir(options: TestTempDirOptions = {}): string {
  const prefix = options.prefix ?? 'vat-test-';
  const tempBase = tmpdir();
  const tempDir = mkdtempSync(join(tempBase, prefix));
  return resolve(tempDir);
}

export function cleanupTestTempDir(dir: string): void {
  // Security: Ensure the directory is actually in the system temp directory
  const normalizedDir = normalizePath(dir);
  const normalizedTempBase = normalizePath(tmpdir());

  if (!normalizedDir.startsWith(normalizedTempBase)) {
    throw new Error(`Security: Refusing to delete directory outside temp: ${dir}`);
  }

  try {
    rmSync(normalizedDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors - test directories may already be deleted
  }
}

export interface MockPackageOptions {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

export function createMockPackageJson(
  dir: string,
  options: MockPackageOptions
): string {
  // Ensure directory exists with normalized path
  const normalizedDir = resolve(dir);
  mkdirSync(normalizedDir, { recursive: true });

  const packageJson = {
    name: options.name,
    version: options.version,
    dependencies: options.dependencies ?? {},
  };

  const packagePath = resolve(normalizedDir, 'package.json');
  writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));
  return packagePath;
}

export function assertValidSemver(version: string): void {
  const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;
  if (!semverRegex.test(version)) {
    throw new Error(`Invalid semver: ${version}`);
  }
}
