import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crawlDirectory, crawlDirectorySync } from '../src/file-crawler.js';

/**
 * Get normalized temp directory path (handles Windows short paths)
 */
function normalizedTmpdir(): string {
  try {
    return realpathSync.native(tmpdir());
  } catch {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tmpdir() is from Node.js os module, safe
    return realpathSync(tmpdir());
  }
}

describe('file-crawler', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary directory for testing
    testDir = mkdtempSync(path.join(normalizedTmpdir(), 'file-crawler-test-'));
  });

  afterEach(() => {
    // Clean up temporary directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper to create test file structure
   */
  function createTestStructure(): void {
    /* eslint-disable security/detect-non-literal-fs-filename -- testDir is controlled temp directory from mkdtemp */
    // Root files
    writeFileSync(path.join(testDir, 'README.md'), '# Root README');
    writeFileSync(path.join(testDir, 'package.json'), '{}');

    // docs directory
    mkdirSync(path.join(testDir, 'docs'));
    writeFileSync(path.join(testDir, 'docs', 'guide.md'), '# Guide');
    writeFileSync(path.join(testDir, 'docs', 'api.md'), '# API');

    // docs/advanced subdirectory
    mkdirSync(path.join(testDir, 'docs', 'advanced'));
    writeFileSync(path.join(testDir, 'docs', 'advanced', 'performance.md'), '# Performance');

    // src directory
    mkdirSync(path.join(testDir, 'src'));
    writeFileSync(path.join(testDir, 'src', 'index.ts'), '// code');
    writeFileSync(path.join(testDir, 'src', 'utils.ts'), '// utils');

    // node_modules (should be excluded by default)
    mkdirSync(path.join(testDir, 'node_modules'));
    writeFileSync(path.join(testDir, 'node_modules', 'package.md'), '# Should be excluded');
    /* eslint-enable security/detect-non-literal-fs-filename */
  }

  describe('crawlDirectorySync', () => {
    it('should find all files with default options', () => {
      createTestStructure();

      const files = crawlDirectorySync({
        baseDir: testDir,
      });

      // Should find all files except node_modules
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((f) => f.startsWith(testDir))).toBe(true); // absolute paths
      expect(files.includes(path.join(testDir, 'node_modules', 'package.md'))).toBe(false); // excluded by default
    });

    it('should find markdown files with include pattern', () => {
      createTestStructure();

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
      createTestStructure();

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*.md'],
        exclude: ['**/docs/**', '**/node_modules/**'],
      });

      expect(files.length).toBe(1); // Only README.md
      expect(files[0]).toMatch(/README\.md$/);
    });

    it('should find files in specific directory with pattern', () => {
      createTestStructure();

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['docs/**/*.md'],
      });

      expect(files.length).toBe(3); // guide.md, api.md, performance.md
      expect(files.every((f) => f.includes('docs'))).toBe(true);
    });

    it('should return relative paths when absolute=false', () => {
      createTestStructure();

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
      createTestStructure();

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*.md', '**/*.ts'],
      });

      expect(files.length).toBe(6); // 4 .md files + 2 .ts files
      expect(files.some((f) => f.endsWith('.md'))).toBe(true);
      expect(files.some((f) => f.endsWith('.ts'))).toBe(true);
    });

    it('should handle empty directory', () => {
      const emptyDir = path.join(testDir, 'empty');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is controlled temp directory
      mkdirSync(emptyDir);

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
      const filePath = path.join(testDir, 'file.txt');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is controlled temp directory
      writeFileSync(filePath, 'content');

      expect(() =>
        crawlDirectorySync({
          baseDir: filePath,
        })
      ).toThrow('Base path is not a directory');
    });

    it('should include directories when filesOnly=false', () => {
      createTestStructure();

      const results = crawlDirectorySync({
        baseDir: testDir,
        include: ['docs/**'],
        filesOnly: false,
      });

      // Should include docs/ directory and its files
      expect(results.some((r) => r.endsWith('docs'))).toBe(true);
    });

    it('should handle nested exclude patterns', () => {
      createTestStructure();

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
      createTestStructure();

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/g*.md'], // guide.md
      });

      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/guide\.md$/);
    });

    describe('symlink handling', () => {
      it('should skip symlinks by default', () => {
        createTestStructure();

        // Create a symlink to a markdown file
        const targetFile = path.join(testDir, 'docs', 'guide.md');
        const symlinkPath = path.join(testDir, 'link.md');

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
        createTestStructure();

        const targetFile = path.join(testDir, 'docs', 'guide.md');
        const symlinkPath = path.join(testDir, 'link.md');

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
      createTestStructure();

      const files = await crawlDirectory({
        baseDir: testDir,
        include: ['**/*.md'],
      });

      expect(files.length).toBe(4);
      expect(files.every((f) => f.endsWith('.md'))).toBe(true);
    });

    it('should return same results as sync version', async () => {
      createTestStructure();

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
      createTestStructure();

      // Test that pattern matching works regardless of platform separator
      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['docs/**/*.md'], // Always forward slashes in patterns
      });

      expect(files.length).toBe(3);
      expect(files.every((f) => f.includes('docs'))).toBe(true);
    });

    it('should return consistent absolute paths', () => {
      createTestStructure();

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*.md'],
        absolute: true,
      });

      expect(files.every((f) => path.isAbsolute(f))).toBe(true);
      expect(files.every((f) => f.startsWith(testDir))).toBe(true);
    });
  });
});
