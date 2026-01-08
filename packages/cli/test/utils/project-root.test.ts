import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { findProjectRoot } from '../../src/utils/project-root.js';

describe('findProjectRoot', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'vat-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Helper to create subdirectory
  function createSubDir(): string {
    const subDir = path.join(tempDir, 'sub', 'dir');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test setup with safe tempDir
    fs.mkdirSync(subDir, { recursive: true });
    return subDir;
  }

  it('should find project root with .git directory', () => {
    const gitDir = path.join(tempDir, '.git');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test setup with safe tempDir
    fs.mkdirSync(gitDir);
    const subDir = createSubDir();

    const result = findProjectRoot(subDir);
    expect(result).toBe(tempDir);
  });

  it('should find project root with config file', () => {
    const configFile = path.join(tempDir, 'vibe-agent-toolkit.config.yaml');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test setup with safe tempDir
    fs.writeFileSync(configFile, '');
    const subDir = createSubDir();

    const result = findProjectRoot(subDir);
    expect(result).toBe(tempDir);
  });

  it('should return null when no markers found', () => {
    const subDir = createSubDir();

    const result = findProjectRoot(subDir);
    expect(result).toBeNull();
  });

  it('should return current directory if it is the root', () => {
    const gitDir = path.join(tempDir, '.git');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test setup with safe tempDir
    fs.mkdirSync(gitDir);

    const result = findProjectRoot(tempDir);
    expect(result).toBe(tempDir);
  });
});
