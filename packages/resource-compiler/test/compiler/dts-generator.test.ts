/**
 * Tests for TypeScript declaration generator
 */

import { describe, it, expect } from 'vitest';

import { generateTypeScriptDeclarations } from '../../src/compiler/dts-generator.js';
import { parseMarkdown } from '../../src/compiler/markdown-parser.js';
import type { MarkdownResource } from '../../src/compiler/types.js';

// Constants for commonly used test strings
const READONLY_PREFIX = 'readonly ';
const CONTENT_TEXT = 'Content';
const EXPORT_TYPE_FRAGMENT_NAME = 'export type FragmentName = keyof typeof fragments;';
const READONLY_TAGS_STRING_ARRAY = `${READONLY_PREFIX}tags: readonly string[];`;
const READONLY_METADATA = `${READONLY_PREFIX}metadata:`;
const EXPORT_CONST_TEXT_STRING = 'export const text: string;';
const EXPORT_CONST_META = 'export const meta:';
const EXPORT_CONST_FRAGMENTS = 'export const fragments:';
const READONLY_VERSION_NUMBER = `${READONLY_PREFIX}version: number;`;
const READONLY_TITLE_STRING = `${READONLY_PREFIX}title: string;`;
const EXPORT_CONST_META_EMPTY = 'export const meta: {};';

/**
 * Helper to create a test fragment
 */
function createTestFragment(heading: string, slug: string, camelCase: string): {
  heading: string;
  slug: string;
  camelCase: string;
  header: string;
  body: string;
  text: string;
} {
  const header = `## ${heading}`;
  return {
    heading,
    slug,
    camelCase,
    header,
    body: CONTENT_TEXT,
    text: `${header}\n\n${CONTENT_TEXT}`,
  };
}

/**
 * Helper to create a resource with two test fragments (First and Second)
 */
function createTwoFragmentResource(): MarkdownResource {
  return {
    frontmatter: {},
    content: '',
    fragments: [
      createTestFragment('First', 'first', 'first'),
      createTestFragment('Second', 'second', 'second'),
    ],
  };
}

describe('generateTypeScriptDeclarations', () => {
  describe('basic generation', () => {
    it('should generate declarations for empty resource', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('export interface Fragment');
      expect(result).toContain(EXPORT_CONST_META_EMPTY);
      expect(result).toContain(EXPORT_CONST_TEXT_STRING);
      expect(result).toContain('export const fragments: {};');
      expect(result).toContain('export type FragmentName = never;');
    });

    it('should generate Fragment interface', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('export interface Fragment {');
      expect(result).toContain(`${READONLY_PREFIX}header: string;`);
      expect(result).toContain(`${READONLY_PREFIX}body: string;`);
      expect(result).toContain(`${READONLY_PREFIX}text: string;`);
    });

    it('should generate declarations with fragments', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: '',
        fragments: [
          {
            heading: 'Section One',
            slug: 'section-one',
            camelCase: 'sectionOne',
            header: '## Section One',
            body: CONTENT_TEXT,
            text: '## Section One\n\nContent',
          },
        ],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain(`${READONLY_PREFIX}sectionOne: Fragment;`);
      expect(result).toContain(EXPORT_TYPE_FRAGMENT_NAME);
    });

    it('should generate declarations with multiple fragments', () => {
      const resource = createTwoFragmentResource();
      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain(`${READONLY_PREFIX}first: Fragment;`);
      expect(result).toContain(`${READONLY_PREFIX}second: Fragment;`);
    });
  });

  describe('type inference from frontmatter', () => {
    it('should infer string types', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          title: 'Test Title',
          author: 'Test Author',
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain(`${READONLY_PREFIX}title: string;`);
      expect(result).toContain(`${READONLY_PREFIX}author: string;`);
    });

    it('should infer number types', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          version: 1,
          count: 42,
          decimal: 3.14,
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain(`${READONLY_PREFIX}version: number;`);
      expect(result).toContain(`${READONLY_PREFIX}count: number;`);
      expect(result).toContain(`${READONLY_PREFIX}decimal: number;`);
    });

    it('should infer boolean types', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          published: true,
          draft: false,
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain(`${READONLY_PREFIX}published: boolean;`);
      expect(result).toContain(`${READONLY_PREFIX}draft: boolean;`);
    });

    it('should infer array types', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          tags: ['test', 'example'],
          numbers: [1, 2, 3],
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain(READONLY_TAGS_STRING_ARRAY);
      expect(result).toContain('readonly numbers: readonly number[];');
    });

    it('should infer types for empty arrays', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          emptyArray: [],
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('readonly emptyArray: readonly unknown[];');
    });

    it('should infer nested object types', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          metadata: {
            author: 'Test Author',
            version: 1,
            published: true,
          },
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain(READONLY_METADATA);
      expect(result).toContain('readonly author: string;');
      expect(result).toContain(READONLY_VERSION_NUMBER);
      expect(result).toContain('readonly published: boolean;');
    });

    it('should handle null and undefined', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          nullable: null,
          undefinedField: undefined,
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('readonly nullable: undefined;');
      expect(result).toContain('readonly undefinedField: undefined;');
    });

    it('should infer types for complex nested structures', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          config: {
            settings: {
              enabled: true,
              timeout: 5000,
            },
            features: ['feature1', 'feature2'],
          },
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('readonly config:');
      expect(result).toContain('readonly settings:');
      expect(result).toContain('readonly enabled: boolean;');
      expect(result).toContain('readonly timeout: number;');
      expect(result).toContain('readonly features: readonly string[];');
    });
  });

  describe('fragment types', () => {
    it('should generate specific fragment property names', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: '',
        fragments: [
          {
            heading: 'Purpose Driven',
            slug: 'purpose-driven',
            camelCase: 'purposeDriven',
            header: '## Purpose Driven',
            body: CONTENT_TEXT,
            text: '## Purpose Driven\n\nContent',
          },
          {
            heading: 'API v2.0',
            slug: 'api-v20',
            camelCase: 'apiV20',
            header: '## API v2.0',
            body: CONTENT_TEXT,
            text: '## API v2.0\n\nContent',
          },
        ],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('readonly purposeDriven: Fragment;');
      expect(result).toContain('readonly apiV20: Fragment;');
    });

    it('should generate FragmentName union type', () => {
      const resource = createTwoFragmentResource();
      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain(EXPORT_TYPE_FRAGMENT_NAME);
    });

    it('should use never type for FragmentName when no fragments', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('export type FragmentName = never;');
    });
  });

  describe('integration with parseMarkdown', () => {
    it('should generate valid declarations from parsed markdown', () => {
      const markdown = `---
title: Integration Test
version: 1
tags:
  - test
  - integration
published: true
---

# Document Title

## Section One

Content for section one.

## Section Two

More content here.
`;

      const resource = parseMarkdown(markdown);
      const result = generateTypeScriptDeclarations(resource);

      // Should have proper structure
      expect(result).toContain('export interface Fragment');
      expect(result).toContain(EXPORT_CONST_META);
      expect(result).toContain(EXPORT_CONST_TEXT_STRING);
      expect(result).toContain(EXPORT_CONST_FRAGMENTS);

      // Should have inferred types
      expect(result).toContain(READONLY_TITLE_STRING);
      expect(result).toContain(READONLY_VERSION_NUMBER);
      expect(result).toContain(READONLY_TAGS_STRING_ARRAY);
      expect(result).toContain('readonly published: boolean;');

      // Should have fragment names
      expect(result).toContain(`${READONLY_PREFIX}sectionOne: Fragment;`);
      expect(result).toContain('readonly sectionTwo: Fragment;');
      expect(result).toContain(EXPORT_TYPE_FRAGMENT_NAME);
    });

    it('should generate declarations for markdown without frontmatter', () => {
      const markdown = `# Simple Document

## Introduction

Basic content.

## Conclusion

Final thoughts.`;

      const resource = parseMarkdown(markdown);
      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain(EXPORT_CONST_META_EMPTY);
      expect(result).toContain('readonly introduction: Fragment;');
      expect(result).toContain('readonly conclusion: Fragment;');
    });
  });

  describe('edge cases', () => {
    it('should handle empty frontmatter', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: 'Content',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain(EXPORT_CONST_META_EMPTY);
    });

    it('should handle many fragments', () => {
      const fragments = Array.from({ length: 20 }, (_, i) => ({
        heading: `Section ${i}`,
        slug: `section-${i}`,
        camelCase: `section${i}`,
        header: `## Section ${i}`,
        body: 'Content',
        text: `## Section ${i}\n\nContent`,
      }));

      const resource: MarkdownResource = {
        frontmatter: {},
        content: '',
        fragments,
      };

      const result = generateTypeScriptDeclarations(resource);

      for (let i = 0; i < 20; i++) {
        expect(result).toContain(`readonly section${i}: Fragment;`);
      }
    });

    it('should handle fragment names with numbers', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: '',
        fragments: [
          {
            heading: 'Version 2.0',
            slug: 'version-20',
            camelCase: 'version20',
            header: '## Version 2.0',
            body: CONTENT_TEXT,
            text: '## Version 2.0\n\nContent',
          },
        ],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('readonly version20: Fragment;');
    });

    it('should handle complex frontmatter with mixed types', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          title: 'Test',
          version: 1,
          active: true,
          tags: ['tag1', 'tag2'],
          metadata: {
            author: 'Author',
            date: '2024-01-01',
          },
          emptyArray: [],
          nullable: null,
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain(READONLY_TITLE_STRING);
      expect(result).toContain(READONLY_VERSION_NUMBER);
      expect(result).toContain('readonly active: boolean;');
      expect(result).toContain(READONLY_TAGS_STRING_ARRAY);
      expect(result).toContain(READONLY_METADATA);
      expect(result).toContain('readonly emptyArray: readonly unknown[];');
      expect(result).toContain('readonly nullable: undefined;');
    });
  });

  describe('generated code structure', () => {
    it('should include DO NOT EDIT comment', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('DO NOT EDIT');
    });

    it('should export all required types and constants', () => {
      const resource: MarkdownResource = {
        frontmatter: { title: 'Test' },
        content: 'Content',
        fragments: [
          {
            heading: 'Section',
            slug: 'section',
            camelCase: 'section',
            header: '## Section',
            body: CONTENT_TEXT,
            text: '## Section\n\nContent',
          },
        ],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toMatch(/export interface Fragment/);
      expect(result).toMatch(/export const meta:/);
      expect(result).toMatch(/export const text: string;/);
      expect(result).toMatch(/export const fragments:/);
      expect(result).toMatch(/export type FragmentName =/);
    });

    it('should use readonly modifiers consistently', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          title: 'Test',
          tags: ['tag1'],
        },
        content: '',
        fragments: [
          {
            heading: 'Section',
            slug: 'section',
            camelCase: 'section',
            header: '## Section',
            body: CONTENT_TEXT,
            text: '## Section\n\nContent',
          },
        ],
      };

      const result = generateTypeScriptDeclarations(resource);

      // Fragment interface properties should be readonly
      expect(result).toContain(`${READONLY_PREFIX}header: string;`);
      expect(result).toContain(`${READONLY_PREFIX}body: string;`);
      expect(result).toContain(`${READONLY_PREFIX}text: string;`);

      // Meta properties should be readonly
      expect(result).toContain(READONLY_TITLE_STRING);
      expect(result).toContain(READONLY_TAGS_STRING_ARRAY);

      // Fragment properties should be readonly
      expect(result).toContain('readonly section: Fragment;');
    });

    it('should maintain proper indentation', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          nested: {
            level1: {
              level2: 'value',
            },
          },
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      // Should have proper nesting structure (basic check)
      expect(result).toContain('readonly nested:');
      expect(result).toContain('readonly level1:');
      expect(result).toContain('readonly level2: string;');
    });
  });

  describe('type accuracy', () => {
    it('should correctly identify string arrays', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          stringArray: ['one', 'two', 'three'],
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('readonly stringArray: readonly string[];');
    });

    it('should correctly identify number arrays', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          numberArray: [1, 2, 3],
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('readonly numberArray: readonly number[];');
    });

    it('should correctly identify boolean arrays', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          booleanArray: [true, false, true],
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('readonly booleanArray: readonly boolean[];');
    });

    it('should handle arrays with first element determining type', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          inferredFromFirst: ['string', 123, true], // Should infer string[]
        },
        content: '',
        fragments: [],
      };

      const result = generateTypeScriptDeclarations(resource);

      expect(result).toContain('readonly inferredFromFirst: readonly string[];');
    });
  });
});
