/**
 * Tests for markdown cache with mtime-based invalidation
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test file with controlled inputs */

import { writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { MarkdownResource } from '../../src/compiler/types.js';
import {
  getMarkdownResource,
  clearCache,
  invalidateFile,
  getCacheStats,
} from '../../src/language-service/markdown-cache.js';

// Test fixture constant
const TEST_MD_CONTENT = '## Fragment\nContent';

// Test loader factory
function createTestLoader(fragments: string): () => MarkdownResource {
  return () => ({
    frontmatter: {},
    content: fragments,
    fragments: [
      {
        heading: 'Fragment',
        slug: 'fragment',
        camelCase: 'fragment',
        header: '## Fragment',
        body: 'Content',
        text: fragments,
      },
    ],
  });
}

// Helper to create a loader that counts calls
function createCountingLoader(baseLoader: () => MarkdownResource): {
  loader: () => MarkdownResource;
  getCallCount: () => number;
} {
  let calls = 0;
  return {
    loader: () => {
      calls++;
      return baseLoader();
    },
    getCallCount: () => calls,
  };
}

// Helper to setup multiple test files
function setupTestFiles(
  dir: string,
  fileNames: string[],
): { files: string[]; cleanup: () => void } {
  const files = fileNames.map((name) => join(dir, name));
  for (const file of files) {
    writeFileSync(file, TEST_MD_CONTENT);
  }
  return {
    files,
    cleanup: () => {
      for (const file of files) {
        try {
          unlinkSync(file);
        } catch {
          // Ignore errors
        }
      }
    },
  };
}

// Helper to setup two test files and load them into cache
function setupTwoFilesInCache(
  dir: string,
): { file1: string; file2: string; cleanup: () => void } {
  const { files, cleanup } = setupTestFiles(dir, ['file1.md', 'file2.md']);
  const file1 = files[0];
  const file2 = files[1];

  if (!file1 || !file2) {
    throw new Error('Expected 2 files');
  }

  const loader = createTestLoader(TEST_MD_CONTENT);

  // Load both resources into cache
  getMarkdownResource(file1, loader);
  getMarkdownResource(file2, loader);

  return { file1, file2, cleanup };
}

describe('markdown-cache', () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    // Create temp directory for test files
    testDir = join(normalizedTmpdir(), `markdown-cache-test-${Date.now()}`);
    mkdirSyncReal(testDir, { recursive: true });
    testFile = join(testDir, 'test.md');

    // Clear cache before each test
    clearCache();
  });

  afterEach(() => {
    // Clean up test files
    try {
      unlinkSync(testFile);
    } catch {
      // Ignore errors if file doesn't exist
    }
  });

  describe('getMarkdownResource', () => {
    it('should load resource using loader on first call', () => {
      writeFileSync(testFile, TEST_MD_CONTENT);

      let loaderCalls = 0;
      const loader = createTestLoader(TEST_MD_CONTENT);
      const wrappedLoader = () => {
        loaderCalls++;
        return loader();
      };

      const resource = getMarkdownResource(testFile, wrappedLoader);

      expect(loaderCalls).toBe(1);
      expect(resource.fragments).toHaveLength(1);
      expect(resource.fragments[0]?.heading).toBe('Fragment');
    });

    it('should return cached resource on subsequent calls', () => {
      writeFileSync(testFile, TEST_MD_CONTENT);

      const { loader, getCallCount } = createCountingLoader(createTestLoader(TEST_MD_CONTENT));

      // First call
      getMarkdownResource(testFile, loader);
      expect(getCallCount()).toBe(1);

      // Second call - should use cache
      getMarkdownResource(testFile, loader);
      expect(getCallCount()).toBe(1);

      // Third call - should still use cache
      getMarkdownResource(testFile, loader);
      expect(getCallCount()).toBe(1);
    });

    it('should invalidate cache when file is modified', async () => {
      writeFileSync(testFile, TEST_MD_CONTENT);

      const { loader, getCallCount } = createCountingLoader(createTestLoader(TEST_MD_CONTENT));

      // First call
      getMarkdownResource(testFile, loader);
      expect(getCallCount()).toBe(1);

      // Wait a bit and modify file
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      const newTime = Date.now() / 1000;
      utimesSync(testFile, newTime, newTime);

      // Second call - should reload due to mtime change
      getMarkdownResource(testFile, loader);
      expect(getCallCount()).toBe(2);
    });

    it('should handle non-existent files gracefully', () => {
      const nonExistentFile = join(testDir, 'does-not-exist.md');

      const emptyLoader = (): MarkdownResource => ({
        frontmatter: {},
        content: '',
        fragments: [],
      });

      let loaderCalls = 0;
      const wrappedLoader = () => {
        loaderCalls++;
        return emptyLoader();
      };

      // First call - file doesn't exist
      getMarkdownResource(nonExistentFile, wrappedLoader);
      expect(loaderCalls).toBe(1);

      // Second call - should use cached version (mtime is consistently 0 for non-existent files)
      // This is correct behavior - the cache key is still valid
      getMarkdownResource(nonExistentFile, wrappedLoader);
      expect(loaderCalls).toBe(1);
    });
  });

  describe('clearCache', () => {
    it('should remove all entries from cache', () => {
      writeFileSync(testFile, TEST_MD_CONTENT);

      const loader = createTestLoader(TEST_MD_CONTENT);

      // Load a resource
      getMarkdownResource(testFile, loader);

      // Cache should have one entry
      let stats = getCacheStats();
      expect(stats.size).toBe(1);

      // Clear cache
      clearCache();

      // Cache should be empty
      stats = getCacheStats();
      expect(stats.size).toBe(0);
    });
  });

  describe('invalidateFile', () => {
    it('should remove specific file from cache', () => {
      const { file1, file2, cleanup } = setupTwoFilesInCache(testDir);

      // Cache should have two entries
      let stats = getCacheStats();
      expect(stats.size).toBe(2);

      // Invalidate file1
      invalidateFile(file1);

      // Cache should have one entry
      stats = getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.files).toContain(file2);
      expect(stats.files).not.toContain(file1);

      // Clean up
      cleanup();
    });

    it('should not throw when invalidating non-existent file', () => {
      const nonExistentFile = join(testDir, 'does-not-exist.md');

      expect(() => {
        invalidateFile(nonExistentFile);
      }).not.toThrow();
    });
  });

  describe('getCacheStats', () => {
    it('should return empty stats for empty cache', () => {
      const stats = getCacheStats();

      expect(stats.size).toBe(0);
      expect(stats.files).toEqual([]);
    });

    it('should return correct stats for populated cache', () => {
      const { file1, file2, cleanup } = setupTwoFilesInCache(testDir);

      const stats = getCacheStats();

      expect(stats.size).toBe(2);
      expect(stats.files).toHaveLength(2);
      expect(stats.files).toContain(file1);
      expect(stats.files).toContain(file2);

      // Clean up
      cleanup();
    });
  });
});
