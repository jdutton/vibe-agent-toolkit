import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { gitFindRoot, gitLsFiles, isGitIgnored, gitCheckIgnoredBatch } from '../../src/git-utils.js';
import { normalizedTmpdir } from '../../src/path-utils.js';
import { setupSyncTempDirSuite } from '../../src/test-helpers.js';
import { createGitRepo } from '../test-helpers.js';

const GITIGNORE_FILENAME = '.gitignore';

/**
 * Helper to set up a git repository with user config for testing
 */
function setupGitRepo(tempDir: string): void {
  createGitRepo(tempDir);
  const gitPath = 'git';
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
  spawnSync(gitPath, ['config', 'user.email', 'test@example.com'], { cwd: tempDir, stdio: 'pipe' });
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
  spawnSync(gitPath, ['config', 'user.name', 'Test User'], { cwd: tempDir, stdio: 'pipe' });
}

/**
 * Helper to set up a git test suite with temp directory and git repo
 * Reduces duplication across test suites
 */
function setupGitTestSuite(suiteName: string) {
  const suite = setupSyncTempDirSuite(suiteName);
  let tempDir: string;

  const getTempDir = () => tempDir;

  const hooks = {
    beforeAll: suite.beforeAll,
    afterAll: suite.afterAll,
    beforeEach: () => {
      suite.beforeEach();
      tempDir = suite.getTempDir();
      setupGitRepo(tempDir);
    },
  };

  return { ...hooks, getTempDir };
}

/**
 * Helper to assert all files in result are not ignored
 * Extracted to outer scope to avoid function-in-loop code smell
 */
function expectAllNotIgnored(result: Map<string, boolean>, files: string[]) {
  expect(result.size).toBe(files.length);
  for (const file of files) {
    expect(result.get(file)).toBe(false);
  }
}

describe('gitFindRoot', () => {
  const suite = setupSyncTempDirSuite('git-find-root');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should find git root in repository', () => {
    createGitRepo(tempDir);

    // Create subdirectory
    const subDir = path.join(tempDir, 'src', 'components');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.mkdirSync(subDir, { recursive: true });

    const result = gitFindRoot(subDir);

    expect(result).toBe(tempDir);
  });

  it('should return null when not in git repository', () => {
    // Use temp directory without .git
    const result = gitFindRoot(tempDir);

    expect(result).toBeNull();
  });

  it('should handle directory at filesystem root', () => {
    // Test with a path near filesystem root (won't have .git)
    const result = gitFindRoot(normalizedTmpdir());

    // Should return null or a parent git repo (both are valid)
    // Most systems won't have .git at root
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('gitLsFiles', () => {
  const suite = setupSyncTempDirSuite('git-ls-files');
  let tempDir: string;
  const TRACKED_FILE = 'tracked.md';

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
    setupGitRepo(tempDir);
  });

  it('should list tracked files', () => {
    // Create and track files
    const file1 = path.join(tempDir, 'README.md');
    const file2 = path.join(tempDir, 'src', 'index.ts');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(file1, '# Test');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.mkdirSync(path.join(tempDir, 'src'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(file2, 'export {}');

    // Add files to git
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
    spawnSync('git', ['add', '.'], { cwd: tempDir, stdio: 'pipe' });

    const result = gitLsFiles({ cwd: tempDir });

    expect(result).not.toBeNull();
    expect(result).toContain('README.md');
    expect(result).toContain('src/index.ts');
  });

  it('should filter by patterns', () => {
    // Create files
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'test');

    // Add files to git
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
    spawnSync('git', ['add', '.'], { cwd: tempDir, stdio: 'pipe' });

    const result = gitLsFiles({ cwd: tempDir, patterns: ['*.md'] });

    expect(result).not.toBeNull();
    expect(result).toContain('README.md');
    expect(result).not.toContain('test.txt');
  });

  it('should include untracked files when requested', () => {
    // Create tracked file
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(path.join(tempDir, TRACKED_FILE), '# Tracked');
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
    spawnSync('git', ['add', TRACKED_FILE], { cwd: tempDir, stdio: 'pipe' });

    // Create untracked file
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(path.join(tempDir, 'untracked.md'), '# Untracked');

    const result = gitLsFiles({ cwd: tempDir, includeUntracked: true });

    expect(result).not.toBeNull();
    expect(result).toContain(TRACKED_FILE);
    expect(result).toContain('untracked.md');
  });

  it('should return null when not in git repository', () => {
    const nonGitDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'non-git-'));

    try {
      const result = gitLsFiles({ cwd: nonGitDir });
      expect(result).toBeNull();
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('should handle empty repository', () => {
    // Fresh repo with no files
    const result = gitLsFiles({ cwd: tempDir });

    expect(result).not.toBeNull();
    expect(result).toEqual([]);
  });
});

describe('isGitIgnored', () => {
  const suite = setupGitTestSuite('git-utils');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should return true for gitignored file', () => {
    // Create .gitignore
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(path.join(tempDir, GITIGNORE_FILENAME), 'node_modules/\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.mkdirSync(path.join(tempDir, 'node_modules'));

    const result = isGitIgnored(path.join(tempDir, 'node_modules', 'test.js'), tempDir);

    expect(result).toBe(true);
  });

  it('should return false for non-gitignored file', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(path.join(tempDir, GITIGNORE_FILENAME), 'node_modules/\n');

    const result = isGitIgnored(path.join(tempDir, 'src', 'test.js'), tempDir);

    expect(result).toBe(false);
  });

  it('should handle absolute paths', () => {
    const gitignorePath = path.join(tempDir, GITIGNORE_FILENAME);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(gitignorePath, '.worktrees/\n');

    const result = isGitIgnored(path.join(tempDir, '.worktrees', 'feat'), tempDir);

    expect(result).toBe(true);
  });
});

describe('gitCheckIgnoredBatch', () => {
  const suite = setupGitTestSuite('git-check-ignored-batch');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should return empty map for empty array', () => {
    const result = gitCheckIgnoredBatch([], tempDir);

    expect(result.size).toBe(0);
  });

  it('should identify ignored and non-ignored files', () => {
    // Create .gitignore
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(
      path.join(tempDir, GITIGNORE_FILENAME),
      'node_modules/\ndist/\n*.log\n'
    );

    const files = [
      path.join(tempDir, 'src', 'index.ts'),
      path.join(tempDir, 'node_modules', 'foo.js'),
      path.join(tempDir, 'dist', 'bundle.js'),
      path.join(tempDir, 'debug.log'),
      path.join(tempDir, 'README.md'),
    ];

    const result = gitCheckIgnoredBatch(files, tempDir);

    expect(result.size).toBe(5);
    expect(result.get(files[0])).toBe(false); // src/index.ts - not ignored
    expect(result.get(files[1])).toBe(true);  // node_modules/foo.js - ignored
    expect(result.get(files[2])).toBe(true);  // dist/bundle.js - ignored
    expect(result.get(files[3])).toBe(true);  // debug.log - ignored
    expect(result.get(files[4])).toBe(false); // README.md - not ignored
  });

  it('should handle all files ignored', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(
      path.join(tempDir, GITIGNORE_FILENAME),
      '*.tmp\n'
    );

    const files = [
      path.join(tempDir, 'file1.tmp'),
      path.join(tempDir, 'file2.tmp'),
    ];

    const result = gitCheckIgnoredBatch(files, tempDir);

    expect(result.size).toBe(2);
    expect(result.get(files[0])).toBe(true);
    expect(result.get(files[1])).toBe(true);
  });

  it('should handle no files ignored', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(
      path.join(tempDir, GITIGNORE_FILENAME),
      '*.tmp\n'
    );

    const files = [
      path.join(tempDir, 'file1.ts'),
      path.join(tempDir, 'file2.ts'),
    ];

    const result = gitCheckIgnoredBatch(files, tempDir);

    expectAllNotIgnored(result, files);
  });

  it('should return all false when not in git repository', () => {
    const nonGitDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'non-git-'));

    try {
      const files = [
        path.join(nonGitDir, 'file1.ts'),
        path.join(nonGitDir, 'file2.ts'),
      ];

      const result = gitCheckIgnoredBatch(files, nonGitDir);

      expectAllNotIgnored(result, files);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('should handle relative and absolute paths', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(
      path.join(tempDir, GITIGNORE_FILENAME),
      'ignored/\n'
    );

    const files = [
      'src/index.ts', // relative
      path.join(tempDir, 'ignored', 'file.ts'), // absolute
    ];

    const result = gitCheckIgnoredBatch(files, tempDir);

    expect(result.size).toBe(2);
    expect(result.get(files[0])).toBe(false); // src/index.ts - not ignored
    expect(result.get(files[1])).toBe(true);  // ignored/file.ts - ignored
  });
});
