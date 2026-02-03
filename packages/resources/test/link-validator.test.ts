/**
 * Tests for link-validator.ts
 *
 * Validates link validation logic for all link types:
 * - local_file (with and without anchors)
 * - anchor (in same file)
 * - external URLs
 * - email links
 * - unknown link types
 */

import path from 'node:path';

import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { validateLink } from '../src/link-validator.js';
import type { HeadingNode } from '../src/types.js';

import { assertValidation, createGitRepo, createHeadings, createLink } from './test-helpers.js';

// Test fixtures directory
const FIXTURES_DIR = path.resolve(import.meta.dirname, '../test-fixtures');

// Common test file paths
const VALID_MD = 'valid.md';
const BROKEN_FILE_MD = 'broken-file.md';
const TARGET_MD = 'target.md';

// Common heading data
const VALID_ANCHOR_HEADING = { text: 'Valid Anchor', slug: 'valid-anchor' };
const HEADING_ANCHOR_HEADING = { text: 'Heading Anchor', slug: 'heading-anchor' };

// Common test links
const NONEXISTENT_FILE_LINK = './nonexistent.md';
const NONEXISTENT_ANCHOR = '#nonexistent';
const TARGET_FILE_LINK = './target.md';

describe('validateLink', () => {
  describe('local_file links', () => {
    it('should validate valid relative path', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('local_file', TARGET_FILE_LINK, 'Link to target', 3);
      const headingsMap = new Map<string, HeadingNode[]>();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should validate valid relative path with ../', async () => {
      const sourceFile = path.join(FIXTURES_DIR, 'subdir', 'nested.md');
      const link = createLink('local_file', '../target.md', 'Link to parent', 1);
      const headingsMap = new Map<string, HeadingNode[]>();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should detect broken file link', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      await assertValidation(
        {
          sourceFile: path.join(FIXTURES_DIR, BROKEN_FILE_MD),
          link: createLink('local_file', NONEXISTENT_FILE_LINK, 'Broken link', 3),
          headingsMap: new Map<string, HeadingNode[]>(),
          expected: {
            type: 'broken_file',
            messageContains: ['File not found', 'nonexistent.md'],
            hasSuggestion: true,
          },
        },
        expect,
      );
    });

    it('should validate local file with valid anchor', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      const targetFile = path.join(FIXTURES_DIR, TARGET_MD);
      const link = createLink('local_file', './target.md#valid-anchor', 'Link with anchor', 5);

      const headingsMap = new Map<string, HeadingNode[]>([
        [targetFile, createHeadings(VALID_ANCHOR_HEADING)],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should detect broken anchor in local file', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      const targetFile = path.join(FIXTURES_DIR, TARGET_MD);
      await assertValidation(
        {
          sourceFile: path.join(FIXTURES_DIR, 'broken-anchor.md'),
          link: createLink('local_file', './target.md#nonexistent-heading', 'Broken anchor', 3),
          headingsMap: new Map<string, HeadingNode[]>([
            [targetFile, createHeadings(VALID_ANCHOR_HEADING)],
          ]),
          expected: {
            type: 'broken_anchor',
            messageContains: ['Anchor not found', 'nonexistent-heading'],
            hasSuggestion: true,
          },
        },
        expect,
      );
    });

    it('should handle absolute paths', async () => {
      const targetFile = path.join(FIXTURES_DIR, TARGET_MD);
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('local_file', targetFile, 'Absolute path');
      const headingsMap = new Map<string, HeadingNode[]>();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });
  });

  describe('anchor links', () => {
    it('should validate valid anchor in current file', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      await assertValidation(
        {
          sourceFile,
          link: createLink('anchor', '#heading-anchor', 'Anchor link', 5),
          headingsMap: new Map<string, HeadingNode[]>([
            [sourceFile, createHeadings(HEADING_ANCHOR_HEADING)],
          ]),
          expected: null,
        },
        expect,
      );
    });

    it('should detect broken anchor in current file', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      await assertValidation(
        {
          sourceFile,
          link: createLink('anchor', NONEXISTENT_ANCHOR, 'Broken anchor', 10),
          headingsMap: new Map<string, HeadingNode[]>([
            [sourceFile, createHeadings(HEADING_ANCHOR_HEADING)],
          ]),
          expected: {
            type: 'broken_anchor',
            messageContains: ['Anchor not found', NONEXISTENT_ANCHOR],
          },
        },
        expect,
      );
    });

    it('should perform case-insensitive anchor matching', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      await assertValidation(
        {
          sourceFile,
          link: createLink('anchor', '#HEADING-ANCHOR', 'Case mismatch', 5),
          headingsMap: new Map<string, HeadingNode[]>([
            [sourceFile, createHeadings(HEADING_ANCHOR_HEADING)],
          ]),
          expected: null,
        },
        expect,
      );
    });

    it('should validate anchors in nested headings', async () => {
      const sourceFile = path.join(FIXTURES_DIR, 'complex.md');
      const link = createLink('anchor', '#nested-child', 'Nested heading', 10);

      const headingsMap = new Map<string, HeadingNode[]>([
        [sourceFile, createHeadings({
          text: 'Parent Heading',
          slug: 'parent-heading',
          level: 2,
          children: createHeadings({
            text: 'Nested Child',
            slug: 'nested-child',
            level: 3,
          }),
        })],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should return error when file has no headings', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      await assertValidation(
        {
          sourceFile: path.join(FIXTURES_DIR, VALID_MD),
          link: createLink('anchor', '#any-heading', 'No headings', 5),
          headingsMap: new Map<string, HeadingNode[]>(),
          expected: {
            type: 'broken_anchor',
          },
        },
        expect,
      );
    });
  });

  describe('external links', () => {
    it('should return null for HTTP URL (external links not validated)', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('external', 'http://example.com', 'HTTP link', 6);
      const headingsMap = new Map<string, HeadingNode[]>();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should return null for HTTPS URL (external links not validated)', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('external', 'https://example.com/path', 'HTTPS link', 7);
      const headingsMap = new Map<string, HeadingNode[]>();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });
  });

  describe('email links', () => {
    it('should return null for valid email', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('email', 'mailto:test@example.com', 'Email link', 8);
      const headingsMap = new Map<string, HeadingNode[]>();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should return null for email without mailto:', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('email', 'test@example.com', 'Plain email', 9);
      const headingsMap = new Map<string, HeadingNode[]>();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });
  });

  describe('unknown link types', () => {
    it('should return warning for unknown protocol', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      await assertValidation(
        {
          sourceFile: path.join(FIXTURES_DIR, VALID_MD),
          link: createLink('unknown', 'ftp://example.com/file', 'FTP link', 10),
          headingsMap: new Map<string, HeadingNode[]>(),
          expected: {
            type: 'unknown_link',
            messageContains: 'Unknown link type',
            link: 'ftp://example.com/file',
          },
        },
        expect,
      );
    });

    it('should return warning for other unknown link', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      await assertValidation(
        {
          sourceFile: path.join(FIXTURES_DIR, VALID_MD),
          link: createLink('unknown', 'tel:+1234567890', 'Tel link', 11),
          headingsMap: new Map<string, HeadingNode[]>(),
          expected: {
            type: 'unknown_link',
          },
        },
        expect,
      );
    });
  });

  describe('cross-platform path handling', () => {
    it('should handle Unix-style paths', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('local_file', TARGET_FILE_LINK, 'Unix path');
      const headingsMap = new Map<string, HeadingNode[]>();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should handle paths with mixed separators', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      // Node's path.resolve will normalize this correctly on all platforms
      const link = createLink('local_file', './subdir/nested.md', 'Mixed path');
      const headingsMap = new Map<string, HeadingNode[]>();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle link without line number', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('anchor', '#heading-anchor', 'No line number');
      delete link.line;

      const headingsMap = new Map<string, HeadingNode[]>([
        [sourceFile, createHeadings({ text: 'Heading Anchor', slug: 'heading-anchor' })],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should handle empty anchor after #', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('anchor', '#', 'Empty anchor', 5);

      const headingsMap = new Map<string, HeadingNode[]>([
        [sourceFile, createHeadings({ text: 'Heading', slug: 'heading' })],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('broken_anchor');
    });

    it('should handle file path with anchor where file does not exist', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('local_file', './nonexistent.md#heading', 'Broken file with anchor', 5);
      const headingsMap = new Map<string, HeadingNode[]>();

      const result = await validateLink(link, sourceFile, headingsMap);

      // Should fail on file check, not anchor check
      expect(result).not.toBeNull();
      expect(result?.type).toBe('broken_file');
    });

    it('should handle file with only anchor (empty file path)', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      // This would be classified as 'anchor' type by the parser, not 'local_file'
      const link = createLink('local_file', '#heading', 'Anchor as file', 5);

      const targetFile = path.join(FIXTURES_DIR, 'target.md');
      const headingsMap = new Map<string, HeadingNode[]>([
        [targetFile, createHeadings({ text: 'Heading', slug: 'heading' })],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      // Empty file path before # means current directory + "#heading"
      // This will likely fail as a file lookup
      expect(result).not.toBeNull();
    });

    it('should handle multiple nested levels', async () => {
      const sourceFile = path.join(FIXTURES_DIR, 'complex.md');
      const link = createLink('anchor', '#deeply-nested', 'Deep nesting', 20);

      const headingsMap = new Map<string, HeadingNode[]>([
        [sourceFile, createHeadings({
          text: 'Level 1',
          slug: 'level-1',
          level: 1,
          children: createHeadings({
            text: 'Level 2',
            slug: 'level-2',
            level: 2,
            children: createHeadings({
              text: 'Level 3',
              slug: 'level-3',
              level: 3,
              children: createHeadings({
                text: 'Deeply Nested',
                slug: 'deeply-nested',
                level: 4,
              }),
            }),
          }),
        })],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });
  });

  describe('validation issue structure', () => {
    it('should include all required fields in error issue', async () => {
      const sourceFile = path.join(FIXTURES_DIR, BROKEN_FILE_MD);
      const link = createLink('local_file', NONEXISTENT_FILE_LINK, 'Broken', 3);
      const headingsMap = new Map<string, HeadingNode[]>();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).not.toBeNull();
      expect(result).toHaveProperty('resourcePath');
      expect(result).toHaveProperty('line');
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('link');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('suggestion');

      expect(result?.resourcePath).toBe(sourceFile);
      expect(result?.line).toBe(3);
      expect(result?.link).toBe(NONEXISTENT_FILE_LINK);
    });

    it('should include empty suggestion in broken file issue', async () => {
      const sourceFile = path.join(FIXTURES_DIR, BROKEN_FILE_MD);
      const link = createLink('local_file', NONEXISTENT_FILE_LINK, 'Broken');
      const headingsMap = new Map<string, HeadingNode[]>();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result?.suggestion).toBeDefined();
      expect(result?.suggestion).toBe('');
    });

    it('should include empty suggestion in broken anchor issue', async () => {
      const sourceFile = path.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('anchor', NONEXISTENT_ANCHOR, 'Broken');
      const headingsMap = new Map<string, HeadingNode[]>([
        [sourceFile, createHeadings({ text: 'Valid', slug: 'valid' })],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result?.suggestion).toBeDefined();
      expect(result?.suggestion).toBe('');
    });
  });

  describe('gitignored files', () => {
    let tempDir: string;
    let gitRoot: string;
    const GITIGNORE_FILE = '.gitignore';

    beforeEach(async () => {
      const fs = await import('node:fs');

      // Create temp directory with git repo
      tempDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'link-validator-gitignore-'));
      gitRoot = tempDir;

      // Initialize git repo properly (git check-ignore needs a real repo)
      createGitRepo(gitRoot);
    });

    afterEach(async () => {
      const fs = await import('node:fs');
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    /**
     * Helper to test that a non-ignored file linking to a gitignored file returns an error
     */
    async function assertGitignoreError(linkHref: string, linkText: string): Promise<void> {
      const sourceFile = path.join(gitRoot, 'source.md');
      const link = createLink('local_file', linkHref, linkText, 1);
      const headingsMap = new Map<string, HeadingNode[]>();

      await assertValidation(
        {
          sourceFile,
          link,
          headingsMap,
          expected: {
            type: 'link_to_gitignored',
            messageContains: 'gitignored',
            hasSuggestion: true,
          },
          validationOptions: {
            projectRoot: gitRoot,
            skipGitIgnoreCheck: false,
          },
        },
        expect
      );
    }

    // eslint-disable-next-line sonarjs/assertions-in-tests -- assertValidation helper contains assertions
    it('should return error for links to gitignored files', async () => {
      const fs = await import('node:fs');

      // Create .gitignore file
      const gitignorePath = path.join(gitRoot, GITIGNORE_FILE);
      fs.writeFileSync(gitignorePath, 'ignored.md\n');

      // Create gitignored file
      const ignoredFile = path.join(gitRoot, 'ignored.md');
      fs.writeFileSync(ignoredFile, '# Ignored');

      // Create source file
      const sourceFile = path.join(gitRoot, 'source.md');
      fs.writeFileSync(sourceFile, '# Source');

      await assertGitignoreError('./ignored.md', 'Link to ignored');
    });

    // eslint-disable-next-line sonarjs/assertions-in-tests -- assertValidation helper contains assertions
    it('should pass for links to non-gitignored files in git repo', async () => {
      const fs = await import('node:fs');

      // Create .gitignore file (ignoring other files)
      const gitignorePath = path.join(gitRoot, GITIGNORE_FILE);
      fs.writeFileSync(gitignorePath, 'other.md\n');

      // Create non-gitignored file
      const targetFile = path.join(gitRoot, 'target.md');
      fs.writeFileSync(targetFile, '# Target');

      // Create source file
      const sourceFile = path.join(gitRoot, 'source.md');
      fs.writeFileSync(sourceFile, '# Source');

      const link = createLink('local_file', TARGET_FILE_LINK, 'Link to target', 1);
      const headingsMap = new Map<string, HeadingNode[]>();

      await assertValidation(
        {
          sourceFile,
          link,
          headingsMap,
          expected: null,
          validationOptions: {
            projectRoot: gitRoot,
            skipGitIgnoreCheck: false,
          },
        },
        expect
      );
    });

    // eslint-disable-next-line sonarjs/assertions-in-tests -- assertValidation helper contains assertions
    it('should return error for links to gitignored directories', async () => {
      const fs = await import('node:fs');

      // Create .gitignore file
      const gitignorePath = path.join(gitRoot, GITIGNORE_FILE);
      fs.writeFileSync(gitignorePath, 'private/\n');

      // Create gitignored directory with file
      const privateDir = path.join(gitRoot, 'private');
      mkdirSyncReal(privateDir);
      const ignoredFile = path.join(privateDir, 'secret.md');
      fs.writeFileSync(ignoredFile, '# Secret');

      // Create source file
      const sourceFile = path.join(gitRoot, 'source.md');
      fs.writeFileSync(sourceFile, '# Source');

      await assertGitignoreError('./private/secret.md', 'Link to secret');
    });
  });
});
