// Test helper functions - file paths are controlled by test code, not user input
/* eslint-disable security/detect-unsafe-regex -- the fixtures here deliberately carry the regexes the rule flags */
// Simple semver validation regex for test purposes only

import { writeFileSync } from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { createTempDir, removeTempDir } from '@vibe-agent-toolkit/utils/testing';

export interface TestTempDirOptions {
  prefix?: string;
}

export function createTestTempDir(options: TestTempDirOptions = {}): string {
  return createTempDir(options.prefix ?? 'vat-test-');
}

export function cleanupTestTempDir(dir: string): void {
  removeTempDir(dir);
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
  const normalizedDir = safePath.resolve(dir);
  mkdirSyncReal(normalizedDir, { recursive: true });

  const packageJson = {
    name: options.name,
    version: options.version,
    dependencies: options.dependencies ?? {},
  };

  const packagePath = safePath.resolve(normalizedDir, 'package.json');
  writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));
  return packagePath;
}

export function assertValidSemver(version: string): void {
  const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;
  if (!semverRegex.test(version)) {
    throw new Error(`Invalid semver: ${version}`);
  }
}
