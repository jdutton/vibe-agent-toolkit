import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getRelativePath, isAbsolutePath, normalizePath, toAbsolutePath, toForwardSlash } from '../src/path-utils.js';

describe('path-utils', () => {
  const TEST_PROJECT_PATH = '/project';
  const TEST_DOCS_README = './docs/README.md';
  const TEST_DOCS_PATH = './docs';

  describe('normalizePath', () => {
    it('should normalize a simple relative path', () => {
      const result = normalizePath(TEST_DOCS_README);
      expect(result).toBe(path.normalize(TEST_DOCS_README));
    });

    it('should resolve relative path with baseDir', () => {
      const result = normalizePath(TEST_DOCS_README, TEST_PROJECT_PATH);
      expect(result).toBe(path.resolve(TEST_PROJECT_PATH, TEST_DOCS_README));
    });

    it('should resolve parent directory references', () => {
      const result = normalizePath('./docs/../README.md', TEST_PROJECT_PATH);
      expect(result).toBe(path.resolve(TEST_PROJECT_PATH, 'README.md'));
    });

    it('should remove trailing slashes', () => {
      const result = normalizePath(`${TEST_PROJECT_PATH}/docs/`, '/base');
      expect(result).not.toMatch(/[/\\]$/);
    });

    it('should handle absolute paths without baseDir', () => {
      const absolutePath = path.resolve(`${TEST_PROJECT_PATH}/docs/README.md`);
      const result = normalizePath(absolutePath);
      expect(result).toBe(absolutePath);
    });

    it('should normalize mixed separators on Windows', () => {
      // This test behavior depends on platform but should always return consistent separators
      const result = normalizePath(String.raw`${TEST_DOCS_PATH}\README.md`);
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });
  });

  describe('isAbsolutePath', () => {
    it('should return true for Unix absolute paths', () => {
      expect(isAbsolutePath('/path/to/file')).toBe(true);
      expect(isAbsolutePath('/etc/hosts')).toBe(true);
    });

    it('should return false for Unix relative paths', () => {
      expect(isAbsolutePath('./relative')).toBe(false);
      expect(isAbsolutePath('../parent')).toBe(false);
      expect(isAbsolutePath('relative/path')).toBe(false);
    });

    it('should handle empty string', () => {
      expect(isAbsolutePath('')).toBe(false);
    });

    if (process.platform === 'win32') {
      it('should return true for Windows absolute paths', () => {
        expect(isAbsolutePath(String.raw`C:\Windows`)).toBe(true);
        expect(isAbsolutePath('C:/Windows')).toBe(true);
        expect(isAbsolutePath(String.raw`D:\Program Files`)).toBe(true);
      });

      it('should return false for Windows relative paths', () => {
        expect(isAbsolutePath(String.raw`.\relative`)).toBe(false);
        expect(isAbsolutePath(String.raw`..\parent`)).toBe(false);
      });
    }
  });

  describe('toAbsolutePath', () => {
    it('should convert relative path to absolute', () => {
      const result = toAbsolutePath(TEST_DOCS_README, TEST_PROJECT_PATH);
      expect(result).toBe(path.resolve(TEST_PROJECT_PATH, TEST_DOCS_README));
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('should return normalized absolute path when input is already absolute', () => {
      const absolutePath = '/absolute/path/file.md';
      const result = toAbsolutePath(absolutePath, TEST_PROJECT_PATH);
      expect(result).toBe(path.normalize(absolutePath));
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('should resolve parent directory references', () => {
      const result = toAbsolutePath('../README.md', `${TEST_PROJECT_PATH}/docs`);
      expect(result).toBe(path.resolve(`${TEST_PROJECT_PATH}/docs`, '../README.md'));
    });

    it('should handle current directory reference', () => {
      const result = toAbsolutePath('./file.md', TEST_PROJECT_PATH);
      expect(result).toBe(path.resolve(TEST_PROJECT_PATH, './file.md'));
    });

    it('should resolve deep relative paths', () => {
      const result = toAbsolutePath('../../root/file.md', `${TEST_PROJECT_PATH}/a/b`);
      expect(result).toBe(path.resolve(`${TEST_PROJECT_PATH}/a/b`, '../../root/file.md'));
    });
  });

  describe('getRelativePath', () => {
    it('should get relative path from source to target in same directory', () => {
      const result = getRelativePath(`${TEST_PROJECT_PATH}/docs/guide.md`, `${TEST_PROJECT_PATH}/docs/api.md`);
      expect(result).toBe('api.md');
    });

    it('should get relative path to parent directory', () => {
      const result = getRelativePath(`${TEST_PROJECT_PATH}/docs/guide.md`, `${TEST_PROJECT_PATH}/README.md`);
      expect(result).toBe(path.join('..', 'README.md'));
    });

    it('should get relative path to subdirectory', () => {
      const result = getRelativePath(`${TEST_PROJECT_PATH}/README.md`, `${TEST_PROJECT_PATH}/docs/api.md`);
      expect(result).toBe(path.join('docs', 'api.md'));
    });

    it('should get relative path across directories', () => {
      const result = getRelativePath(`${TEST_PROJECT_PATH}/docs/guide.md`, `${TEST_PROJECT_PATH}/examples/demo.md`);
      expect(result).toBe(path.join('..', 'examples', 'demo.md'));
    });

    it('should handle deep nesting', () => {
      const result = getRelativePath(
        '/project/a/b/c/file.md',
        '/project/x/y/z/target.md'
      );
      // Should go up 3 levels (c, b, a) then down (x, y, z)
      expect(result).toBe(path.join('..', '..', '..', 'x', 'y', 'z', 'target.md'));
    });

    it('should return file name when paths are in same directory', () => {
      const result = getRelativePath('/project/file1.md', '/project/file2.md');
      expect(result).toBe('file2.md');
    });

    it('should handle paths with different depths', () => {
      const result = getRelativePath('/a/b/c.md', '/x.md');
      // From /a/b/ to /x.md is ../../x.md
      expect(result).toBe(path.join('..', '..', 'x.md'));
    });

    // Cross-platform test
    it('should always return forward slashes or platform-specific separators', () => {
      const result = getRelativePath('/project/docs/guide.md', '/project/README.md');
      // Result should be a valid relative path on current platform
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });
  });

  describe('toForwardSlash', () => {
    it('should convert Windows backslashes to forward slashes', () => {
      const result = toForwardSlash(String.raw`C:\Users\docs\README.md`);
      expect(result).toBe('C:/Users/docs/README.md');
    });

    it('should leave forward slashes unchanged', () => {
      const result = toForwardSlash('/project/docs/README.md');
      expect(result).toBe('/project/docs/README.md');
    });

    it('should handle mixed separators', () => {
      const result = toForwardSlash(String.raw`C:\Users/docs\README.md`);
      expect(result).toBe('C:/Users/docs/README.md');
    });

    it('should handle paths with multiple consecutive backslashes', () => {
      const result = toForwardSlash(String.raw`C:\\Users\\docs\\README.md`);
      expect(result).toBe('C://Users//docs//README.md');
    });

    it('should handle empty string', () => {
      const result = toForwardSlash('');
      expect(result).toBe('');
    });

    it('should handle UNC paths on Windows', () => {
      const result = toForwardSlash(String.raw`\\server\share\file.md`);
      expect(result).toBe('//server/share/file.md');
    });
  });

  describe('cross-platform behavior', () => {
    it('should handle paths consistently across platforms', () => {
      const normalized = normalizePath('./docs/README.md', '/base');
      expect(path.isAbsolute(normalized)).toBe(true);

      const absolute = toAbsolutePath('./file.md', normalized);
      expect(path.isAbsolute(absolute)).toBe(true);

      const relative = getRelativePath(normalized, absolute);
      expect(relative).toBeTruthy();
    });

    it('should produce consistent results for same inputs', () => {
      const path1 = toAbsolutePath('./docs/../README.md', '/project');
      const path2 = toAbsolutePath('./README.md', '/project');
      expect(path1).toBe(path2);
    });
  });
});
