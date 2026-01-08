import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { findGitRoot, isGitignored, loadGitignoreRules } from '../src/gitignore-checker.js';
import { mkdirSyncReal, normalizedTmpdir } from '../src/path-utils.js';

// Test constants
const GITIGNORE_FILENAME = '.gitignore';
const NODE_MODULES_IGNORE_CONTENT = 'node_modules/\n*.log\n';

describe('gitignore-checker', () => {
  let tempDir: string;
  let gitRoot: string;

  beforeEach(() => {
    // Create temp directory structure with git repo
    tempDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'gitignore-test-'));
    gitRoot = tempDir;

    // Create .git directory
     
    mkdirSyncReal(path.join(gitRoot, '.git'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('findGitRoot', () => {
    it('should find git root in current directory', () => {
      const result = findGitRoot(gitRoot);
      expect(result).toBe(gitRoot);
    });

    it('should find git root in parent directory', () => {
      const subDir = path.join(gitRoot, 'subdir');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.mkdirSync(subDir);

      const result = findGitRoot(subDir);
      expect(result).toBe(gitRoot);
    });

    it('should find git root in deeply nested directory', () => {
      const deepDir = path.join(gitRoot, 'a', 'b', 'c');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.mkdirSync(deepDir, { recursive: true });

      const result = findGitRoot(deepDir);
      expect(result).toBe(gitRoot);
    });

    it('should return null when not in a git repository', () => {
      const nonGitDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'non-git-'));
      try {
        const result = findGitRoot(nonGitDir);
        expect(result).toBeNull();
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('loadGitignoreRules', () => {
    it('should return ignore instance even without .gitignore file', () => {
      const ig = loadGitignoreRules(gitRoot);
      expect(ig).not.toBeNull();
      // Should always ignore .git directory
      expect(ig?.ignores('.git')).toBe(true);
    });

    it('should load rules from .gitignore file', () => {
      const gitignorePath = path.join(gitRoot, GITIGNORE_FILENAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.writeFileSync(gitignorePath, NODE_MODULES_IGNORE_CONTENT);

      const ig = loadGitignoreRules(gitRoot);
      expect(ig).not.toBeNull();
      // Directory patterns need trailing slash to match
      expect(ig?.ignores('node_modules/')).toBe(true);
      expect(ig?.ignores('node_modules/package')).toBe(true);
      expect(ig?.ignores('test.log')).toBe(true);
      expect(ig?.ignores('src/index.ts')).toBe(false);
    });

    it('should load rules from nested .gitignore files', () => {
      const rootGitignore = path.join(gitRoot, GITIGNORE_FILENAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.writeFileSync(rootGitignore, '*.log\n');

      const subDir = path.join(gitRoot, 'subdir');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.mkdirSync(subDir);
      const subGitignore = path.join(subDir, GITIGNORE_FILENAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.writeFileSync(subGitignore, '*.tmp\n');

      const ig = loadGitignoreRules(gitRoot, subDir);
      expect(ig).not.toBeNull();
      expect(ig?.ignores('test.log')).toBe(true); // From root
      expect(ig?.ignores('file.tmp')).toBe(true); // From subdir
      expect(ig?.ignores('subdir/file.tmp')).toBe(true); // From subdir
    });

    it('should handle unreadable .gitignore files gracefully', () => {
      const gitignorePath = path.join(gitRoot, GITIGNORE_FILENAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.writeFileSync(gitignorePath, 'node_modules/\n');
      // Make file unreadable (Unix-like systems only)
      if (process.platform !== 'win32') {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
        fs.chmodSync(gitignorePath, 0o000);
      }

      const ig = loadGitignoreRules(gitRoot);
      // Should still return an ignore instance (with just .git rule)
      expect(ig).not.toBeNull();

      // Restore permissions for cleanup
      if (process.platform !== 'win32') {
        // eslint-disable-next-line security/detect-non-literal-fs-filename, sonarjs/file-permissions -- tempDir is from mkdtempSync, safe test file
        fs.chmodSync(gitignorePath, 0o644);
      }
    });
  });

  describe('isGitignored', () => {
    it('should return false for files not in a git repository', () => {
      const nonGitDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'non-git-'));
      try {
        const filePath = path.join(nonGitDir, 'test.txt');
        const result = isGitignored(filePath);
        expect(result).toBe(false);
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    it('should return false when no .gitignore rules exist', () => {
      const filePath = path.join(gitRoot, 'test.txt');
      const result = isGitignored(filePath);
      expect(result).toBe(false);
    });

    it('should return true for gitignored files', () => {
      const gitignorePath = path.join(gitRoot, GITIGNORE_FILENAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.writeFileSync(gitignorePath, NODE_MODULES_IGNORE_CONTENT);

      const logFile = path.join(gitRoot, 'test.log');
      expect(isGitignored(logFile)).toBe(true);

      const nodeModules = path.join(gitRoot, 'node_modules', 'package');
      expect(isGitignored(nodeModules)).toBe(true);
    });

    it('should return false for non-gitignored files', () => {
      const gitignorePath = path.join(gitRoot, GITIGNORE_FILENAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.writeFileSync(gitignorePath, NODE_MODULES_IGNORE_CONTENT);

      const srcFile = path.join(gitRoot, 'src', 'index.ts');
      expect(isGitignored(srcFile)).toBe(false);
    });

    it('should handle files in subdirectories correctly', () => {
      const gitignorePath = path.join(gitRoot, GITIGNORE_FILENAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.writeFileSync(gitignorePath, '**/temp/\n');

      const tempFile = path.join(gitRoot, 'src', 'temp', 'file.txt');
      expect(isGitignored(tempFile)).toBe(true);

      const nonTempFile = path.join(gitRoot, 'src', 'file.txt');
      expect(isGitignored(nonTempFile)).toBe(false);
    });

    it('should use provided gitRoot parameter', () => {
      const gitignorePath = path.join(gitRoot, GITIGNORE_FILENAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.writeFileSync(gitignorePath, '*.log\n');

      const logFile = path.join(gitRoot, 'test.log');
      // Explicitly pass gitRoot
      expect(isGitignored(logFile, gitRoot)).toBe(true);
    });

    it('should always return true for .git directory', () => {
      const gitDir = path.join(gitRoot, '.git');
      expect(isGitignored(gitDir)).toBe(true);

      const gitFile = path.join(gitRoot, '.git', 'config');
      expect(isGitignored(gitFile)).toBe(true);
    });
  });
});
