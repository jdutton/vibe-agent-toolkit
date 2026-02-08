/**
 * Tests for path resolver
 */

import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  resolveMarkdownPath,
  createDefaultCompilerOptions,
} from '../../src/transformer/path-resolver.js';

const FIXTURES_DIR = join(import.meta.dirname, '../transformer-fixtures');
const SAMPLE_FILE = join(FIXTURES_DIR, 'namespace-import.ts');

describe('resolveMarkdownPath', () => {
  const compilerOptions = createDefaultCompilerOptions();

  describe('relative paths', () => {
    it('should resolve relative .md paths', () => {
      const result = resolveMarkdownPath('./sample.md', SAMPLE_FILE, compilerOptions);

      expect(result).toBeDefined();
      expect(result).toContain('sample.md');
    });

    it('should resolve parent directory paths', () => {
      const nestedFile = join(FIXTURES_DIR, 'nested', 'file.ts');
      const result = resolveMarkdownPath('../sample.md', nestedFile, compilerOptions);

      expect(result).toBeDefined();
      expect(result).toContain('sample.md');
    });

    it('should return null for non-existent files', () => {
      const result = resolveMarkdownPath('./nonexistent.md', SAMPLE_FILE, compilerOptions);

      expect(result).toBeNull();
    });

    it('should handle multiple parent directory traversals', () => {
      const deepFile = join(FIXTURES_DIR, 'a', 'b', 'c', 'file.ts');
      const result = resolveMarkdownPath('../../../sample.md', deepFile, compilerOptions);

      expect(result).toBeDefined();
      expect(result).toContain('sample.md');
    });
  });

  describe('absolute paths', () => {
    it('should handle absolute paths that exist', () => {
      const absolutePath = join(FIXTURES_DIR, 'sample.md');
      const result = resolveMarkdownPath(absolutePath, SAMPLE_FILE, compilerOptions);

      expect(result).toBe(absolutePath);
    });

    it('should return null for non-existent absolute paths', () => {
      // Use a path in fixtures dir to avoid publicly-writable /tmp warning
      const absolutePath = join(FIXTURES_DIR, 'nonexistent-12345.md');
      const result = resolveMarkdownPath(absolutePath, SAMPLE_FILE, compilerOptions);

      expect(result).toBeNull();
    });
  });

  describe('node_modules paths', () => {
    it('should attempt to resolve node_modules paths', () => {
      // This will likely return null in tests, but should not throw
      const result = resolveMarkdownPath(
        '@vibe-agent-toolkit/prompts/core.md',
        SAMPLE_FILE,
        compilerOptions,
      );

      // Could be null if package isn't installed
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });
});

describe('createDefaultCompilerOptions', () => {
  it('should create valid compiler options', () => {
    const options = createDefaultCompilerOptions();

    expect(options).toBeDefined();
    expect(options.moduleResolution).toBeDefined();
    expect(options.target).toBeDefined();
    expect(options.module).toBeDefined();
  });

  it('should enable ESM interop', () => {
    const options = createDefaultCompilerOptions();

    expect(options.esModuleInterop).toBe(true);
    expect(options.allowSyntheticDefaultImports).toBe(true);
  });

  it('should enable JSON module resolution', () => {
    const options = createDefaultCompilerOptions();

    expect(options.resolveJsonModule).toBe(true);
  });
});
