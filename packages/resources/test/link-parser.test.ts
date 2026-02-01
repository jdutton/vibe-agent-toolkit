
/**
 * Tests for link-parser.ts
 *
 * Covers:
 * - Link extraction (regular, reference-style, autolinks)
 * - Link classification (external, email, anchor, local_file, unknown)
 * - Heading extraction with tree structure
 * - GitHub-style slug generation
 * - Edge cases (empty files, no links, no headings)
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests use non-null assertions for expected values */
/* eslint-disable security/detect-non-literal-fs-filename -- tests use dynamic file paths in temp directory */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseMarkdown } from '../src/link-parser.js';

import { expectHeadingStructure, findPackageRoot, writeAndParse } from './test-helpers.js';

describe('link-parser', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create temp directory for test files
    tempDir = await mkdtemp(join(normalizedTmpdir(), 'link-parser-test-'));
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('parseMarkdown', () => {
    it('should parse a simple markdown file with links and headings', async () => {
      const content = `# Main Heading

[Link to file](./file.md)
[Link to anchor](#main-heading)

## Subheading

Content here.
`;
      const filePath = join(tempDir, 'test.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.content).toBe(content);
      expect(result.sizeBytes).toBe(Buffer.byteLength(content));
      expect(result.estimatedTokenCount).toBe(Math.ceil(content.length / 4));
      expect(result.links).toHaveLength(2);
      expect(result.headings).toHaveLength(1); // Only top-level heading
    });

    it('should handle empty files', async () => {
      const content = '';
      const filePath = join(tempDir, 'empty.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.content).toBe('');
      expect(result.sizeBytes).toBe(0);
      expect(result.estimatedTokenCount).toBe(0);
      expect(result.links).toEqual([]);
      expect(result.headings).toEqual([]);
    });

    it('should handle files with no links', async () => {
      const content = `# Heading

Just plain text content.
`;
      const filePath = join(tempDir, 'no-links.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links).toEqual([]);
      expect(result.headings).toHaveLength(1);
      expect(result.headings[0]!.text).toBe('Heading');
    });

    it('should handle files with no headings', async () => {
      const content = `[Link](./file.md)
[Another link](https://example.com)
`;
      const filePath = join(tempDir, 'no-headings.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.headings).toEqual([]);
      expect(result.links).toHaveLength(2);
    });

    it('should throw error for non-existent files', async () => {
      const filePath = join(tempDir, 'non-existent.md');

      await expect(parseMarkdown(filePath)).rejects.toThrow();
    });
  });

  describe('link extraction', () => {
    it('should extract regular links', async () => {
      const content = `[Regular link](https://example.com)
[Another link](./file.md)
`;
      const filePath = join(tempDir, 'regular-links.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links).toHaveLength(2);
      expect(result.links[0]).toMatchObject({
        text: 'Regular link',
        href: 'https://example.com',
        type: 'external',
        line: 1,
      });
      expect(result.links[1]).toMatchObject({
        text: 'Another link',
        href: './file.md',
        type: 'local_file',
        line: 2,
      });
    });

    it('should extract autolinks', async () => {
      const content = `<https://example.com>
<mailto:test@example.com>
`;
      const filePath = join(tempDir, 'autolinks.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links).toHaveLength(2);
      expect(result.links[0]).toMatchObject({
        href: 'https://example.com',
        type: 'external',
      });
      expect(result.links[1]).toMatchObject({
        href: 'mailto:test@example.com',
        type: 'email',
      });
    });

    it('should extract reference-style links', async () => {
      const content = `[Reference link][ref1]

[ref1]: https://example.com
`;
      const filePath = join(tempDir, 'reference-links.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      // Reference-style links are classified as 'unknown' since we don't resolve definitions
      expect(result.links).toHaveLength(1);
      expect(result.links[0]).toMatchObject({
        text: 'Reference link',
        href: 'ref1',
        type: 'unknown',
        line: 1,
      });
    });

    it('should extract mixed link types', async () => {
      const content = `[Regular](./file.md)
<https://example.com>
[Reference][ref]
[Anchor](#heading)

[ref]: https://example.com
`;
      const filePath = join(tempDir, 'mixed-links.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links.length).toBeGreaterThanOrEqual(3);
      const types = result.links.map((link) => link.type);
      expect(types).toContain('local_file');
      expect(types).toContain('external');
      expect(types).toContain('anchor');
    });

    it('should capture line numbers for links', async () => {
      const content = `Line 1

[Link on line 3](./file.md)

[Link on line 5](https://example.com)
`;
      const filePath = join(tempDir, 'link-lines.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links[0]!.line).toBe(3);
      expect(result.links[1]!.line).toBe(5);
    });
  });

  describe('link classification', () => {
    it('should classify external URLs', async () => {
      const content = `[HTTP](http://example.com)
[HTTPS](https://example.com)
`;
      const filePath = join(tempDir, 'external.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links[0]!.type).toBe('external');
      expect(result.links[1]!.type).toBe('external');
    });

    it('should classify email links', async () => {
      const content = `[Email](mailto:test@example.com)`;
      const filePath = join(tempDir, 'email.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links[0]!.type).toBe('email');
    });

    it('should classify anchor links', async () => {
      const content = `[Anchor](#heading)`;
      const filePath = join(tempDir, 'anchor.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links[0]!.type).toBe('anchor');
    });

    it('should classify local file links', async () => {
      const content = `[Relative](./file.md)
[Parent](../file.md)
[Absolute](/path/to/file.md)
[No extension](./file)
`;
      const filePath = join(tempDir, 'local-files.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links[0]!.type).toBe('local_file');
      expect(result.links[1]!.type).toBe('local_file');
      expect(result.links[2]!.type).toBe('local_file');
      expect(result.links[3]!.type).toBe('local_file');
    });

    it('should classify local file links with anchors', async () => {
      const content = `[File with anchor](./file.md#heading)`;
      const filePath = join(tempDir, 'file-anchor.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links[0]!.type).toBe('local_file');
    });

    it('should classify unknown links', async () => {
      const content = `[Image](./image.png)
[PDF](./document.pdf)
[Unknown protocol](ftp://example.com)
`;
      const filePath = join(tempDir, 'unknown.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      // Image and PDF with relative paths are classified as local_file
      expect(result.links[0]!.type).toBe('local_file');
      expect(result.links[1]!.type).toBe('local_file');
      // Unknown protocol is truly unknown
      expect(result.links[2]!.type).toBe('unknown');
    });
  });

  describe('heading extraction', () => {
    it('should extract headings with correct levels', async () => {
      const content = `# Level 1
## Level 2
### Level 3
#### Level 4
##### Level 5
###### Level 6
`;
      const filePath = join(tempDir, 'headings.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.headings).toHaveLength(1);
      expect(result.headings[0]!.level).toBe(1);
      expect(result.headings[0]!.text).toBe('Level 1');
      expect(result.headings[0]!.children).toHaveLength(1);
      expect(result.headings[0]!.children![0]!.level).toBe(2);
    });

    it('should generate GitHub-style slugs', async () => {
      const content = `# Hello World
## Section 1.1
### API Reference (v2)
#### Test_Case-Example
`;
      await writeAndParse({
        filePath: join(tempDir, 'slugs.md'),
        content,
        assertions: (result) => {
          expect(result.headings[0]!.slug).toBe('hello-world');
          expect(result.headings[0]!.children![0]!.slug).toBe('section-11');
          expect(result.headings[0]!.children![0]!.children![0]!.slug).toBe('api-reference-v2');
          expect(result.headings[0]!.children![0]!.children![0]!.children![0]!.slug).toBe('test_case-example');
        },
      });
    });

    it('should handle headings with special characters', async () => {
      const content = `# Hello! World?
## Section: Part 1
### API (v2.0)
`;
      await writeAndParse({
        filePath: join(tempDir, 'special-chars.md'),
        content,
        assertions: (result) => {
          expect(result.headings[0]!.slug).toBe('hello-world');
          expect(result.headings[0]!.children![0]!.slug).toBe('section-part-1');
          expect(result.headings[0]!.children![0]!.children![0]!.slug).toBe('api-v20');
        },
      });
    });

    it('should handle headings with duplicate text', async () => {
      const content = `# Introduction
## Details
# Introduction
## Details
`;
      const filePath = join(tempDir, 'duplicates.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      // Both "Introduction" headings should have the same slug
      expect(result.headings[0]!.slug).toBe('introduction');
      expect(result.headings[1]!.slug).toBe('introduction');
      // Both "Details" headings should have the same slug
      expect(result.headings[0]!.children![0]!.slug).toBe('details');
      expect(result.headings[1]!.children![0]!.slug).toBe('details');
    });

    it('should capture line numbers for headings', async () => {
      const content = `Line 1

# Heading on line 3

Content

## Heading on line 7
`;
      const filePath = join(tempDir, 'heading-lines.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.headings[0]!.line).toBe(3);
      expect(result.headings[0]!.children![0]!.line).toBe(7);
    });
  });

  describe('heading tree structure', () => {
    it('should build nested tree for h1 > h2 > h3', async () => {
      const content = `# Main
## Sub1
### Deep1
### Deep2
## Sub2
`;
      await writeAndParse({
        filePath: join(tempDir, 'tree1.md'),
        content,
        assertions: (result) => {
          expect(result.headings).toHaveLength(1);
          const main = result.headings[0]!;
          expect(main.text).toBe('Main');
          expect(main.children).toHaveLength(2);

          const sub1 = main.children![0]!;
          expect(sub1.text).toBe('Sub1');
          expect(sub1.children).toHaveLength(2);
          expect(sub1.children![0]!.text).toBe('Deep1');
          expect(sub1.children![1]!.text).toBe('Deep2');

          expect(main.children![1]!.text).toBe('Sub2');
        },
      });
    });

    it('should handle multiple root-level headings', async () => {
      const content = `# First
## Child of First
# Second
## Child of Second
`;
      await writeAndParse({
        filePath: join(tempDir, 'multiple-roots.md'),
        content,
        assertions: (result) => {
          expect(result.headings).toHaveLength(2);
          expect(result.headings[0]!.text).toBe('First');
          expect(result.headings[0]!.children).toHaveLength(1);
          expect(result.headings[1]!.text).toBe('Second');
          expect(result.headings[1]!.children).toHaveLength(1);
        },
      });
    });

    it('should handle skipped heading levels', async () => {
      const content = `# Main
### Skipped h2
## Back to h2
`;
      await writeAndParse({
        filePath: join(tempDir, 'skipped-levels.md'),
        content,
        assertions: (result) => {
          expect(result.headings).toHaveLength(1);
          expectHeadingStructure(
            result.headings[0]!,
            {
              text: 'Main',
              children: [
                { text: 'Skipped h2', level: 3 },
                { text: 'Back to h2', level: 2 },
              ],
            },
            expect,
          );
        },
      });
    });

    it('should handle deeply nested headings', async () => {
      const content = `# L1
## L2
### L3
#### L4
##### L5
###### L6
`;
      const filePath = join(tempDir, 'deep-nesting.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      let current = result.headings[0]!;
      expect(current.level).toBe(1);
      expect(current.children).toHaveLength(1);

      current = current.children![0]!;
      expect(current.level).toBe(2);
      expect(current.children).toHaveLength(1);

      current = current.children![0]!;
      expect(current.level).toBe(3);
      expect(current.children).toHaveLength(1);

      current = current.children![0]!;
      expect(current.level).toBe(4);
      expect(current.children).toHaveLength(1);

      current = current.children![0]!;
      expect(current.level).toBe(5);
      expect(current.children).toHaveLength(1);

      current = current.children![0]!;
      expect(current.level).toBe(6);
      expect(current.children).toBeUndefined();
    });

    it('should handle document starting with h2', async () => {
      const content = `## First h2
### h3 under h2
## Second h2
`;
      const filePath = join(tempDir, 'start-h2.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      // h2 headings should be at root level since there's no h1
      expect(result.headings).toHaveLength(2);
      expect(result.headings[0]!.text).toBe('First h2');
      expect(result.headings[0]!.level).toBe(2);
      expect(result.headings[0]!.children).toHaveLength(1);
      expect(result.headings[1]!.text).toBe('Second h2');
      expect(result.headings[1]!.level).toBe(2);
    });
  });

  describe('test fixtures', () => {
    const FIXTURES_DIR = join(findPackageRoot(), 'test-fixtures');

    it('should parse valid.md fixture', async () => {
      const fixturePath = join(FIXTURES_DIR, 'valid.md');

      const result = await parseMarkdown(fixturePath);

      expect(result.links.length).toBeGreaterThan(0);
      expect(result.headings.length).toBeGreaterThan(0);

      // Check specific links
      const linkTypes = result.links.map((link) => link.type);
      expect(linkTypes).toContain('local_file');
      expect(linkTypes).toContain('anchor');
      expect(linkTypes).toContain('external');
    });

    it('should parse external.md fixture', async () => {
      const fixturePath = join(FIXTURES_DIR, 'external.md');

      const result = await parseMarkdown(fixturePath);

      // All links should be external or email
      for (const link of result.links) {
        expect(['external', 'email']).toContain(link.type);
      }
    });

    it('should parse complex.md fixture', async () => {
      const fixturePath = join(FIXTURES_DIR, 'complex.md');

      const result = await parseMarkdown(fixturePath);

      // Verify nested heading structure
      expect(result.headings).toHaveLength(1);
      expect(result.headings[0]!.text).toBe('Main Title');
      expect(result.headings[0]!.children!.length).toBeGreaterThan(0);

      // Check for subsection slugs
      const findHeadingBySlug = (headings: typeof result.headings, slug: string): boolean => {
        for (const heading of headings) {
          if (heading.slug === slug) return true;
          if (heading.children && findHeadingBySlug(heading.children, slug)) return true;
        }
        return false;
      };

      expect(findHeadingBySlug(result.headings, 'subsection-11')).toBe(true);
      expect(findHeadingBySlug(result.headings, 'subsection-12')).toBe(true);
    });
  });

  describe('token estimation', () => {
    it('should estimate tokens as 1 token per 4 characters', async () => {
      const content = 'a'.repeat(400); // 400 characters
      const filePath = join(tempDir, 'tokens.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.estimatedTokenCount).toBe(100);
    });

    it('should round up token estimates', async () => {
      const content = 'a'.repeat(401); // 401 characters
      const filePath = join(tempDir, 'tokens-round.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.estimatedTokenCount).toBe(101); // Rounds up
    });
  });

  describe('frontmatter extraction', () => {
    it('should extract frontmatter from markdown', async () => {
      const mdPath = join(tempDir, 'with-frontmatter.md');
      await writeFile(
        mdPath,
        `---
title: Test Document
tags: [test, example]
priority: 1
---

# Content

Some content here.`,
      );

      const result = await parseMarkdown(mdPath);

      expect(result.frontmatter).toEqual({
        title: 'Test Document',
        tags: ['test', 'example'],
        priority: 1,
      });
    });

    it('should return undefined for markdown without frontmatter', async () => {
      const mdPath = join(tempDir, 'no-frontmatter.md');
      await writeFile(mdPath, '# Just Content\n\nNo frontmatter here.');

      const result = await parseMarkdown(mdPath);

      expect(result.frontmatter).toBeUndefined();
    });

    it('should handle empty frontmatter', async () => {
      const mdPath = join(tempDir, 'empty-frontmatter.md');
      await writeFile(
        mdPath,
        `---
---

# Content`,
      );

      const result = await parseMarkdown(mdPath);

      expect(result.frontmatter).toBeUndefined();
    });

    it('should capture YAML parsing errors', async () => {
      const mdPath = join(tempDir, 'invalid-yaml.md');
      await writeFile(
        mdPath,
        `---
title: Test Document
invalid: [unclosed bracket
tags: test
---

# Content`,
      );

      const result = await parseMarkdown(mdPath);

      expect(result.frontmatter).toBeUndefined();
      expect(result.frontmatterError).toBeDefined();
      expect(result.frontmatterError).not.toBe('');
    });
  });
});
