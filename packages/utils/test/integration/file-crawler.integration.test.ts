import { spawnSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { crawlDirectory, crawlDirectorySync } from '../../src/file-crawler.js';
import { mkdirSyncReal, toForwardSlash } from '../../src/path-utils.js';
import { setupSyncTempDirSuite } from '../../src/test-helpers.js';
import { createGitRepo } from '../test-helpers.js';

/**
 * Helper to create test file structure
 */
function createTestStructure(testDir: string): void {
  /* eslint-disable security/detect-non-literal-fs-filename -- testDir is controlled temp directory from mkdtemp */
  // Root files
  writeFileSync(safePath.join(testDir, 'README.md'), '# Root README');
  writeFileSync(safePath.join(testDir, 'package.json'), '{}');

  // docs directory
  mkdirSyncReal(safePath.join(testDir, 'docs'));
  writeFileSync(safePath.join(testDir, 'docs', 'guide.md'), '# Guide');
  writeFileSync(safePath.join(testDir, 'docs', 'api.md'), '# API');

  // docs/advanced subdirectory
  mkdirSyncReal(safePath.join(testDir, 'docs', 'advanced'));
  writeFileSync(safePath.join(testDir, 'docs', 'advanced', 'performance.md'), '# Performance');

  // src directory
  mkdirSyncReal(safePath.join(testDir, 'src'));
  writeFileSync(safePath.join(testDir, 'src', 'index.ts'), '// code');
  writeFileSync(safePath.join(testDir, 'src', 'utils.ts'), '// utils');

  // node_modules (should be excluded by default)
  mkdirSyncReal(safePath.join(testDir, 'node_modules'));
  writeFileSync(safePath.join(testDir, 'node_modules', 'package.md'), '# Should be excluded');
  /* eslint-enable security/detect-non-literal-fs-filename */
}

describe('file-crawler', () => {
  const suite = setupSyncTempDirSuite('file-crawler');
  let testDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    testDir = suite.getTempDir();
  });


  describe('crawlDirectorySync', () => {
    it('should find all files with default options', () => {
      createTestStructure(testDir);

      const files = crawlDirectorySync({
        baseDir: testDir,
      });

      // Should find all files except node_modules
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((f) => f.startsWith(testDir))).toBe(true); // absolute paths
      expect(files.map(toForwardSlash).includes(toForwardSlash(safePath.join(testDir, 'node_modules', 'package.md')))).toBe(false); // excluded by default
    });

    it('should find markdown files with include pattern', () => {
      createTestStructure(testDir);

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*.md'],
      });

      expect(files.length).toBe(4); // README.md, guide.md, api.md, performance.md
      expect(files.every((f) => f.endsWith('.md'))).toBe(true);
      expect(files.some((f) => f.endsWith('README.md'))).toBe(true);
      expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    });

    it('should exclude specified patterns', () => {
      createTestStructure(testDir);

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*.md'],
        exclude: ['**/docs/**', '**/node_modules/**'],
      });

      expect(files.length).toBe(1); // Only README.md
      expect(files[0]).toMatch(/README\.md$/);
    });

    it('should find files in specific directory with pattern', () => {
      createTestStructure(testDir);

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['docs/**/*.md'],
      });

      expect(files.length).toBe(3); // guide.md, api.md, performance.md
      expect(files.every((f) => f.includes('docs'))).toBe(true);
    });

    it('should return relative paths when absolute=false', () => {
      createTestStructure(testDir);

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*.md'],
        absolute: false,
      });

      expect(files.length).toBe(4);
      expect(files.every((f) => !path.isAbsolute(f))).toBe(true);
      expect(files.includes('README.md')).toBe(true);
    });

    it('should handle multiple include patterns', () => {
      createTestStructure(testDir);

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*.md', '**/*.ts'],
      });

      expect(files.length).toBe(6); // 4 .md files + 2 .ts files
      expect(files.some((f) => f.endsWith('.md'))).toBe(true);
      expect(files.some((f) => f.endsWith('.ts'))).toBe(true);
    });

    it('should handle empty directory', () => {
      const emptyDir = safePath.join(testDir, 'empty');
       
      mkdirSyncReal(emptyDir);

      const files = crawlDirectorySync({
        baseDir: emptyDir,
      });

      expect(files).toEqual([]);
    });

    it('should throw error for non-existent directory', () => {
      expect(() =>
        crawlDirectorySync({
          baseDir: '/non/existent/path',
        })
      ).toThrow('Base directory does not exist');
    });

    it('should throw error when baseDir is a file', () => {
      const filePath = safePath.join(testDir, 'file.txt');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is controlled temp directory
      writeFileSync(filePath, 'content');

      expect(() =>
        crawlDirectorySync({
          baseDir: filePath,
        })
      ).toThrow('Base path is not a directory');
    });

    it('should include directories when filesOnly=false', () => {
      createTestStructure(testDir);

      const results = crawlDirectorySync({
        baseDir: testDir,
        include: ['docs/**'],
        filesOnly: false,
      });

      // Should include docs/ directory and its files
      expect(results.some((r) => r.endsWith('docs'))).toBe(true);
    });

    it('should handle nested exclude patterns', () => {
      createTestStructure(testDir);

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*.md'],
        exclude: ['**/advanced/**', '**/node_modules/**'], // Include node_modules in exclude
      });

      expect(files.length).toBe(3); // Excludes docs/advanced/performance.md and node_modules
      expect(files.some((f) => f.includes('performance'))).toBe(false);
      expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    });

    it('should handle glob patterns with wildcards', () => {
      createTestStructure(testDir);

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/g*.md'], // guide.md
      });

      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/guide\.md$/);
    });

    describe('symlink handling', () => {
      it('should skip symlinks by default', () => {
        createTestStructure(testDir);

        // Create a symlink to a markdown file
        const targetFile = safePath.join(testDir, 'docs', 'guide.md');
        const symlinkPath = safePath.join(testDir, 'link.md');

        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is controlled temp directory
          symlinkSync(targetFile, symlinkPath);
        } catch {
          // Skip test if symlinks not supported (Windows without admin)
          return;
        }

        const files = crawlDirectorySync({
          baseDir: testDir,
          include: ['*.md'], // Only root level
          followSymlinks: false,
        });

        // Should only find README.md, not link.md (symlink)
        expect(files.length).toBe(1);
        expect(files[0]).toMatch(/README\.md$/);
      });

      it('should follow symlinks when followSymlinks=true', () => {
        createTestStructure(testDir);

        const targetFile = safePath.join(testDir, 'docs', 'guide.md');
        const symlinkPath = safePath.join(testDir, 'link.md');

        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is controlled temp directory
          symlinkSync(targetFile, symlinkPath);
        } catch {
          // Skip test if symlinks not supported
          return;
        }

        const files = crawlDirectorySync({
          baseDir: testDir,
          include: ['*.md'],
          followSymlinks: true,
        });

        // Should find README.md and link.md (followed symlink)
        expect(files.length).toBe(2);
      });
    });
  });

  describe('crawlDirectory (async)', () => {
    it('should find all markdown files', async () => {
      createTestStructure(testDir);

      const files = await crawlDirectory({
        baseDir: testDir,
        include: ['**/*.md'],
      });

      expect(files.length).toBe(4);
      expect(files.every((f) => f.endsWith('.md'))).toBe(true);
    });

    it('should return same results as sync version', async () => {
      createTestStructure(testDir);

      const asyncFiles = await crawlDirectory({
        baseDir: testDir,
        include: ['**/*.md'],
      });

      const syncFiles = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*.md'],
      });

      // Sort arrays for comparison
      const sortedAsync = [...asyncFiles].sort((a, b) => a.localeCompare(b));
      const sortedSync = [...syncFiles].sort((a, b) => a.localeCompare(b));
      expect(sortedAsync).toEqual(sortedSync);
    });
  });

  describe('cross-platform behavior', () => {
    it('should handle paths with different separators', () => {
      createTestStructure(testDir);

      // Test that pattern matching works regardless of platform separator
      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['docs/**/*.md'], // Always forward slashes in patterns
      });

      expect(files.length).toBe(3);
      expect(files.every((f) => f.includes('docs'))).toBe(true);
    });

    it('should return consistent absolute paths', () => {
      createTestStructure(testDir);

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*.md'],
        absolute: true,
      });

      expect(files.every((f) => path.isAbsolute(f))).toBe(true);
      expect(files.every((f) => f.startsWith(testDir))).toBe(true);
    });
  });

  describe('gitignore integration', () => {
    it('should respect .gitignore by default', () => {
      createTestStructure(testDir);

      // Initialize git repo properly (git ls-files needs a real repo)
      createGitRepo(testDir);

      // Create .gitignore file
      const gitignorePath = safePath.join(testDir, '.gitignore');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is controlled temp directory
      writeFileSync(gitignorePath, 'docs/\n*.log\n');

      // Track only non-ignored files (git ls-files returns tracked files)
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
      spawnSync('git', ['add', 'src/', 'README.md'], { cwd: testDir, stdio: 'pipe' });

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*'],
      });

      // Should only include tracked files (not docs/ or *.log)
      expect(files.every((f) => !f.includes('docs'))).toBe(true);
      expect(files.every((f) => !f.endsWith('.log'))).toBe(true);
    });

    it('should allow disabling gitignore', () => {
      createTestStructure(testDir);

      // Create .git directory
       
      mkdirSyncReal(safePath.join(testDir, '.git'));

      // Create .gitignore file
      const gitignorePath = safePath.join(testDir, '.gitignore');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is controlled temp directory
      writeFileSync(gitignorePath, 'docs/\n');

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*.md'],
        respectGitignore: false,
      });

      // Should include docs/ files since gitignore is disabled
      expect(files.some((f) => f.includes('docs'))).toBe(true);
    });
  });
});
