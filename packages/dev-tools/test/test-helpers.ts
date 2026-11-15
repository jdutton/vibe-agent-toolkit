// Test helper functions - file paths are controlled by test code, not user input
/* eslint-disable security/detect-unsafe-regex -- the fixtures here deliberately carry the regexes the rule flags */
// Simple semver validation regex for test purposes only

import { mkdirSync, writeFileSync } from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
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

/** Make `root` a repository and commit everything in it that its ignore files leave in. */
export function commitAllAsRepo(root: string): void {
  const git = (...args: string[]): void => {
    runGitOrThrow(args, { cwd: root });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
}

/** Write `files` (repo-relative path to text) under `root`, creating directories; returns their paths. */
export function writeFiles(root: string, files: Record<string, string>): string[] {
  for (const [rel, text] of Object.entries(files)) {
    const file = safePath.join(root, rel);
    // eslint-disable-next-line local/no-fs-mkdirSync -- fixture path is a temp dir; realpath is not read back
    mkdirSync(safePath.join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
  return Object.keys(files);
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
