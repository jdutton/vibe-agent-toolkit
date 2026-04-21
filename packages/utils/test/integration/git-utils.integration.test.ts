import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { gitFindRoot, gitLsFiles, isGitIgnored } from '../../src/git-utils.js';
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
    const subDir = safePath.join(tempDir, 'src', 'components');
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
    const file1 = safePath.join(tempDir, 'README.md');
    const file2 = safePath.join(tempDir, 'src', 'index.ts');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(file1, '# Test');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.mkdirSync(safePath.join(tempDir, 'src'));
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
    fs.writeFileSync(safePath.join(tempDir, 'README.md'), '# Test');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(safePath.join(tempDir, 'test.txt'), 'test');

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
    fs.writeFileSync(safePath.join(tempDir, TRACKED_FILE), '# Tracked');
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
    spawnSync('git', ['add', TRACKED_FILE], { cwd: tempDir, stdio: 'pipe' });

    // Create untracked file
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(safePath.join(tempDir, 'untracked.md'), '# Untracked');

    const result = gitLsFiles({ cwd: tempDir, includeUntracked: true });

    expect(result).not.toBeNull();
    expect(result).toContain(TRACKED_FILE);
    expect(result).toContain('untracked.md');
  });

  it('should return null when not in git repository', () => {
    const nonGitDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'non-git-'));

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
    fs.writeFileSync(safePath.join(tempDir, GITIGNORE_FILENAME), 'node_modules/\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.mkdirSync(safePath.join(tempDir, 'node_modules'));

    const result = isGitIgnored(safePath.join(tempDir, 'node_modules', 'test.js'), tempDir);

    expect(result).toBe(true);
  });

  it('should return false for non-gitignored file', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(safePath.join(tempDir, GITIGNORE_FILENAME), 'node_modules/\n');

    const result = isGitIgnored(safePath.join(tempDir, 'src', 'test.js'), tempDir);

    expect(result).toBe(false);
  });

  it('should handle absolute paths', () => {
    const gitignorePath = safePath.join(tempDir, GITIGNORE_FILENAME);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(gitignorePath, '.worktrees/\n');

    const result = isGitIgnored(safePath.join(tempDir, '.worktrees', 'feat'), tempDir);

    expect(result).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('should detect gitignored files through symlinks via ancestor walk', () => {
    // Simulate: data/ is gitignored, data/linked-content is a symlink to external dir
    // git check-ignore fails with "beyond a symbolic link" for paths through symlinks,
    // but ancestor walk should detect that data/ itself is gitignored
    const dataDir = safePath.join(tempDir, 'data');
    const externalDir = safePath.join(tempDir, 'external-content');
    const linkedDir = safePath.join(dataDir, 'linked-content');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.mkdirSync(dataDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.mkdirSync(externalDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(safePath.join(externalDir, 'doc.md'), '# Test');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.symlinkSync(externalDir, linkedDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file uses controlled temp directory
    fs.writeFileSync(safePath.join(tempDir, GITIGNORE_FILENAME), 'data/\n');

    const result = isGitIgnored(safePath.join(tempDir, 'data', 'linked-content', 'doc.md'), tempDir);

    expect(result).toBe(true);
  });
});

