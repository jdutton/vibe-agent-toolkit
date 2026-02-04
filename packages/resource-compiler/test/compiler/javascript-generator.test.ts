/**
 * Tests for JavaScript code generator
 */

import { describe, it, expect } from 'vitest';

import { generateJavaScript } from '../../src/compiler/javascript-generator.js';
import { parseMarkdown } from '../../src/compiler/markdown-parser.js';
import type { MarkdownResource } from '../../src/compiler/types.js';

// Constants for commonly used test strings
const EXPORT_CONST_META = 'export const meta =';
const EXPORT_CONST_FRAGMENTS = 'export const fragments =';
const EXPORT_CONST_TEXT = 'export const text =';
const VERSION_1 = 'version: 1';

describe('generateJavaScript', () => {
  describe('basic generation', () => {
    it('should generate valid JavaScript for empty resource', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: '',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('export const meta = {};');
      expect(result).toContain('export const text = "";');
      expect(result).toContain('export const fragments = {};');
    });

    it('should generate JavaScript with frontmatter', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          title: 'Test Document',
          version: 1,
          tags: ['test', 'example'],
        },
        content: '# Test',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain(EXPORT_CONST_META);
      expect(result).toContain('title: "Test Document"');
      expect(result).toContain(VERSION_1);
      expect(result).toContain('tags:');
      expect(result).toContain('"test"');
      expect(result).toContain('"example"');
    });

    it('should generate JavaScript with fragments', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: '## Section\n\nContent here',
        fragments: [
          {
            heading: 'Section',
            slug: 'section',
            camelCase: 'section',
            header: '## Section',
            body: 'Content here',
            text: '## Section\n\nContent here',
          },
        ],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain(EXPORT_CONST_FRAGMENTS);
      expect(result).toContain('section:');
      expect(result).toContain('header: "## Section"');
      expect(result).toContain('body: "Content here"');
      expect(result).toContain('text: "## Section');
    });

    it('should generate JavaScript with multiple fragments', () => {
      const resource: MarkdownResource = {
        frontmatter: { title: 'Multi-section' },
        content: '## First\n\nFirst content\n\n## Second\n\nSecond content',
        fragments: [
          {
            heading: 'First',
            slug: 'first',
            camelCase: 'first',
            header: '## First',
            body: 'First content',
            text: '## First\n\nFirst content',
          },
          {
            heading: 'Second',
            slug: 'second',
            camelCase: 'second',
            header: '## Second',
            body: 'Second content',
            text: '## Second\n\nSecond content',
          },
        ],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('first:');
      expect(result).toContain('second:');
      expect(result).toContain('"First content"');
      expect(result).toContain('"Second content"');
    });
  });

  describe('string escaping', () => {
    /* eslint-disable unicorn/prefer-string-raw -- Testing string escaping behavior */
    it('should escape double quotes', () => {
      const resource: MarkdownResource = {
        frontmatter: { title: 'Title with "quotes"' },
        content: 'Content with "quotes"',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('Title with \\"quotes\\"');
      expect(result).toContain('Content with \\"quotes\\"');
      expect(result).not.toContain('Title with "quotes"');
    });

    it('should escape single quotes', () => {
      const resource: MarkdownResource = {
        frontmatter: { title: "It's working" },
        content: "Content with 'single quotes'",
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain("It\\'s working");
      expect(result).toContain("Content with \\'single quotes\\'");
    });

    it('should escape newlines', () => {
      const resource: MarkdownResource = {
        frontmatter: { description: 'Line 1\nLine 2' },
        content: 'First paragraph\n\nSecond paragraph',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('Line 1\\nLine 2');
      expect(result).toContain('First paragraph\\n\\nSecond paragraph');
      expect(result).not.toContain('Line 1\nLine 2');
    });

    it('should escape backslashes', () => {
      const resource: MarkdownResource = {
        frontmatter: { path: 'C:\\Users\\test' },
        content: 'Path: C:\\path\\to\\file',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('C:\\\\Users\\\\test');
      expect(result).toContain('C:\\\\path\\\\to\\\\file');
    });

    it('should escape tabs', () => {
      const resource: MarkdownResource = {
        frontmatter: { indented: 'Tab\there' },
        content: 'Content\twith\ttabs',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('Tab\\there');
      expect(result).toContain('Content\\twith\\ttabs');
    });

    it('should escape backticks', () => {
      const resource: MarkdownResource = {
        frontmatter: { code: '`const x = 1`' },
        content: 'Inline code: `value`',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('\\`const x = 1\\`');
      expect(result).toContain('Inline code: \\`value\\`');
    });

    it('should handle multiple special characters', () => {
      const resource: MarkdownResource = {
        frontmatter: { complex: 'It\'s "complex"\nWith\\backslashes\tand\ttabs' },
        content: '',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain(`It\\'s \\"complex\\"\\nWith\\\\backslashes\\tand\\ttabs`);
    });
    /* eslint-enable unicorn/prefer-string-raw */
  });

  describe('type handling', () => {
    it('should handle boolean values', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          published: true,
          draft: false,
        },
        content: '',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('published: true');
      expect(result).toContain('draft: false');
    });

    it('should handle number values', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          version: 1,
          count: 42,
          decimal: 3.14,
        },
        content: '',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain(VERSION_1);
      expect(result).toContain('count: 42');
      expect(result).toContain('decimal: 3.14');
    });

    it('should handle null values', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          nullable: null,
        },
        content: '',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('nullable: null');
    });

    it('should handle array values', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          tags: ['one', 'two', 'three'],
          numbers: [1, 2, 3],
          mixed: ['string', 42, true],
        },
        content: '',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('tags:');
      expect(result).toContain('"one"');
      expect(result).toContain('"two"');
      expect(result).toContain('"three"');
      expect(result).toContain('numbers:');
      expect(result).toContain('mixed:');
    });

    it('should handle nested objects', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          metadata: {
            author: 'Test Author',
            version: 1,
            settings: {
              enabled: true,
            },
          },
        },
        content: '',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('metadata:');
      expect(result).toContain('author: "Test Author"');
      expect(result).toContain(VERSION_1);
      expect(result).toContain('settings:');
      expect(result).toContain('enabled: true');
    });

    it('should handle empty arrays', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          emptyArray: [],
        },
        content: '',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('emptyArray: []');
    });

    it('should handle empty objects', () => {
      const resource: MarkdownResource = {
        frontmatter: {
          emptyObject: {},
        },
        content: '',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('emptyObject: {}');
    });
  });

  describe('integration with parseMarkdown', () => {
    it('should generate valid JavaScript from parsed markdown', () => {
      const markdown = `---
title: Integration Test
tags:
  - test
  - integration
---

# Document Title

## Section One

Content for section one with "quotes" and special chars.

## Section Two

More content here.
`;

      const resource = parseMarkdown(markdown);
      const result = generateJavaScript(resource);

      // Should be valid JavaScript structure
      expect(result).toContain(EXPORT_CONST_META);
      expect(result).toContain(EXPORT_CONST_TEXT);
      expect(result).toContain(EXPORT_CONST_FRAGMENTS);

      // Should contain parsed data
      expect(result).toContain('title: "Integration Test"');
      expect(result).toContain('sectionOne:');
      expect(result).toContain('sectionTwo:');
      // eslint-disable-next-line unicorn/prefer-string-raw -- Testing string escaping
      expect(result).toContain('Content for section one with \\"quotes\\"');
    });

    it('should generate valid JavaScript for markdown without frontmatter', () => {
      const markdown = `# Simple Document

## Introduction

Basic content.`;

      const resource = parseMarkdown(markdown);
      const result = generateJavaScript(resource);

      expect(result).toContain('export const meta = {};');
      expect(result).toContain('introduction:');
      expect(result).toContain('"Basic content."');
    });
  });

  describe('edge cases', () => {
    it('should handle very long strings', () => {
      const longString = 'A'.repeat(10000);
      const resource: MarkdownResource = {
        frontmatter: { longField: longString },
        content: longString,
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain(longString);
      expect(result).toContain(EXPORT_CONST_META);
    });

    it('should handle unicode characters', () => {
      const resource: MarkdownResource = {
        frontmatter: { emoji: '🎉 Unicode: 你好 مرحبا' },
        content: 'Content with emojis 🚀 and unicode ñ ü',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('🎉 Unicode: 你好 مرحبا');
      expect(result).toContain('🚀');
      expect(result).toContain('ñ');
      expect(result).toContain('ü');
    });

    it('should handle markdown code blocks in content', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: '```typescript\nconst x = "test";\n```',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('\\' + '`\\' + '`\\' + '`typescript');
      // eslint-disable-next-line unicorn/prefer-string-raw -- Testing string escaping
      expect(result).toContain(`const x = \\"test\\";`);
    });

    it('should preserve markdown formatting in fragments', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: '',
        fragments: [
          {
            heading: 'Formatted',
            slug: 'formatted',
            camelCase: 'formatted',
            header: '## Formatted',
            body: '**bold** *italic* [link](url)',
            text: '## Formatted\n\n**bold** *italic* [link](url)',
          },
        ],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('**bold**');
      expect(result).toContain('*italic*');
      expect(result).toContain('[link](url)');
    });
  });

  describe('generated code structure', () => {
    it('should include DO NOT EDIT comment', () => {
      const resource: MarkdownResource = {
        frontmatter: {},
        content: '',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toContain('DO NOT EDIT');
    });

    it('should export all required constants', () => {
      const resource: MarkdownResource = {
        frontmatter: { title: 'Test' },
        content: 'Content',
        fragments: [],
      };

      const result = generateJavaScript(resource);

      expect(result).toMatch(/export const meta =/);
      expect(result).toMatch(/export const text =/);
      expect(result).toMatch(/export const fragments =/);
    });

    it('should use consistent formatting', () => {
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

      const result = generateJavaScript(resource);

      // Should have proper indentation
      expect(result).toContain('  nested:');
      expect(result).toContain('    level1:');
      expect(result).toContain('      level2:');
    });
  });
});
