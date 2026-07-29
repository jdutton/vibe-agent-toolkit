import { spawnSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { crawlDirectory, crawlDirectorySync } from '../../src/file-crawler.js';
import { mkdirSyncReal, toForwardSlash } from '../../src/path-utils.js';
import { setupSyncTempDirSuite } from '../../src/test-helpers.js';
import { createGitRepo } from '../test-helpers.js';

const GITIGNORE = '.gitignore';
const CLAUDE_RULE = '/.claude/rules/house-style.md';
const GITHUB_DOC = '/.github/CONTRIBUTING.md';

/**
 * Create tracked markdown inside two dot-directories — the shape picomatch's
 * `dot: false` default cannot see through.
 */
function createDotDirStructure(dir: string): void {
  /* eslint-disable security/detect-non-literal-fs-filename -- dir is a controlled temp directory */
  mkdirSyncReal(safePath.join(dir, '.claude', 'rules'), { recursive: true });
  writeFileSync(safePath.join(dir, CLAUDE_RULE.slice(1)), '# Rules');
  mkdirSyncReal(safePath.join(dir, '.github'));
  writeFileSync(safePath.join(dir, GITHUB_DOC.slice(1)), '# Contributing');
  /* eslint-enable security/detect-non-literal-fs-filename */
}

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
      const gitignorePath = safePath.join(testDir, GITIGNORE);
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
      const gitignorePath = safePath.join(testDir, GITIGNORE);
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

    // `respectGitignore: false` answers two questions at once — "include
    // files git does not track" and "include files git is told to ignore" —
    // and it answers them by abandoning `git ls-files` for a full recursive
    // walk. Callers that only wanted the first (a skill the author has not
    // committed yet) paid the second, which on a large monorepo means
    // descending every build cache, worktree and generated tree: measured at
    // 39.6 s versus 16 ms for the same 1,146 files. `includeUntracked` asks
    // git the narrower question and keeps the fast path.
    it('includes untracked-but-not-ignored files while still honouring .gitignore', () => {
      createTestStructure(testDir);
      createGitRepo(testDir);

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is controlled temp directory
      writeFileSync(safePath.join(testDir, GITIGNORE), 'docs/\n');
      // Only src/ is committed: README.md and package.json stay untracked,
      // docs/ is ignored outright.
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
      spawnSync('git', ['add', 'src/'], { cwd: testDir, stdio: 'pipe' });

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*'],
        includeUntracked: true,
      }).map(toForwardSlash);

      expect(files.some((f) => f.endsWith('/src/index.ts'))).toBe(true);
      expect(files.some((f) => f.endsWith('/README.md'))).toBe(true);
      expect(files.some((f) => f.endsWith('/package.json'))).toBe(true);
      // Ignored, and excluded-by-default, trees stay out.
      expect(files.every((f) => !f.includes('/docs/'))).toBe(true);
      expect(files.every((f) => !f.includes('/node_modules/'))).toBe(true);
    });
  });

  // `**/*` and `**/*.md` are the include patterns every VAT lane defaults to,
  // and picomatch's `dot: false` default makes `**` refuse to traverse a
  // segment beginning with a dot. So the crawler was structurally unable to
  // see `.claude/` — Claude's own home for the rules, skills, commands and
  // agents VAT exists to validate. An adopter who dropped their `include`
  // allowlist specifically to widen the scan still had 68 tracked files under
  // `.claude/` silently uncrawled, one of them holding a real frontmatter
  // defect. Every other picomatch call site in VAT already compiles with
  // `dot: true`; this one was the outlier.
  describe('dot-directory visibility', () => {
    // Both crawl paths are asserted in one test on purpose: they are two
    // answers to one question, and the bug is only interesting if BOTH give
    // the same one. (Splitting them also produced two 9-line clones the
    // duplication gate rejects.)
    it('finds markdown under a dot-directory on the walk path and the git fast path', () => {
      createTestStructure(testDir);
      createDotDirStructure(testDir);

      const crawl = (): string[] =>
        crawlDirectorySync({ baseDir: testDir, include: ['**/*.md'] }).map(toForwardSlash);

      // No git repo yet — the manual recursive walk answers.
      const walked = crawl();
      expect(walked.some((f) => f.endsWith(CLAUDE_RULE))).toBe(true);
      expect(walked.some((f) => f.endsWith(GITHUB_DOC))).toBe(true);
      // The ordinary tree is unaffected.
      expect(walked.some((f) => f.endsWith('/docs/guide.md'))).toBe(true);

      // Same tree, now tracked — `git ls-files` answers instead.
      createGitRepo(testDir);
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
      spawnSync('git', ['add', '-A'], { cwd: testDir, stdio: 'pipe' });

      const tracked = crawl();
      expect(tracked.some((f) => f.endsWith(CLAUDE_RULE))).toBe(true);
      expect(tracked.some((f) => f.endsWith(GITHUB_DOC))).toBe(true);
    });

    // The exclude side must see dot segments too, or a caller can widen the
    // scan and then be unable to narrow it again.
    it('honours an exclude pattern aimed at a dot-directory', () => {
      createTestStructure(testDir);
      createDotDirStructure(testDir);

      const files = crawlDirectorySync({
        baseDir: testDir,
        include: ['**/*.md'],
        exclude: ['**/.github/**'],
      }).map(toForwardSlash);

      expect(files.some((f) => f.endsWith(CLAUDE_RULE))).toBe(true);
      expect(files.every((f) => !f.includes('/.github/'))).toBe(true);
    });
  });
});
