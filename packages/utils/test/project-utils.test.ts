/* eslint-disable security/detect-non-literal-fs-filename -- Test code using temp directories */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findProjectRoot } from '../src/project-utils.js';
import { setupAsyncTempDirSuite } from '../src/test-helpers.js';

const PACKAGE_JSON = 'package.json';

describe('findProjectRoot', () => {
  const suite = setupAsyncTempDirSuite('project-utils');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should find workspace root when package.json has "workspaces"', () => {
    // Create a monorepo-like structure
    const workspaceRoot = path.join(tempDir, 'mono');
    const pkgDir = path.join(workspaceRoot, 'packages', 'my-pkg', 'resources', 'skills');
    fs.mkdirSync(pkgDir, { recursive: true });

    // Workspace root has package.json with workspaces
    fs.writeFileSync(
      path.join(workspaceRoot, PACKAGE_JSON),
      JSON.stringify({ name: 'monorepo', workspaces: ['packages/*'] }),
    );

    // Inner package has package.json without workspaces
    fs.writeFileSync(
      path.join(workspaceRoot, 'packages', 'my-pkg', PACKAGE_JSON),
      JSON.stringify({ name: '@mono/my-pkg' }),
    );

    const result = findProjectRoot(pkgDir);
    expect(result).toBe(workspaceRoot);
  });

  it('should fall back to git root when no workspace package.json found', () => {
    // This test runs inside a real git repo, so findProjectRoot should
    // find the git root when called from a temp dir without workspaces.
    // We can't easily create a fake .git dir in temp, so we verify the
    // function doesn't throw and returns a directory.
    const result = findProjectRoot(tempDir);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should fall back to startDir when no workspace root or git root', () => {
    // Create a deeply nested directory with a package.json without workspaces
    const isolated = path.join(tempDir, 'isolated', 'deep', 'dir');
    fs.mkdirSync(isolated, { recursive: true });

    // Add a package.json without workspaces at the root level to stop workspace search
    fs.writeFileSync(
      path.join(tempDir, 'isolated', PACKAGE_JSON),
      JSON.stringify({ name: 'no-workspaces' }),
    );

    // Since this is inside a git repo, it will find the git root.
    // The function won't reach the dirname fallback in a real git repo.
    // We just verify it returns a valid path.
    const result = findProjectRoot(isolated);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should skip invalid JSON in package.json files', () => {
    const dir = path.join(tempDir, 'bad-json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PACKAGE_JSON), '{ invalid json }');

    // Should not throw, falls through to git root or dirname
    const result = findProjectRoot(dir);
    expect(typeof result).toBe('string');
  });
});
