/**
 * Unit tests for copy-resources utility
 */


import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';


import { ExitCode } from '@vibe-agent-toolkit/schema';
import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
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
    sourceDir = safePath.join(tempDir, 'source');
    targetDir = safePath.join(tempDir, 'target');
  });

  it('should copy single file', async () => {
    // Setup source
    mkdirSyncReal(sourceDir);
    writeFileSync(safePath.join(sourceDir, 'test.txt'), 'content', 'utf-8');

    // Copy
    await copyResources({ sourceDir, targetDir });

    // Verify
    expect(existsSync(targetDir)).toBe(true);
    expect(existsSync(safePath.join(targetDir, 'test.txt'))).toBe(true);
  });

  it('should copy directory structure recursively', async () => {
    // Setup nested structure
    mkdirSyncReal(safePath.join(sourceDir, 'nested', 'deep'), { recursive: true });
    writeFileSync(safePath.join(sourceDir, 'root.txt'), 'root', 'utf-8');
    writeFileSync(safePath.join(sourceDir, 'nested', 'mid.txt'), 'mid', 'utf-8');
    writeFileSync(safePath.join(sourceDir, 'nested', 'deep', 'leaf.txt'), 'leaf', 'utf-8');

    // Copy
    await copyResources({ sourceDir, targetDir });

    // Verify structure preserved
    expect(existsSync(safePath.join(targetDir, 'root.txt'))).toBe(true);
    expect(existsSync(safePath.join(targetDir, 'nested', 'mid.txt'))).toBe(true);
    expect(existsSync(safePath.join(targetDir, 'nested', 'deep', 'leaf.txt'))).toBe(true);
  });

  it('should throw error if source does not exist', async () => {
    const nonexistentSource = safePath.join(tempDir, 'does-not-exist');

    await expect(copyResources({ sourceDir: nonexistentSource, targetDir })).rejects.toThrow('Source directory does not exist');
  });

  it('should create target parent directory if needed', async () => {
    // Setup source
    mkdirSyncReal(sourceDir);
    writeFileSync(safePath.join(sourceDir, 'test.txt'), 'content', 'utf-8');

    // Target parent doesn't exist
    const deepTarget = safePath.join(tempDir, 'nested', 'path', 'target');

    // Should create parent and succeed
    await copyResources({ sourceDir, targetDir: deepTarget });

    expect(existsSync(deepTarget)).toBe(true);
    expect(existsSync(safePath.join(deepTarget, 'test.txt'))).toBe(true);
  });

  it('should handle empty source directory', async () => {
    // Create empty source
    mkdirSyncReal(sourceDir);

    // Copy
    await copyResources({ sourceDir, targetDir });

    // Target should exist but be empty
    expect(existsSync(targetDir)).toBe(true);
    expect(readdirSync(targetDir)).toHaveLength(0);
  });

  it('should support verbose logging', async () => {
    // Setup source
    mkdirSyncReal(sourceDir);
    writeFileSync(safePath.join(sourceDir, 'test.txt'), 'content', 'utf-8');

    // Should not throw with verbose enabled
    await expect(copyResources({ sourceDir, targetDir, verbose: true })).resolves.toBeUndefined();

    expect(existsSync(safePath.join(targetDir, 'test.txt'))).toBe(true);
  });

  // The target is the adopter's (it may be `dist` itself, holding `tsc`'s output): the copy
  // goes in and removes nothing it cannot prove it made.
  it('copies into the target, leaving what is already there and unrelated to the source untouched', async () => {
    mkdirSyncReal(sourceDir);
    writeFileSync(safePath.join(sourceDir, 'generated.js'), 'new', 'utf-8');
    mkdirSyncReal(safePath.join(targetDir, 'src'), { recursive: true });
    writeFileSync(safePath.join(targetDir, 'src', 'index.js'), 'tsc output', 'utf-8');
    writeFileSync(safePath.join(targetDir, 'generated.js'), 'old', 'utf-8');

    await copyResources({ sourceDir, targetDir });

    expect(readFileSync(safePath.join(targetDir, 'src', 'index.js'), 'utf-8')).toBe('tsc output');
    expect(readFileSync(safePath.join(targetDir, 'generated.js'), 'utf-8')).toBe('new');
  });

  const SKILLS_DIR = 'skills';
  const EXCLUDED_SUBDIR = `${SKILLS_DIR}/evals`;
  const SIBLING_SUBDIR = `${SKILLS_DIR}/evals-notes`;

  // The copy is never written where a link standing at `targetDir` points: the copy's root is a
  // real directory or nothing.
  it('refuses a targetDir that is a symbolic link to a directory, writing nothing where it points', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    mkdirSyncReal(sourceDir);
    writeFileSync(safePath.join(sourceDir, 'test.txt'), 'content', 'utf-8');
    const elsewhere = safePath.join(tempDir, 'elsewhere');
    mkdirSyncReal(elsewhere);
    createSymlink(cap, elsewhere, targetDir, 'dir');

    await expect(copyResources({ sourceDir, targetDir })).rejects.toThrow(/^Failed to copy resources: EEXIST/);

    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('should exclude a specified subdirectory and its contents', async () => {
    mkdirSyncReal(safePath.join(sourceDir, EXCLUDED_SUBDIR, 'fixtures'), { recursive: true });
    writeFileSync(safePath.join(sourceDir, SKILLS_DIR, 'SKILL.js'), 'skill', 'utf-8');
    writeFileSync(safePath.join(sourceDir, EXCLUDED_SUBDIR, 'evals.json'), '{}', 'utf-8');
    writeFileSync(safePath.join(sourceDir, EXCLUDED_SUBDIR, 'fixtures', 'fixture.js'), 'fixture', 'utf-8');

    await copyResources({ sourceDir, targetDir, exclude: [EXCLUDED_SUBDIR] });

    expect(existsSync(safePath.join(targetDir, SKILLS_DIR, 'SKILL.js'))).toBe(true);
    expect(existsSync(safePath.join(targetDir, EXCLUDED_SUBDIR))).toBe(false);
  });

  it('should leave sibling paths that merely share a prefix with an excluded entry untouched', async () => {
    mkdirSyncReal(safePath.join(sourceDir, EXCLUDED_SUBDIR), { recursive: true });
    mkdirSyncReal(safePath.join(sourceDir, SIBLING_SUBDIR), { recursive: true });
    writeFileSync(safePath.join(sourceDir, EXCLUDED_SUBDIR, 'evals.json'), '{}', 'utf-8');
    writeFileSync(safePath.join(sourceDir, SIBLING_SUBDIR, 'note.txt'), 'note', 'utf-8');

    await copyResources({ sourceDir, targetDir, exclude: [EXCLUDED_SUBDIR] });

    expect(existsSync(safePath.join(targetDir, EXCLUDED_SUBDIR))).toBe(false);
    expect(existsSync(safePath.join(targetDir, SIBLING_SUBDIR, 'note.txt'))).toBe(true);
  });

  it('should wrap copy errors with context', async () => {
    // Setup source
    mkdirSyncReal(sourceDir);
    writeFileSync(safePath.join(sourceDir, 'test.txt'), 'content', 'utf-8');

    // Try to copy to invalid target (simulate permission error by using null character)
    const invalidTarget = safePath.join(tempDir, 'target\0invalid');

    await expect(copyResources({ sourceDir, targetDir: invalidTarget })).rejects.toThrow('Failed to copy resources');
  });
});

// createPostBuildScript joins generatedDir under distDir: safePath.join(distDir, generatedDir).
// On Windows, path.join with two absolute paths creates invalid paths (drive letter in middle).
// On Windows (forks pool), process.chdir is available — use relative paths.
// On Unix (threads pool, no chdir), POSIX path.join handles two absolute paths correctly.
const isWindows = process.platform === 'win32';

/** Return relative paths on Windows (chdir), absolute on Unix */
function testPath(tempDir: string, name: string): string {
  return isWindows ? name : safePath.join(tempDir, name);
}

function setupGeneratedDir(tempDir: string): { generatedDir: string; distDir: string } {
  const generatedDir = testPath(tempDir, 'generated');
  const distDir = testPath(tempDir, 'dist');
  mkdirSyncReal(safePath.join(tempDir, 'generated'));
  writeFileSync(safePath.join(tempDir, 'generated', 'output.js'), 'code', 'utf-8');
  return { generatedDir, distDir };
}

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

  it('should copy generated dir to dist/generated', async () => {
    const { generatedDir, distDir } = setupGeneratedDir(tempDir);

    await createPostBuildScript({ generatedDir, distDir });

    expect(existsSync(safePath.join(distDir, generatedDir, 'output.js'))).toBe(true);
  });

  it('should exit process on error', async () => {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('process.exit called');
    }) as never;

    try {
      await expect(createPostBuildScript({
          generatedDir: testPath(tempDir, 'does-not-exist'),
          distDir: testPath(tempDir, 'dist'),
        })).rejects.toThrow('process.exit called');

      // The command could not do its job: ERROR, not a finding.
      expect(exitCode).toBe(ExitCode.ERROR);
    } finally {
      process.exit = originalExit;
    }
  });

  it('should support verbose logging', async () => {
    const { generatedDir, distDir } = setupGeneratedDir(tempDir);

    await expect(createPostBuildScript({ generatedDir, distDir, verbose: true })).resolves.toBeUndefined();

    expect(existsSync(safePath.join(distDir, generatedDir))).toBe(true);
  });
});
