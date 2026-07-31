
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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';


import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseMarkdown } from '../src/link-parser.js';

import { assertAllLinksClassifiedAs, expectHeadingStructure, findPackageRoot, writeAndParse } from './test-helpers.js';

/**
 * Parse `content` as markdown in `dir` and return its explicit HTML anchor set,
 * sorted so assertions do not depend on document order.
 */
async function parseAnchors(dir: string, filename: string, content: string): Promise<string[]> {
  const result = await writeAndParse({
    filePath: safePath.join(dir, filename),
    content,
    assertions: () => {},
  });
  return [...(result.anchors ?? [])].sort((a, b) => a.localeCompare(b));
}

const EXAMPLE_URL = 'https://example.com';

/**
 * Parse `content` as a markdown document in `dir` and assert the EXACT set of
 * dangling-reference findings (`LINK_UNRESOLVED_REFERENCE` inputs). Every
 * dangling-reference case goes through this helper so adding a case never
 * duplicates the write/parse/assert boilerplate.
 */
async function expectUnresolved(
  dir: string,
  filename: string,
  content: string,
  expected: { label: string; line: number }[],
): Promise<void> {
  await writeAndParse({
    filePath: safePath.join(dir, filename),
    content,
    assertions: (result) => {
      expect(result.unresolvedReferences).toEqual(expected);
    },
  });
}

describe('link-parser', () => {
  let suiteDir: string;
  let tempDir: string;
  let testCounter = 0;

  beforeAll(async () => {
    // Create temp directory for the entire test suite
    suiteDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'link-parser-suite-'));
  });

  afterAll(async () => {
    // Clean up suite directory
    await rm(suiteDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Create subdirectory for each test (fast - no mkdtemp overhead)
    testCounter++;
    tempDir = safePath.join(suiteDir, `test-${testCounter}`);
    await mkdir(tempDir, { recursive: true });
  });

  describe('parseMarkdown', () => {
    it('should parse a simple markdown file with links and headings', async () => {
      const content = `# Main Heading

[Link to file](./file.md)
[Link to anchor](#main-heading)

## Subheading

Content here.
`;
      const filePath = safePath.join(tempDir, 'test.md');
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
      const filePath = safePath.join(tempDir, 'empty.md');
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
      const filePath = safePath.join(tempDir, 'no-links.md');
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
      const filePath = safePath.join(tempDir, 'no-headings.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.headings).toEqual([]);
      expect(result.links).toHaveLength(2);
    });

    it('should throw error for non-existent files', async () => {
      const filePath = safePath.join(tempDir, 'non-existent.md');

      await expect(parseMarkdown(filePath)).rejects.toThrow();
    });
  });

  describe('link extraction', () => {
    it('should extract regular links', async () => {
      const content = `[Regular link](https://example.com)
[Another link](./file.md)
`;
      const filePath = safePath.join(tempDir, 'regular-links.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links).toHaveLength(2);
      expect(result.links[0]).toMatchObject({
        text: 'Regular link',
        href: EXAMPLE_URL,
        type: 'external',
        line: 1,
        nodeType: 'link',
      });
      expect(result.links[1]).toMatchObject({
        text: 'Another link',
        href: './file.md',
        type: 'local_file',
        line: 2,
        nodeType: 'link',
      });
    });

    it('should extract autolinks', async () => {
      const content = `<https://example.com>
<mailto:test@example.com>
`;
      const filePath = safePath.join(tempDir, 'autolinks.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links).toHaveLength(2);
      expect(result.links[0]).toMatchObject({
        href: EXAMPLE_URL,
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
      const filePath = safePath.join(tempDir, 'reference-links.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      // Both the resolved linkReference node and the definition node (with URL) are extracted
      expect(result.links).toHaveLength(2);
      expect(result.links[0]).toMatchObject({
        text: 'Reference link',
        href: EXAMPLE_URL,
        type: 'external',
        line: 1,
        nodeType: 'linkReference',
      });
      // Definition node provides the actual URL
      expect(result.links[1]).toMatchObject({
        text: 'ref1',
        href: EXAMPLE_URL,
        type: 'external',
        line: 3,
        nodeType: 'definition',
      });
    });

    it('should resolve defined linkReferences and skip unresolved ones', async () => {
      const content = `## [Unreleased]

## [0.1.0] - 2026-01-01

See [the docs][docs] for details.

[docs]: https://example.com/docs
`;
      await writeAndParse({
        filePath: safePath.join(tempDir, 'mixed-link-refs.md'),
        content,
        assertions: (result) => {
          // Unresolved linkReferences (Unreleased, 0.1.0) must not appear
          const linkRefs = result.links.filter((l) => l.nodeType === 'linkReference');
          expect(linkRefs).toHaveLength(1);
          expect(linkRefs[0]).toMatchObject({
            text: 'the docs',
            href: 'https://example.com/docs',
            type: 'external',
            nodeType: 'linkReference',
          });
          // The definition node must still appear
          const definitions = result.links.filter((l) => l.nodeType === 'definition');
          expect(definitions).toHaveLength(1);
          expect(definitions[0]).toMatchObject({
            text: 'docs',
            href: 'https://example.com/docs',
          });
        },
      });
    });

    it('should extract mixed link types', async () => {
      const content = `[Regular](./file.md)
<https://example.com>
[Reference][ref]
[Anchor](#heading)

[ref]: https://example.com
`;
      const filePath = safePath.join(tempDir, 'mixed-links.md');
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
      const filePath = safePath.join(tempDir, 'link-lines.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links[0]!.line).toBe(3);
      expect(result.links[1]!.line).toBe(5);
    });

    it('should extract link text with nested emphasis and inline code', async () => {
      const content = `[**bold** and _italic_ and \`code\` text](./file.md)
`;
      const filePath = safePath.join(tempDir, 'nested-link-text.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links).toHaveLength(1);
      expect(result.links[0]).toMatchObject({
        text: 'bold and italic and code text',
        href: './file.md',
        type: 'local_file',
      });
    });

    // Regression guard (mdast-util-to-string swap): the library's
    // `includeImageAlt` option defaults to `true`, but the hand-rolled
    // walker it replaced silently dropped image alt text. `extractLinkText`
    // pins `includeImageAlt: false` to preserve that behavior — this test
    // fails if that option is ever removed or flipped.
    it('should drop image alt text from link text (behavior-preservation, not default)', async () => {
      const content = `[A ![alt](i.png) B](./file.md)
`;
      const filePath = safePath.join(tempDir, 'link-text-with-image.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links).toHaveLength(1);
      expect(result.links[0]).toMatchObject({
        text: 'A  B',
        href: './file.md',
        type: 'local_file',
      });
    });
  });

  describe('link classification', () => {
    it('should classify external URLs', async () => {
      const content = `[HTTP](http://example.com)
[HTTPS](https://example.com)
`;
      const filePath = safePath.join(tempDir, 'external.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links[0]!.type).toBe('external');
      expect(result.links[1]!.type).toBe('external');
    });

    it('should classify email links', async () => {
      const content = `[Email](mailto:test@example.com)`;
      const filePath = safePath.join(tempDir, 'email.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links[0]!.type).toBe('email');
    });

    it('should classify anchor links', async () => {
      const content = `[Anchor](#heading)`;
      const filePath = safePath.join(tempDir, 'anchor.md');
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
      const filePath = safePath.join(tempDir, 'local-files.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links[0]!.type).toBe('local_file');
      expect(result.links[1]!.type).toBe('local_file');
      expect(result.links[2]!.type).toBe('local_file');
      expect(result.links[3]!.type).toBe('local_file');
    });

    it('should classify local file links with anchors', async () => {
      const content = `[File with anchor](./file.md#heading)`;
      const filePath = safePath.join(tempDir, 'file-anchor.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.links[0]!.type).toBe('local_file');
    });

    it('should classify unknown links', async () => {
      const content = `[Image](./image.png)
[PDF](./document.pdf)
[Unknown protocol](ftp://example.com)
`;
      const filePath = safePath.join(tempDir, 'unknown.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      // Image and PDF with relative paths are classified as local_file
      expect(result.links[0]!.type).toBe('local_file');
      expect(result.links[1]!.type).toBe('local_file');
      // Unknown protocol is truly unknown
      expect(result.links[2]!.type).toBe('unknown');
    });

    it('should classify bare filenames with extensions as local_file', async () => {
      await assertAllLinksClassifiedAs(tempDir, 'bare-filenames.md', `[Schema](config.schema.json)
[Image](image.png)
[Archive](backup.tar.gz)
`, 'local_file');
    });

    it('should classify protocol-like hrefs as unknown', async () => {
      await assertAllLinksClassifiedAs(tempDir, 'protocol-like.md', `[JS](javascript:void(0))
[Tel](tel:+1234567890)
`, 'unknown');
    });

    it('should classify inline data:/blob: URIs as embedded', async () => {
      await assertAllLinksClassifiedAs(tempDir, 'embedded-uris.md', `[Data](data:text/plain;base64,SGVsbG8=)
[Blob](blob:https://example.com/550e8400-uuid)
`, 'embedded');
    });

    it('should classify percent-encoded relative paths as local_file', async () => {
      await assertAllLinksClassifiedAs(tempDir, 'encoded-paths.md', `[PDF with spaces](files/My%20Document%20Name.pdf)
[Encoded subdir](docs/path%20with%20spaces/file.md)
[Bare encoded filename](My%20Document.pdf)
`, 'local_file');
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
      const filePath = safePath.join(tempDir, 'headings.md');
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
        filePath: safePath.join(tempDir, 'slugs.md'),
        content,
        assertions: (result) => {
          expect(result.headings[0]!.slug).toBe('hello-world');
          expect(result.headings[0]!.children![0]!.slug).toBe('section-11');
          expect(result.headings[0]!.children![0]!.children![0]!.slug).toBe('api-reference-v2');
          expect(result.headings[0]!.children![0]!.children![0]!.children![0]!.slug).toBe('test_case-example');
        },
      });
    });

    it('should extract text from styled (bold/italic/code/link) headings for correct slugs', async () => {
      const content = `# **CRITICAL: Code Duplication Policy**
## _Emphasized Heading_
### Heading with \`inlineCode\` token
#### Heading with [a link](https://example.com)
`;
      await writeAndParse({
        filePath: safePath.join(tempDir, 'styled-headings.md'),
        content,
        assertions: (result) => {
          expect(result.headings[0]!.text).toBe('CRITICAL: Code Duplication Policy');
          expect(result.headings[0]!.slug).toBe('critical-code-duplication-policy');
          expect(result.headings[0]!.children![0]!.text).toBe('Emphasized Heading');
          expect(result.headings[0]!.children![0]!.slug).toBe('emphasized-heading');
          expect(result.headings[0]!.children![0]!.children![0]!.slug).toBe(
            'heading-with-inlinecode-token'
          );
          expect(
            result.headings[0]!.children![0]!.children![0]!.children![0]!.slug
          ).toBe('heading-with-a-link');
        },
      });
    });

    // Regression guard (mdast-util-to-string swap): empirically verified
    // divergence for `## A ![alt](i.png) B` — old hand-rolled walker text
    // "A  B" / slug "a--b"; mdast-util-to-string with default
    // `includeImageAlt: true` would instead produce "A alt B" / slug
    // "a-alt-b". `extractHeadingText` pins `includeImageAlt: false` so
    // anchor slugs for headings containing images do not silently change.
    // This test fails if that option is ever removed or flipped.
    it('should drop image alt text from heading text and slug (behavior-preservation, not default)', async () => {
      const content = `## A ![alt](i.png) B
`;
      await writeAndParse({
        filePath: safePath.join(tempDir, 'heading-with-image.md'),
        content,
        assertions: (result) => {
          expect(result.headings[0]!.text).toBe('A  B');
          expect(result.headings[0]!.slug).toBe('a--b');
        },
      });
    });

    it('should handle headings with special characters', async () => {
      const content = `# Hello! World?
## Section: Part 1
### API (v2.0)
`;
      await writeAndParse({
        filePath: safePath.join(tempDir, 'special-chars.md'),
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
      const filePath = safePath.join(tempDir, 'duplicates.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      // GithubSlugger deduplicates: first occurrence gets base slug, subsequent get -1, -2, etc.
      expect(result.headings[0]!.slug).toBe('introduction');
      expect(result.headings[1]!.slug).toBe('introduction-1');
      // Details slugs are also deduplicated across the whole document
      expect(result.headings[0]!.children![0]!.slug).toBe('details');
      expect(result.headings[1]!.children![0]!.slug).toBe('details-1');
    });

    it('should capture line numbers for headings', async () => {
      const content = `Line 1

# Heading on line 3

Content

## Heading on line 7
`;
      const filePath = safePath.join(tempDir, 'heading-lines.md');
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
        filePath: safePath.join(tempDir, 'tree1.md'),
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
        filePath: safePath.join(tempDir, 'multiple-roots.md'),
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
        filePath: safePath.join(tempDir, 'skipped-levels.md'),
        content,
        assertions: (result) => {
          expect(result.headings).toHaveLength(1);
          expectHeadingStructure(
            result.headings[0],
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
      const filePath = safePath.join(tempDir, 'deep-nesting.md');
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
      const filePath = safePath.join(tempDir, 'start-h2.md');
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
    const FIXTURES_DIR = safePath.join(findPackageRoot(), 'test-fixtures');

    it('should parse valid.md fixture', async () => {
      const fixturePath = safePath.join(FIXTURES_DIR, 'valid.md');

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
      const fixturePath = safePath.join(FIXTURES_DIR, 'external.md');

      const result = await parseMarkdown(fixturePath);

      // All links should be external or email
      for (const link of result.links) {
        expect(['external', 'email']).toContain(link.type);
      }
    });

    it('should parse complex.md fixture', async () => {
      const fixturePath = safePath.join(FIXTURES_DIR, 'complex.md');

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
      const filePath = safePath.join(tempDir, 'tokens.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.estimatedTokenCount).toBe(100);
    });

    it('should round up token estimates', async () => {
      const content = 'a'.repeat(401); // 401 characters
      const filePath = safePath.join(tempDir, 'tokens-round.md');
      await writeFile(filePath, content, 'utf-8');

      const result = await parseMarkdown(filePath);

      expect(result.estimatedTokenCount).toBe(101); // Rounds up
    });
  });

  describe('frontmatter extraction', () => {
    it('should extract frontmatter from markdown', async () => {
      const mdPath = safePath.join(tempDir, 'with-frontmatter.md');
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
      const mdPath = safePath.join(tempDir, 'no-frontmatter.md');
      await writeFile(mdPath, '# Just Content\n\nNo frontmatter here.');

      const result = await parseMarkdown(mdPath);

      expect(result.frontmatter).toBeUndefined();
    });

    it('should handle empty frontmatter', async () => {
      const mdPath = safePath.join(tempDir, 'empty-frontmatter.md');
      await writeFile(
        mdPath,
        `---
---

# Content`,
      );

      const result = await parseMarkdown(mdPath);

      expect(result.frontmatter).toBeUndefined();
    });

    // Regression guard: ADR/PRD frontmatter conventionally uses unquoted ISO
    // dates per YAML 1.2; the parser must keep them as strings (not promote
    // them to JS Date objects) so schema validation for fields typed `string`
    // doesn't break.
    it('keeps unquoted ISO dates as strings (YAML 1.2, no 1.1 timestamp promotion)', async () => {
      const mdPath = safePath.join(tempDir, 'iso-date.md');
      await writeFile(
        mdPath,
        `---
type: adr
date: 2026-04-15
---

# ADR`,
      );

      const result = await parseMarkdown(mdPath);

      expect(result.frontmatter?.date).toBe('2026-04-15');
      expect(result.frontmatter?.date).not.toBeInstanceOf(Date);
    });

    it('should capture YAML parsing errors', async () => {
      const mdPath = safePath.join(tempDir, 'invalid-yaml.md');
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

  describe('unresolved reference-style links', () => {
    it('reports a full-form reference with no matching definition', async () => {
      await expectUnresolved(tempDir, 'unresolved-full.md', 'Line 1\n\nSee [some text][nope] for details.\n', [
        { label: 'nope', line: 3 },
      ]);
    });

    it('does not report a full-form reference that has a matching definition', async () => {
      await writeAndParse({
        filePath: safePath.join(tempDir, 'resolved-full.md'),
        content: 'See [some text][yes] for details.\n\n[yes]: ./x.md\n',
        assertions: (result) => {
          expect(result.unresolvedReferences).toEqual([]);
          // Existing resolved-link behavior is unchanged: the linkReference
          // node still resolves to a real link.
          const linkRefs = result.links.filter((l) => l.nodeType === 'linkReference');
          expect(linkRefs).toHaveLength(1);
          expect(linkRefs[0]).toMatchObject({ href: './x.md', type: 'local_file' });
        },
      });
    });

    it('reports a collapsed-form reference with no matching definition', async () => {
      await expectUnresolved(tempDir, 'unresolved-collapsed.md', '[nope][]\n', [{ label: 'nope', line: 1 }]);
    });

    it('reports the outer label of a nested image reference (no under-reporting)', async () => {
      // `[![badge](i.png)][ci]`: the outer label is the one that dangles.
      await expectUnresolved(tempDir, 'nested-outer.md', '[![badge](i.png)][ci-nope]\n', [
        { label: 'ci-nope', line: 1 },
      ]);
    });

    it('reports both labels of a nested reference when both dangle', async () => {
      await expectUnresolved(tempDir, 'nested-both.md', '[![alt][inner-nope]][outer-nope]\n', [
        { label: 'outer-nope', line: 1 },
        { label: 'inner-nope', line: 1 },
      ]);
    });

    it('resolves a nested collapsed image reference whose labels are all defined', async () => {
      // Corpus false positive (natural-compare README): bracket NESTING makes
      // this one outer reference (text `![Build][]`, label `1`) rather than a
      // garbage `"![Build"` label.
      const content = `[![Build][]][1]

[Build]: ./build.png
[1]: ./ci.md
`;
      await expectUnresolved(tempDir, 'nested-defined.md', content, []);
    });

    it('masks inline code without masking the rest of the line', async () => {
      // Masking PRECISION: the backticked example is ignored, the real
      // dangling reference on the same line is still reported.
      await expectUnresolved(
        tempDir, 'unresolved-inline-code.md',
        'Example: `[a][nope]` but see [text][really-nope].\n',
        [{ label: 'really-nope', line: 1 }],
      );
    });

    it('does not report a dangling-looking reference inside a fenced code block', async () => {
      await expectUnresolved(tempDir, 'unresolved-fenced.md', '```\n[a][nope]\n```\n\n[t][real-nope]\n', [
        { label: 'real-nope', line: 5 },
      ]);
    });

    it('does not report a dangling-looking reference inside an HTML comment', async () => {
      // Commented-out scaffolding is invisible to readers, and adding a
      // definition would not make it resolve — the fix advice would be wrong.
      await expectUnresolved(
        tempDir, 'unresolved-html-comment.md',
        '<!-- [a][nope-comment] -->\n\n[t][real-nope]\n',
        [{ label: 'real-nope', line: 3 }],
      );
    });

    it('does not report a dangling-looking reference inside an HTML block', async () => {
      await expectUnresolved(
        tempDir, 'unresolved-html-block.md',
        '<div>[a][nope-div]</div>\n\n[t][real-nope]\n',
        [{ label: 'real-nope', line: 3 }],
      );
    });

    it('does not report a bracket query-param inside an autolink URL', async () => {
      // qs/Rails-style bracket query params (`?filter[status][eq]=1`) are
      // ubiquitous and not dangling references. Autolinks are `link` nodes.
      await expectUnresolved(
        tempDir, 'unresolved-autolink-query.md',
        'See <https://x.com/?filter[status][eq]=1> for details.\n',
        [],
      );
    });

    it('does not report a bracket query-param inside an inline link URL', async () => {
      await expectUnresolved(
        tempDir, 'unresolved-inline-link-query.md',
        '[docs](https://x.com/?filter[status][eq]=1)\n',
        [],
      );
    });

    it('does not report a dangling-looking reference inside a link title', async () => {
      await expectUnresolved(tempDir, 'unresolved-link-title.md', '[t](u "a [alpha][beta] b")\n', []);
    });

    it('still detects a genuine dangling reference in the same paragraph as a bracket-query-param URL', async () => {
      // The mask must be range-scoped (per link/image/definition node), not
      // line-scoped: a real finding elsewhere on the same line must survive.
      await expectUnresolved(
        tempDir, 'unresolved-query-and-real.md',
        'See [docs](https://x.com/?filter[status][eq]=1) and [text][real-nope].\n',
        [{ label: 'real-nope', line: 1 }],
      );
    });

    it('does not report a dangling-looking reference inside YAML frontmatter', async () => {
      const content = `---
description: "use [a][nope-fm]"
---

[t][real-nope]
`;
      await expectUnresolved(tempDir, 'unresolved-frontmatter.md', content, [
        { label: 'real-nope', line: 5 },
      ]);
    });

    it('normalizes label case and internal whitespace when matching definitions', async () => {
      const content = `See [some text][My   Label] and [other][Other Label].

[my label]: ./x.md
`;
      await expectUnresolved(tempDir, 'unresolved-normalized.md', content, [
        { label: 'Other Label', line: 1 },
      ]);
    });

    it('matches an escaped label against its escaped definition', async () => {
      // `[a][foo\]bar]` WITH a `[foo\]bar]:` definition is RESOLVED — reporting
      // it would be a false positive on a working link.
      const content = String.raw`See [some text][foo\]bar] here.

[foo\]bar]: ./x.md
`;
      await expectUnresolved(tempDir, 'unresolved-escaped-label.md', content, []);
    });

    it('does not report an escaped opening bracket (shortcut reference, non-goal)', async () => {
      // CommonMark makes `\[a][nope]` a literal `[a]` plus a *shortcut*
      // reference `[nope]`, which is an explicit non-goal.
      const content = String.raw`This is \[a][nope] in prose.
`;
      await expectUnresolved(tempDir, 'escaped-opener.md', content, []);
    });

    it('does not report a bare shortcut reference (non-goal)', async () => {
      // Shortcut references ([label] alone, no second bracket pair) are an
      // explicit non-goal: bracketed prose is ubiquitous and would be a
      // false-positive firehose. See unresolved-references.ts for the rationale.
      await expectUnresolved(
        tempDir, 'shortcut-not-flagged.md',
        'This mentions [some label] in passing.\n\n[t][real-nope]\n',
        [{ label: 'real-nope', line: 3 }],
      );
    });

    describe('precision heuristics (corpus false-positive patterns)', () => {
      it('does not report an optional-argument API signature', async () => {
        // needle README: `### needle.get(url[, options][, callback])` — a
        // heading, not code, so masking is not what saves us here.
        await expectUnresolved(
          tempDir, 'fp-api-signature.md',
          '### needle.get(url[, options][, callback])\n\n[t][real-nope]\n',
          [{ label: 'real-nope', line: 3 }],
        );
      });

      it('does not report numeric prose citations', async () => {
        // qs/resolve THREAT_MODEL.md: `the host application[3][4][8].`
        await expectUnresolved(
          tempDir, 'fp-numeric-citations.md',
          'Trusts the host application[3][4][8].\n\n[t][real-nope]\n',
          [{ label: 'real-nope', line: 3 }],
        );
      });

      it('does not report array subscripts in prose', async () => {
        await expectUnresolved(
          tempDir, 'fp-subscripts.md',
          'Then matrix[i][j] is transposed.\n\n[t][real-nope]\n',
          [{ label: 'real-nope', line: 3 }],
        );
      });

      it('does not report a label with no alphanumeric characters', async () => {
        await expectUnresolved(tempDir, 'fp-punctuation-only.md', 'Operators [==][!=] compare.\n', []);
      });
    });
  });

  // A markdown author can place an explicit `<a id="short"></a>` above a long
  // heading and link to `#short`. GitHub renders that id into the DOM and the
  // fragment resolves; VAT indexed heading slugs only, so it reported
  // LINK_BROKEN_ANCHOR for a link that works. The anchor set is matched
  // case-folded for markdown (the heading-slug policy), so ids are indexed
  // lowercased.
  describe('explicit HTML anchor extraction', () => {
    it('indexes id and name attributes from block and inline HTML', async () => {
      const anchors = await parseAnchors(
        tempDir,
        'anchors-basic.md',
        [
          '<a id="materialize"></a>',
          '',
          '## Materialize a very long heading name that nobody wants to type',
          '',
          'Inline <span id="inline-target">marker</span> and a legacy <a name="old-name"></a>.',
          '',
          '<div id="Mixed-Case">block</div>',
          '',
        ].join('\n'),
      );

      expect(anchors).toEqual(['inline-target', 'materialize', 'mixed-case', 'old-name']);
    });

    it('ignores id attributes inside fenced and inline code', async () => {
      const anchors = await parseAnchors(
        tempDir,
        'anchors-code.md',
        [
          'Write `<a id="inline-code-id"></a>` to add an anchor.',
          '',
          '```html',
          '<a id="fenced-id"></a>',
          '```',
          '',
          '    <a id="indented-id"></a>',
          '',
        ].join('\n'),
      );

      expect(anchors).toEqual([]);
    });

    it('leaves anchors undefined when a document declares none', async () => {
      const result = await writeAndParse({
        filePath: safePath.join(tempDir, 'anchors-none.md'),
        content: '# Title\n\nNo raw HTML here.\n',
        assertions: () => {},
      });

      expect(result.anchors).toBeUndefined();
    });
  });
});
