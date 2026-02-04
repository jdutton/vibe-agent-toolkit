/**
 * Unit tests for declaration-generator
 */

import { describe, it, expect } from 'vitest';

import type { MarkdownResource } from '../../src/compiler/types.js';
import { generateMarkdownDeclarationFile, getDeclarationPath } from '../../src/transformer/declaration-generator.js';

// Test constants
const TEST_FILE_PATH = '/path/to/file.md';
const EXPORT_FRAGMENTS = 'export const fragments:';

/**
 * Helper to create a basic resource for testing
 */
function createBasicResource(
  frontmatter: Record<string, unknown> = {},
  fragments: MarkdownResource['fragments'] = [],
): MarkdownResource {
  return {
    frontmatter,
    content: 'Test content',
    fragments,
  };
}

describe('generateMarkdownDeclarationFile', () => {
  describe('basic declaration generation', () => {
    it('should generate declaration for simple resource', () => {
      const resource = createBasicResource(
        { title: 'Test' },
        [
          {
            heading: 'Section One',
            slug: 'section-one',
            camelCase: 'sectionOne',
            header: '## Section One',
            body: 'Content',
            text: '## Section One\n\nContent',
          },
        ],
      );

      const declaration = generateMarkdownDeclarationFile(TEST_FILE_PATH, resource);

      expect(declaration).toContain('export interface Fragment');
      expect(declaration).toContain('readonly header: string;');
      expect(declaration).toContain('readonly body: string;');
      expect(declaration).toContain('readonly text: string;');
      expect(declaration).toContain('export const meta:');
      expect(declaration).toContain('export const text: string;');
      expect(declaration).toContain(EXPORT_FRAGMENTS);
      expect(declaration).toContain('readonly sectionOne: Fragment;');
      expect(declaration).toContain('export type FragmentName = keyof typeof fragments;');
    });

    it('should handle resource with no frontmatter', () => {
      const resource = createBasicResource();

      const declaration = generateMarkdownDeclarationFile(TEST_FILE_PATH, resource);

      expect(declaration).toContain('export const meta: {}');
      expect(declaration).toContain('export const fragments: {}');
      expect(declaration).toContain('export type FragmentName = never;');
    });

    it('should handle resource with no fragments', () => {
      const resource = createBasicResource({ title: 'Test' });

      const declaration = generateMarkdownDeclarationFile(TEST_FILE_PATH, resource);

      expect(declaration).toContain('export const fragments: {}');
      expect(declaration).toContain('export type FragmentName = never;');
    });
  });

  describe('frontmatter type inference', () => {
    it('should infer string types', () => {
      const resource: MarkdownResource = {
        frontmatter: { title: 'Test', description: 'A test document' },
        content: 'Content',
        fragments: [],
      };

      const declaration = generateMarkdownDeclarationFile(TEST_FILE_PATH, resource);

      expect(declaration).toContain('readonly title: string;');
      expect(declaration).toContain('readonly description: string;');
    });

    it('should infer number types', () => {
      const resource: MarkdownResource = {
        frontmatter: { version: 1, count: 42 },
        content: 'Content',
        fragments: [],
      };

      const declaration = generateMarkdownDeclarationFile(TEST_FILE_PATH, resource);

      expect(declaration).toContain('readonly version: number;');
      expect(declaration).toContain('readonly count: number;');
    });

    it('should infer boolean types', () => {
      const resource: MarkdownResource = {
        frontmatter: { enabled: true, draft: false },
        content: 'Content',
        fragments: [],
      };

      const declaration = generateMarkdownDeclarationFile(TEST_FILE_PATH, resource);

      expect(declaration).toContain('readonly enabled: boolean;');
      expect(declaration).toContain('readonly draft: boolean;');
    });

    it('should infer array types', () => {
      const resource: MarkdownResource = {
        frontmatter: { tags: ['one', 'two'], numbers: [1, 2, 3] },
        content: 'Content',
        fragments: [],
      };

      const declaration = generateMarkdownDeclarationFile(TEST_FILE_PATH, resource);

      expect(declaration).toContain('readonly tags: readonly string[];');
      expect(declaration).toContain('readonly numbers: readonly number[];');
    });
  });

  describe('multiple fragments', () => {
    it('should generate declarations for multiple fragments', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: 'Content',
        fragments: [
          {
            heading: 'Introduction',
            slug: 'introduction',
            camelCase: 'introduction',
            header: '## Introduction',
            body: 'Intro content',
            text: '## Introduction\n\nIntro content',
          },
          {
            heading: 'Conclusion',
            slug: 'conclusion',
            camelCase: 'conclusion',
            header: '## Conclusion',
            body: 'Conclusion content',
            text: '## Conclusion\n\nConclusion content',
          },
        ],
      };

      const declaration = generateMarkdownDeclarationFile(TEST_FILE_PATH, resource);

      expect(declaration).toContain('readonly introduction: Fragment;');
      expect(declaration).toContain('readonly conclusion: Fragment;');
      expect(declaration).toContain('export type FragmentName = keyof typeof fragments;');
    });

    it('should handle fragments with special characters in names', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: 'Content',
        fragments: [
          {
            heading: 'Purpose Driven',
            slug: 'purpose-driven',
            camelCase: 'purposeDriven',
            header: '## Purpose Driven',
            body: 'Content',
            text: '## Purpose Driven\n\nContent',
          },
        ],
      };

      const declaration = generateMarkdownDeclarationFile(TEST_FILE_PATH, resource);

      expect(declaration).toContain('readonly purposeDriven: Fragment;');
    });
  });

  describe('path independence', () => {
    it('should generate same output regardless of input path format', () => {
      const resource = createBasicResource();

      const declaration1 = generateMarkdownDeclarationFile('/path/to/nested/file.md', resource);
      const declaration2 = generateMarkdownDeclarationFile(String.raw`C:\path\to\file.md`, resource);

      // Both should generate identical declarations (path is not used in output)
      expect(declaration1).toBe(declaration2);
    });
  });

  describe('declaration format', () => {
    it('should include header comment', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: 'Content',
        fragments: [],
      };

      const declaration = generateMarkdownDeclarationFile(TEST_FILE_PATH, resource);

      expect(declaration).toContain('/**');
      expect(declaration).toContain('* Generated TypeScript declarations - DO NOT EDIT');
      expect(declaration).toContain('*/');
    });

    it('should generate standard TypeScript module exports', () => {
      const resource: MarkdownResource = {
        frontmatter: { title: 'Test' },
        content: 'Content',
        fragments: [
          {
            heading: 'Section',
            slug: 'section',
            camelCase: 'section',
            header: '## Section',
            body: 'Content',
            text: '## Section\n\nContent',
          },
        ],
      };

      const declaration = generateMarkdownDeclarationFile(TEST_FILE_PATH, resource);
      const lines = declaration.split('\n');

      // Should have export lines without extra indentation
      const exportLines = lines.filter((line) => line.trim().startsWith('export'));
      expect(exportLines.length).toBeGreaterThan(0);

      // Export lines should not have extra indentation (not wrapped in declare module)
      for (const line of exportLines) {
        expect(line).toMatch(/^export /);
      }
    });

    it('should end with newline', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: 'Content',
        fragments: [],
      };

      const declaration = generateMarkdownDeclarationFile(TEST_FILE_PATH, resource);

      expect(declaration).toMatch(/\n$/);
    });
  });
});

describe('getDeclarationPath', () => {
  it('should append .d.ts to markdown file path', () => {
    expect(getDeclarationPath(TEST_FILE_PATH)).toBe(`${TEST_FILE_PATH}.d.ts`);
  });

  it('should work with nested paths', () => {
    expect(getDeclarationPath('/path/to/nested/dir/file.md')).toBe(
      '/path/to/nested/dir/file.md.d.ts',
    );
  });

  it('should work with Windows paths', () => {
    expect(getDeclarationPath(String.raw`C:\path\to\file.md`)).toBe(String.raw`C:\path\to\file.md.d.ts`);
  });

  it('should work with relative paths', () => {
    expect(getDeclarationPath('./relative/path/file.md')).toBe('./relative/path/file.md.d.ts');
  });
});
