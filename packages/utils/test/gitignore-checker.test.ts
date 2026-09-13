import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { gitFindRoot } from '../src/git-utils.js';
import { loadGitignoreRules } from '../src/gitignore-checker.js';
import { mkdirSyncReal, normalizedTmpdir } from '../src/path-utils.js';
import { setupSyncTempDirSuite } from '../src/test-helpers.js';

// Test constants
const GITIGNORE_FILENAME = '.gitignore';
const NODE_MODULES_IGNORE_CONTENT = 'node_modules/\n*.log\n';

describe('gitignore-checker', () => {
  const suite = setupSyncTempDirSuite('gitignore');
  let tempDir: string;
  let gitRoot: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
    gitRoot = tempDir;

    // Create .git directory
    mkdirSyncReal(safePath.join(gitRoot, '.git'));
  });

  describe('gitFindRoot', () => {
    it('should find git root in current directory', () => {
      const result = gitFindRoot(gitRoot);
      expect(result).toBe(gitRoot);
    });

    it('should find git root in parent directory', () => {
      const subDir = safePath.join(gitRoot, 'subdir');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.mkdirSync(subDir);

      const result = gitFindRoot(subDir);
      expect(result).toBe(gitRoot);
    });

    it('should find git root in deeply nested directory', () => {
      const deepDir = safePath.join(gitRoot, 'a', 'b', 'c');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.mkdirSync(deepDir, { recursive: true });

      const result = gitFindRoot(deepDir);
      expect(result).toBe(gitRoot);
    });

    it('should return null when not in a git repository', () => {
      const nonGitDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'non-git-'));
      try {
        const result = gitFindRoot(nonGitDir);
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
      const gitignorePath = safePath.join(gitRoot, GITIGNORE_FILENAME);
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
      const rootGitignore = safePath.join(gitRoot, GITIGNORE_FILENAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.writeFileSync(rootGitignore, '*.log\n');

      const subDir = safePath.join(gitRoot, 'subdir');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.mkdirSync(subDir);
      const subGitignore = safePath.join(subDir, GITIGNORE_FILENAME);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.writeFileSync(subGitignore, '*.tmp\n');

      const ig = loadGitignoreRules(gitRoot, subDir);
      expect(ig).not.toBeNull();
      expect(ig?.ignores('test.log')).toBe(true); // From root
      expect(ig?.ignores('file.tmp')).toBe(true); // From subdir
      expect(ig?.ignores('subdir/file.tmp')).toBe(true); // From subdir
    });

    // A `.gitignore` that exists but cannot be read holds rules this checker
    // cannot honour. It used to be skipped silently — "handled gracefully" —
    // which meant a crawl proceeded WITHOUT the rules and enumerated the
    // ignored tree, with nothing anywhere saying so. Only a file that vanished
    // between `existsSync` and the read is skipped now; a refusal is loud.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'throws EACCES for a .gitignore the OS refuses to read, rather than crawling without its rules',
      () => {
        const gitignorePath = safePath.join(gitRoot, GITIGNORE_FILENAME);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
        fs.writeFileSync(gitignorePath, 'node_modules/\n');
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
        fs.chmodSync(gitignorePath, 0o000);
        try {
          expect(() => loadGitignoreRules(gitRoot)).toThrow(/EACCES/);
        } finally {
          // eslint-disable-next-line security/detect-non-literal-fs-filename, sonarjs/file-permissions -- tempDir is from mkdtempSync, safe test file
          fs.chmodSync(gitignorePath, 0o644);
        }
      },
    );

    it('throws EISDIR for a DIRECTORY named .gitignore, on every platform', () => {
      // Reaches the same catch as the chmod case without needing POSIX modes or
      // a non-root user: `existsSync` says yes, `readFileSync` refuses.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtempSync
      fs.mkdirSync(safePath.join(gitRoot, GITIGNORE_FILENAME));
      expect(() => loadGitignoreRules(gitRoot)).toThrow(/EISDIR/);
    });
  });
});
