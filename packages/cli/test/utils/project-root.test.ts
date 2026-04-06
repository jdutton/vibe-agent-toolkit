import * as fs from 'node:fs';

import { setupSyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { findProjectRoot } from '../../src/utils/project-root.js';

// Helper to create subdirectory
function createSubDir(dir: string): string {
  const subDir = safePath.join(dir, 'sub', 'dir');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test setup with safe tempDir
  fs.mkdirSync(subDir, { recursive: true });
  return subDir;
}

describe('findProjectRoot', () => {
  const suite = setupSyncTempDirSuite('vat-test');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should find project root with .git directory', () => {
    const gitDir = safePath.join(tempDir, '.git');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test setup with safe tempDir
    fs.mkdirSync(gitDir);
    const subDir = createSubDir(tempDir);

    const result = findProjectRoot(subDir);
    expect(result).toBe(tempDir);
  });

  it('should find project root with config file', () => {
    const configFile = safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test setup with safe tempDir
    fs.writeFileSync(configFile, '');
    const subDir = createSubDir(tempDir);

    const result = findProjectRoot(subDir);
    expect(result).toBe(tempDir);
  });

  it('should return null when no markers found', () => {
    const subDir = createSubDir(tempDir);

    const result = findProjectRoot(subDir);
    expect(result).toBeNull();
  });

  it('should return current directory if it is the root', () => {
    const gitDir = safePath.join(tempDir, '.git');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test setup with safe tempDir
    fs.mkdirSync(gitDir);

    const result = findProjectRoot(tempDir);
    expect(result).toBe(tempDir);
  });
});
