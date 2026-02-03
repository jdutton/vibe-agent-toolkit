/**
 * Unit tests for resource path utilities
 * Tests path normalization, validation, and absolutePath computation
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getResourceAbsolutePath,
  isValidProjectPath,
  normalizeProjectPath,
} from '../src/types/resource-path-utils.ts';

// Shared test constants
const DOCS_GUIDE_MD = 'docs/guide.md';
const DOCS_FILE_MD = 'file://docs/guide.md';
const FILE_THREE_SLASHES = 'file:///docs/guide.md';
const DOCS_PARENT_GUIDE = 'docs/../guide.md';
const ABSOLUTE_DOCS_GUIDE = '/docs/guide.md';

describe('normalizeProjectPath', () => {

  describe('when input is already normalized', () => {
    it('should preserve relative path with forward slashes', () => {
      expect(normalizeProjectPath(DOCS_GUIDE_MD)).toBe(DOCS_GUIDE_MD);
    });

    it('should preserve path without leading slash', () => {
      expect(normalizeProjectPath('src/index.ts')).toBe('src/index.ts');
    });

    it('should preserve single file in root', () => {
      expect(normalizeProjectPath('README.md')).toBe('README.md');
    });
  });

  describe('when input has backslashes (Windows)', () => {
    it('should convert backslashes to forward slashes', () => {
      expect(normalizeProjectPath(String.raw`docs\guide.md`)).toBe(DOCS_GUIDE_MD);
    });

    it('should handle mixed slashes', () => {
      expect(normalizeProjectPath(String.raw`docs\sub/folder\file.md`)).toBe('docs/sub/folder/file.md');
    });

    it('should convert multiple backslashes', () => {
      expect(normalizeProjectPath(String.raw`a\b\c\d.txt`)).toBe('a/b/c/d.txt');
    });
  });

  describe('when input has leading slash', () => {
    it('should remove single leading slash', () => {
      expect(normalizeProjectPath('/docs/guide.md')).toBe(DOCS_GUIDE_MD);
    });

    it('should remove leading slash on Windows-style path', () => {
      expect(normalizeProjectPath(String.raw`\docs\guide.md`)).toBe(DOCS_GUIDE_MD);
    });
  });

  describe('when input has URL-style paths', () => {
    it('should handle file:// protocol', () => {
      expect(normalizeProjectPath(DOCS_FILE_MD)).toBe(DOCS_GUIDE_MD);
    });

    it('should handle file:/// protocol', () => {
      expect(normalizeProjectPath(FILE_THREE_SLASHES)).toBe(DOCS_GUIDE_MD);
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      expect(normalizeProjectPath('')).toBe('');
    });

    it('should handle single filename', () => {
      expect(normalizeProjectPath('file.txt')).toBe('file.txt');
    });

    it('should handle path with dots', () => {
      expect(normalizeProjectPath(DOCS_PARENT_GUIDE)).toBe(DOCS_PARENT_GUIDE);
    });

    it('should preserve trailing slash', () => {
      expect(normalizeProjectPath('docs/')).toBe('docs/');
    });
  });
});

describe('isValidProjectPath', () => {
  describe('valid paths', () => {
    it('should accept relative path with forward slashes', () => {
      expect(isValidProjectPath(DOCS_GUIDE_MD)).toBe(true);
    });

    it('should accept single filename', () => {
      expect(isValidProjectPath('README.md')).toBe(true);
    });

    it('should accept nested path', () => {
      expect(isValidProjectPath('a/b/c/d.txt')).toBe(true);
    });

    it('should accept path with special characters', () => {
      expect(isValidProjectPath('docs/my-guide_v2.md')).toBe(true);
    });
  });

  describe('invalid paths - absolute', () => {
    it('should reject path with leading slash', () => {
      expect(isValidProjectPath(ABSOLUTE_DOCS_GUIDE)).toBe(false);
    });

    it('should reject path with double leading slash', () => {
      expect(isValidProjectPath(`/${ABSOLUTE_DOCS_GUIDE}`)).toBe(false);
    });

    it('should reject Windows absolute path (C:)', () => {
      expect(isValidProjectPath(`C:${ABSOLUTE_DOCS_GUIDE}`)).toBe(false);
    });

    it('should reject Windows absolute path (D:)', () => {
      expect(isValidProjectPath(String.raw`D:\docs\guide.md`)).toBe(false);
    });
  });

  describe('invalid paths - URLs', () => {
    it('should reject http:// URL', () => {
      expect(isValidProjectPath('http://example.com/file.md')).toBe(false);
    });

    it('should reject https:// URL', () => {
      expect(isValidProjectPath('https://example.com/file.md')).toBe(false);
    });

    it('should reject file:// URL', () => {
      expect(isValidProjectPath(DOCS_FILE_MD)).toBe(false);
    });

    it('should reject file:/// URL', () => {
      expect(isValidProjectPath(FILE_THREE_SLASHES)).toBe(false);
    });
  });

  describe('invalid paths - directory escaping', () => {
    it('should reject ../ at start', () => {
      expect(isValidProjectPath('../outside/file.md')).toBe(false);
    });

    it('should reject multiple ../ climbing up', () => {
      expect(isValidProjectPath('../../outside/file.md')).toBe(false);
    });

    it('should accept ../ that stays within project', () => {
      expect(isValidProjectPath(DOCS_PARENT_GUIDE)).toBe(true);
    });

    it('should reject path that escapes via multiple segments', () => {
      expect(isValidProjectPath('a/b/../../../outside.md')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should reject empty string', () => {
      expect(isValidProjectPath('')).toBe(false);
    });

    it('should accept path with trailing slash', () => {
      expect(isValidProjectPath('docs/')).toBe(true);
    });

    it('should reject backslashes (must normalize first)', () => {
      expect(isValidProjectPath(String.raw`docs\guide.md`)).toBe(false);
    });
  });
});

describe('getResourceAbsolutePath', () => {
  it('should compute absolute path from project root and relative path', () => {
    const projectRoot = '/Users/test/project';
    const result = getResourceAbsolutePath(projectRoot, DOCS_GUIDE_MD);
    expect(result).toBe(join(projectRoot, DOCS_GUIDE_MD));
  });

  it('should handle Windows-style project root', () => {
    const projectRoot = String.raw`C:\Users\test\project`;
    const result = getResourceAbsolutePath(projectRoot, DOCS_GUIDE_MD);
    expect(result).toBe(join(projectRoot, DOCS_GUIDE_MD));
  });

  it('should handle nested paths', () => {
    const projectRoot = '/project';
    const projectPath = 'a/b/c/file.txt';
    const result = getResourceAbsolutePath(projectRoot, projectPath);
    expect(result).toBe(join(projectRoot, projectPath));
  });

  it('should handle root-level file', () => {
    const projectRoot = '/project';
    const projectPath = 'README.md';
    const result = getResourceAbsolutePath(projectRoot, projectPath);
    expect(result).toBe(join(projectRoot, projectPath));
  });
});
