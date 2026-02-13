/**
 * Unit tests for copy-resources utility
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test file with controlled inputs */

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal, setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from 'vitest';

import { copyResources, createPostBuildScript } from '../../src/utils/copy-resources.js';

const suite = setupSyncTempDirSuite('copy-resources');

describe('copyResources', () => {
  let tempDir: string;
  let sourceDir: string;
  let targetDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
    sourceDir = join(tempDir, 'source');
    targetDir = join(tempDir, 'target');
  });

  it('should copy single file', () => {
    // Setup source
    mkdirSyncReal(sourceDir);
    writeFileSync(join(sourceDir, 'test.txt'), 'content', 'utf-8');

    // Copy
    copyResources({ sourceDir, targetDir });

    // Verify
    expect(existsSync(targetDir)).toBe(true);
    expect(existsSync(join(targetDir, 'test.txt'))).toBe(true);
  });

  it('should copy directory structure recursively', () => {
    // Setup nested structure
    mkdirSyncReal(join(sourceDir, 'nested', 'deep'), { recursive: true });
    writeFileSync(join(sourceDir, 'root.txt'), 'root', 'utf-8');
    writeFileSync(join(sourceDir, 'nested', 'mid.txt'), 'mid', 'utf-8');
    writeFileSync(join(sourceDir, 'nested', 'deep', 'leaf.txt'), 'leaf', 'utf-8');

    // Copy
    copyResources({ sourceDir, targetDir });

    // Verify structure preserved
    expect(existsSync(join(targetDir, 'root.txt'))).toBe(true);
    expect(existsSync(join(targetDir, 'nested', 'mid.txt'))).toBe(true);
    expect(existsSync(join(targetDir, 'nested', 'deep', 'leaf.txt'))).toBe(true);
  });

  it('should throw error if source does not exist', () => {
    const nonexistentSource = join(tempDir, 'does-not-exist');

    expect(() => {
      copyResources({ sourceDir: nonexistentSource, targetDir });
    }).toThrow('Source directory does not exist');
  });

  it('should create target parent directory if needed', () => {
    // Setup source
    mkdirSyncReal(sourceDir);
    writeFileSync(join(sourceDir, 'test.txt'), 'content', 'utf-8');

    // Target parent doesn't exist
    const deepTarget = join(tempDir, 'nested', 'path', 'target');

    // Should create parent and succeed
    copyResources({ sourceDir, targetDir: deepTarget });

    expect(existsSync(deepTarget)).toBe(true);
    expect(existsSync(join(deepTarget, 'test.txt'))).toBe(true);
  });

  it('should handle empty source directory', () => {
    // Create empty source
    mkdirSyncReal(sourceDir);

    // Copy
    copyResources({ sourceDir, targetDir });

    // Target should exist but be empty
    expect(existsSync(targetDir)).toBe(true);
    expect(readdirSync(targetDir)).toHaveLength(0);
  });

  it('should support verbose logging', () => {
    // Setup source
    mkdirSyncReal(sourceDir);
    writeFileSync(join(sourceDir, 'test.txt'), 'content', 'utf-8');

    // Should not throw with verbose enabled
    expect(() => {
      copyResources({ sourceDir, targetDir, verbose: true });
    }).not.toThrow();

    expect(existsSync(join(targetDir, 'test.txt'))).toBe(true);
  });

  it('should wrap copy errors with context', () => {
    // Setup source
    mkdirSyncReal(sourceDir);
    writeFileSync(join(sourceDir, 'test.txt'), 'content', 'utf-8');

    // Try to copy to invalid target (simulate permission error by using null character)
    const invalidTarget = join(tempDir, 'target\0invalid');

    expect(() => {
      copyResources({ sourceDir, targetDir: invalidTarget });
    }).toThrow('Failed to copy resources');
  });
});

// createPostBuildScript joins generatedDir under distDir: join(distDir, generatedDir).
// On Windows, path.join with two absolute paths creates invalid paths (drive letter in middle).
// On Windows (forks pool), process.chdir is available — use relative paths.
// On Unix (threads pool, no chdir), POSIX path.join handles two absolute paths correctly.
const isWindows = process.platform === 'win32';

describe('createPostBuildScript', () => {
  let tempDir: string;
  let savedCwd: string | undefined;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
    if (isWindows) {
      savedCwd = process.cwd();
      process.chdir(tempDir);
    }
  });
  afterEach(() => {
    if (savedCwd !== undefined) {
      process.chdir(savedCwd);
      savedCwd = undefined;
    }
  });

  /** Return relative paths on Windows (chdir), absolute on Unix */
  function testPath(name: string): string {
    return isWindows ? name : join(tempDir, name);
  }

  it('should copy generated dir to dist/generated', () => {
    const generatedDir = testPath('generated');
    const distDir = testPath('dist');

    mkdirSyncReal(join(tempDir, 'generated'));
    writeFileSync(join(tempDir, 'generated', 'output.js'), 'code', 'utf-8');

    createPostBuildScript({ generatedDir, distDir });

    expect(existsSync(join(distDir, generatedDir, 'output.js'))).toBe(true);
  });

  it('should exit process on error', () => {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('process.exit called');
    }) as never;

    try {
      expect(() => {
        createPostBuildScript({
          generatedDir: testPath('does-not-exist'),
          distDir: testPath('dist'),
        });
      }).toThrow('process.exit called');

      expect(exitCode).toBe(1);
    } finally {
      process.exit = originalExit;
    }
  });

  it('should support verbose logging', () => {
    const generatedDir = testPath('generated');
    const distDir = testPath('dist');

    mkdirSyncReal(join(tempDir, 'generated'));
    writeFileSync(join(tempDir, 'generated', 'output.js'), 'code', 'utf-8');

    expect(() => {
      createPostBuildScript({ generatedDir, distDir, verbose: true });
    }).not.toThrow();

    expect(existsSync(join(distDir, generatedDir))).toBe(true);
  });
});
