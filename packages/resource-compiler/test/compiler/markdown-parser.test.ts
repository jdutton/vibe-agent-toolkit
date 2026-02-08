/**
 * Tests for markdown parser
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { parseMarkdown } from '../../src/compiler/markdown-parser.js';
import type { MarkdownFragment } from '../../src/compiler/types.js';

const FIXTURES_DIR = '../fixtures';
const SIMPLE_MARKDOWN = '# Simple Document';
const TEST_CONTENT = 'Content';

// Fixture filenames
const FIXTURE_WITH_FRONTMATTER = 'with-frontmatter.md';
const FIXTURE_EDGE_CASES = 'edge-cases.md';

/**
 * Helper to load fixture file content
 */
function loadFixture(filename: string): string {
  const fixturePath = join(import.meta.dirname, FIXTURES_DIR, filename);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test helper with controlled input
  return readFileSync(fixturePath, 'utf-8');
}

describe('parseMarkdown', () => {
  describe('frontmatter parsing', () => {
    it('should parse markdown without frontmatter', () => {
      const content = loadFixture('simple.md');
      const result = parseMarkdown(content);

      expect(result.frontmatter).toEqual({});
      expect(result.content).toContain(SIMPLE_MARKDOWN);
      expect(result.fragments.length).toBeGreaterThan(0);
    });

    it('should parse markdown with YAML frontmatter', () => {
      const content = loadFixture(FIXTURE_WITH_FRONTMATTER);
      const result = parseMarkdown(content);

      expect(result.frontmatter).toEqual({
        title: 'Document with Frontmatter',
        author: 'Test Author',
        version: 1,
        tags: ['test', 'example', 'markdown'],
      });
      expect(result.content).toContain('# Document Title');
      expect(result.content).not.toContain('---');
    });

    it('should handle complex frontmatter structures', () => {
      const content = `---
title: Complex
nested:
  key: value
  array: [1, 2, 3]
boolean: true
---
# ${TEST_CONTENT}`;

      const result = parseMarkdown(content);

      expect(result.frontmatter).toEqual({
        title: 'Complex',
        nested: {
          key: 'value',
          array: [1, 2, 3],
        },
        boolean: true,
      });
    });

    it('should handle empty frontmatter', () => {
      const content = `---
---
# ${TEST_CONTENT}

## Section`;

      const result = parseMarkdown(content);

      expect(result.frontmatter).toEqual({});
      expect(result.content).toContain(`# ${TEST_CONTENT}`);
    });
  });

  describe('H2 fragment extraction', () => {
    it('should extract multiple H2 fragments', () => {
      const content = loadFixture('simple.md');
      const result = parseMarkdown(content);

      expect(result.fragments).toHaveLength(3);

      expect(result.fragments[0]?.heading).toBe('Introduction');
      expect(result.fragments[1]?.heading).toBe('Getting Started');
      expect(result.fragments[2]?.heading).toBe('Conclusion');
    });

    it('should extract fragment with correct structure', () => {
      const content = `## Test Section

This is the body content.
Multiple lines supported.`;

      const result = parseMarkdown(content);

      expect(result.fragments).toHaveLength(1);

      const fragment = result.fragments[0] as MarkdownFragment;
      expect(fragment.heading).toBe('Test Section');
      expect(fragment.slug).toBe('test-section');
      expect(fragment.camelCase).toBe('testSection');
      expect(fragment.header).toBe('## Test Section');
      expect(fragment.body).toBe('This is the body content.\nMultiple lines supported.');
      expect(fragment.text).toContain('## Test Section');
      expect(fragment.text).toContain('This is the body content.');
    });

    it('should handle markdown without H2 fragments', () => {
      const content = `# Main Title

Just some content without H2 headings.

### H3 heading should be ignored`;

      const result = parseMarkdown(content);

      expect(result.fragments).toHaveLength(0);
    });

    it('should extract fragments from markdown with frontmatter', () => {
      const content = loadFixture(FIXTURE_WITH_FRONTMATTER);
      const result = parseMarkdown(content);

      expect(result.fragments).toHaveLength(2);
      expect(result.fragments[0]?.heading).toBe('Overview');
      expect(result.fragments[1]?.heading).toBe('Details');
    });

    it('should separate fragments correctly', () => {
      const content = `## First

Content of first section.

## Second

Content of second section.`;

      const result = parseMarkdown(content);

      expect(result.fragments).toHaveLength(2);

      const first = result.fragments[0] as MarkdownFragment;
      expect(first.body).toBe('Content of first section.');
      expect(first.body).not.toContain('## Second');

      const second = result.fragments[1] as MarkdownFragment;
      expect(second.body).toBe('Content of second section.');
      expect(second.body).not.toContain('## First');
    });
  });

  describe('slug generation', () => {
    it('should generate kebab-case slugs from headings', () => {
      const content = loadFixture('multiple-fragments.md');
      const result = parseMarkdown(content);

      const slugs = result.fragments.map((f) => f.slug);

      expect(slugs).toContain('purpose-driven');
      expect(slugs).toContain('api-v20'); // slugify removes dots with strict mode
      expect(slugs).toContain('hello-world');
    });

    it('should handle special characters in slugs', () => {
      const content = `## Hello, World!

${TEST_CONTENT}`;

      const result = parseMarkdown(content);

      expect(result.fragments[0]?.slug).toBe('hello-world');
    });

    it('should handle numbers in slugs', () => {
      const content = `## Numbers 123 and Symbols !!!

${TEST_CONTENT}`;

      const result = parseMarkdown(content);

      expect(result.fragments[0]?.slug).toBe('numbers-123-and-symbols');
    });

    it('should handle multiple spaces in slugs', () => {
      const content = `## Spaces  Everywhere

${TEST_CONTENT}`;

      const result = parseMarkdown(content);

      expect(result.fragments[0]?.slug).toBe('spaces-everywhere');
    });

    it('should handle leading and trailing whitespace', () => {
      const content = `##   Trimmed Heading

${TEST_CONTENT}`;

      const result = parseMarkdown(content);

      expect(result.fragments[0]?.heading).toBe('Trimmed Heading');
      expect(result.fragments[0]?.slug).toBe('trimmed-heading');
    });
  });

  describe('camelCase generation', () => {
    it('should generate camelCase property names', () => {
      const content = loadFixture('multiple-fragments.md');
      const result = parseMarkdown(content);

      const camelCaseNames = result.fragments.map((f) => f.camelCase);

      expect(camelCaseNames).toContain('purposeDriven');
      expect(camelCaseNames).toContain('apiV20');
      expect(camelCaseNames).toContain('helloWorld');
    });

    it('should handle single word headings', () => {
      const content = `## Introduction

${TEST_CONTENT}`;

      const result = parseMarkdown(content);

      expect(result.fragments[0]?.camelCase).toBe('introduction');
    });

    it('should handle multiple hyphens', () => {
      const content = `## One Two Three Four

${TEST_CONTENT}`;

      const result = parseMarkdown(content);

      expect(result.fragments[0]?.camelCase).toBe('oneTwoThreeFour');
    });

    it('should handle numbers in camelCase', () => {
      const content = `## API v2 0

${TEST_CONTENT}`;

      const result = parseMarkdown(content);

      expect(result.fragments[0]?.camelCase).toBe('apiV20');
    });
  });

  describe('edge cases', () => {
    it('should handle empty sections', () => {
      const content = loadFixture(FIXTURE_EDGE_CASES);
      const result = parseMarkdown(content);

      const emptySection = result.fragments.find((f) => f.heading === 'Empty Section');
      expect(emptySection).toBeDefined();
      expect(emptySection?.body).toBe('');
    });

    it('should handle sections with only whitespace', () => {
      const content = loadFixture(FIXTURE_EDGE_CASES);
      const result = parseMarkdown(content);

      const whitespaceSection = result.fragments.find(
        (f) => f.heading === 'Section With Only Whitespace',
      );
      expect(whitespaceSection).toBeDefined();
      expect(whitespaceSection?.body).toBe('');
    });

    it('should not treat ## in content as headings', () => {
      const content = loadFixture(FIXTURE_EDGE_CASES);
      const result = parseMarkdown(content);

      const section = result.fragments.find((f) => f.heading === 'Section With ## In Content');
      expect(section).toBeDefined();
      expect(section?.body).toContain('This section has ## in the middle');
      expect(section?.body).toContain('The ## here should not be parsed');

      // Should not create extra fragments for ## in content
      const allHeadings = result.fragments.map((f) => f.heading);
      expect(allHeadings).not.toContain('here should not be parsed as a heading');
    });

    it('should handle consecutive H2 headings', () => {
      const content = `## First

## Second

${TEST_CONTENT}`;

      const result = parseMarkdown(content);

      expect(result.fragments).toHaveLength(2);
      expect(result.fragments[0]?.heading).toBe('First');
      expect(result.fragments[0]?.body).toBe('');
      expect(result.fragments[1]?.heading).toBe('Second');
      expect(result.fragments[1]?.body).toBe(TEST_CONTENT);
    });

    it('should handle H2 at end of file', () => {
      const content = `## First Section

${TEST_CONTENT}

## Last Section`;

      const result = parseMarkdown(content);

      expect(result.fragments).toHaveLength(2);
      expect(result.fragments[1]?.heading).toBe('Last Section');
      expect(result.fragments[1]?.body).toBe('');
    });

    it('should handle empty content', () => {
      const content = '';
      const result = parseMarkdown(content);

      expect(result.frontmatter).toEqual({});
      expect(result.content).toBe('');
      expect(result.fragments).toHaveLength(0);
    });

    it('should preserve markdown formatting in body', () => {
      const content = `## Formatted Section

This has **bold** and *italic* text.

- List item 1
- List item 2

\`\`\`typescript
const code = true;
\`\`\`

[Link](https://example.com)`;

      const result = parseMarkdown(content);

      const section = result.fragments[0] as MarkdownFragment;
      expect(section.body).toContain('**bold**');
      expect(section.body).toContain('*italic*');
      expect(section.body).toContain('- List item 1');
      expect(section.body).toContain('```typescript');
      expect(section.body).toContain('[Link](https://example.com)');
    });

    it('should handle very long headings', () => {
      const longHeading = 'A'.repeat(200);
      const content = `## ${longHeading}

Content`;

      const result = parseMarkdown(content);

      expect(result.fragments).toHaveLength(1);
      expect(result.fragments[0]?.heading).toBe(longHeading);
      expect(result.fragments[0]?.slug).toBe(longHeading.toLowerCase());
    });
  });

  describe('complete resource structure', () => {
    it('should return valid MarkdownResource structure', () => {
      const content = loadFixture(FIXTURE_WITH_FRONTMATTER);
      const result = parseMarkdown(content);

      // Check structure matches interface
      expect(result).toHaveProperty('frontmatter');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('fragments');

      expect(typeof result.frontmatter).toBe('object');
      expect(typeof result.content).toBe('string');
      expect(Array.isArray(result.fragments)).toBe(true);
    });

    it('should return valid MarkdownFragment structure', () => {
      const content = `## Test

Body`;
      const result = parseMarkdown(content);
      const fragment = result.fragments[0] as MarkdownFragment;

      // Check structure matches interface
      expect(fragment).toHaveProperty('heading');
      expect(fragment).toHaveProperty('slug');
      expect(fragment).toHaveProperty('camelCase');
      expect(fragment).toHaveProperty('header');
      expect(fragment).toHaveProperty('body');
      expect(fragment).toHaveProperty('text');

      expect(typeof fragment.heading).toBe('string');
      expect(typeof fragment.slug).toBe('string');
      expect(typeof fragment.camelCase).toBe('string');
      expect(typeof fragment.header).toBe('string');
      expect(typeof fragment.body).toBe('string');
      expect(typeof fragment.text).toBe('string');
    });
  });
});
