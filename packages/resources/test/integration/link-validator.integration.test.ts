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


import { writeFile } from 'node:fs/promises';

/* eslint-disable security/detect-non-literal-fs-filename -- tests use dynamic file paths in temp directory */

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

import { fragmentIndex, validateLink, type FragmentIndex } from '../../src/link-validator.js';
import { ResourceRegistry } from '../../src/resource-registry.js';
import { assertValidation, createGitRepo, createLink, setupSubdirTestSuite } from '../test-helpers.js';

/**
 * Helper to test that a non-ignored file linking to a gitignored file returns an error
 */
async function assertGitignoreError(gitRoot: string, linkHref: string, linkText: string): Promise<void> {
  const sourceFile = safePath.join(gitRoot, 'source.md');
  const link = createLink('local_file', linkHref, linkText, 1);
  const headingsMap = fragmentIndex();

  await assertValidation(
    {
      sourceFile,
      link,
      headingsMap,
      expected: {
        code: 'LINK_TO_GITIGNORED',
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

// Test fixtures directory
const FIXTURES_DIR = safePath.resolve(import.meta.dirname, '../../test-fixtures');

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

/**
 * Build the standard headings map used in anchor-validation tests:
 * a single entry mapping `sourceFile` to the slug of HEADING_ANCHOR_HEADING.
 */
function makeAnchorHeadingsMap(sourceFile: string): FragmentIndex {
  return fragmentIndex([
    [sourceFile, new Set([HEADING_ANCHOR_HEADING.slug.toLowerCase()])],
  ]);
}

/**
 * Crawl a directory into a fresh ResourceRegistry and run validation.
 * Extracted to eliminate the repeated 3-line setup in cross-format anchor tests.
 */
async function crawlAndValidate(dir: string): Promise<Awaited<ReturnType<ResourceRegistry['validate']>>> {
  const reg = new ResourceRegistry({ baseDir: dir });
  await reg.crawl({ baseDir: dir });
  return reg.validate({ skipGitIgnoreCheck: true });
}

describe('validateLink', () => {
  describe('local_file links', () => {
    it('should validate valid relative path', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('local_file', TARGET_FILE_LINK, 'Link to target', 3);
      const headingsMap = fragmentIndex();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should validate valid relative path with ../', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, 'subdir', 'nested.md');
      const link = createLink('local_file', '../target.md', 'Link to parent', 1);
      const headingsMap = fragmentIndex();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should detect broken file link', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      await assertValidation(
        {
          sourceFile: safePath.join(FIXTURES_DIR, BROKEN_FILE_MD),
          link: createLink('local_file', NONEXISTENT_FILE_LINK, 'Broken link', 3),
          headingsMap: fragmentIndex(),
          expected: {
            code: 'LINK_BROKEN_FILE',
            messageContains: ['File not found', 'nonexistent.md'],
            hasSuggestion: true,
          },
        },
        expect,
      );
    });

    it('should detect case mismatch in filename', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      // Create a temporary file with specific case
      const fs = await import('node:fs');
      const tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'case-test-'));
      const actualFileName = 'TestFile.md';
      const targetFile = safePath.join(tempDir, actualFileName);
      const sourceFile = safePath.join(tempDir, 'source.md');

      try {
        fs.writeFileSync(targetFile, '# Test\n');
        fs.writeFileSync(sourceFile, '');

        // Try to validate link with wrong case
        await assertValidation(
          {
            sourceFile,
            link: createLink('local_file', './testfile.md', 'Wrong case link', 3),
            headingsMap: fragmentIndex(),
            expected: {
              code: 'LINK_BROKEN_FILE',
              messageContains: ['case mismatch', 'TestFile.md', 'testfile.md'],
              hasSuggestion: true,
            },
          },
          expect,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should validate local file with valid anchor', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      const targetFile = safePath.join(FIXTURES_DIR, TARGET_MD);
      const link = createLink('local_file', './target.md#valid-anchor', 'Link with anchor', 5);

      const headingsMap = fragmentIndex([
        [targetFile, new Set([VALID_ANCHOR_HEADING.slug.toLowerCase()])],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should detect broken anchor in local file', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      const targetFile = safePath.join(FIXTURES_DIR, TARGET_MD);
      await assertValidation(
        {
          sourceFile: safePath.join(FIXTURES_DIR, 'broken-anchor.md'),
          link: createLink('local_file', './target.md#nonexistent-heading', 'Broken anchor', 3),
          headingsMap: fragmentIndex([
            [targetFile, new Set([VALID_ANCHOR_HEADING.slug.toLowerCase()])],
          ]),
          expected: {
            code: 'LINK_BROKEN_ANCHOR',
            messageContains: ['Anchor not found', 'nonexistent-heading'],
            hasSuggestion: true,
          },
        },
        expect,
      );
    });

    it('treats leading-/ filesystem path with no projectRoot as absolute_no_root', async () => {
      // Per RFC 3986 §4.2, leading-/ is an absolute-path reference. Without a
      // configured projectRoot we surface broken_file with the absolute_no_root
      // message. Use a literal leading-/ href so the test is meaningful on
      // Windows too (where safePath.join would produce C:/... and miss the
      // leading-/ branch entirely).
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('local_file', '/does/not/exist.md', 'Absolute path');
      const headingsMap = fragmentIndex();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).not.toBeNull();
      expect(result?.code).toBe('LINK_BROKEN_FILE');
      expect(result?.message).toContain('requires a configured projectRoot');
    });

    it('should resolve percent-encoded paths to existing files', async () => {
      const fs = await import('node:fs');
      const tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'encoded-path-'));
      const filesDir = safePath.join(tempDir, 'files');
      fs.mkdirSync(filesDir, { recursive: true });
      const targetFile = safePath.join(filesDir, 'My Document Name.pdf');
      const sourceFile = safePath.join(tempDir, 'index.md');

      try {
        fs.writeFileSync(targetFile, 'fake pdf content');
        fs.writeFileSync(sourceFile, '');

        const link = createLink('local_file', 'files/My%20Document%20Name.pdf', 'PDF link', 3);
        const headingsMap = fragmentIndex();

        const result = await validateLink(link, sourceFile, headingsMap);

        expect(result).toBeNull();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('anchor links', () => {
    it('should validate valid anchor in current file', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      await assertValidation(
        {
          sourceFile,
          link: createLink('anchor', '#heading-anchor', 'Anchor link', 5),
          headingsMap: makeAnchorHeadingsMap(sourceFile),
          expected: null,
        },
        expect,
      );
    });

    it('should detect broken anchor in current file', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      await assertValidation(
        {
          sourceFile,
          link: createLink('anchor', NONEXISTENT_ANCHOR, 'Broken anchor', 10),
          headingsMap: makeAnchorHeadingsMap(sourceFile),
          expected: {
            code: 'LINK_BROKEN_ANCHOR',
            messageContains: ['Anchor not found', NONEXISTENT_ANCHOR],
          },
        },
        expect,
      );
    });

    it('should perform case-insensitive anchor matching', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      await assertValidation(
        {
          sourceFile,
          link: createLink('anchor', '#HEADING-ANCHOR', 'Case mismatch', 5),
          headingsMap: makeAnchorHeadingsMap(sourceFile),
          expected: null,
        },
        expect,
      );
    });

    it('should validate anchors in nested headings', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, 'complex.md');
      const link = createLink('anchor', '#nested-child', 'Nested heading', 10);

      const headingsMap = fragmentIndex([
        [sourceFile, new Set(['parent-heading', 'nested-child'])],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should return error when file has no headings', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      await assertValidation(
        {
          sourceFile: safePath.join(FIXTURES_DIR, VALID_MD),
          link: createLink('anchor', '#any-heading', 'No headings', 5),
          headingsMap: fragmentIndex([[safePath.join(FIXTURES_DIR, VALID_MD), new Set<string>()]]),
          expected: {
            code: 'LINK_BROKEN_ANCHOR',
          },
        },
        expect,
      );
    });
  });

  describe('external links', () => {
    it('should return null for HTTP URL (external links not validated)', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('external', 'http://example.com', 'HTTP link', 6);
      const headingsMap = fragmentIndex();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should return null for HTTPS URL (external links not validated)', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('external', 'https://example.com/path', 'HTTPS link', 7);
      const headingsMap = fragmentIndex();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });
  });

  describe('email links', () => {
    it('should return null for valid email', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('email', 'mailto:test@example.com', 'Email link', 8);
      const headingsMap = fragmentIndex();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should return null for email without mailto:', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('email', 'test@example.com', 'Plain email', 9);
      const headingsMap = fragmentIndex();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });
  });

  describe('unknown link types', () => {
    it('should return warning for unknown protocol', async () => {
      expect(true).toBe(true); // Assertion for SonarJS (assertValidation performs detailed assertions)
      await assertValidation(
        {
          sourceFile: safePath.join(FIXTURES_DIR, VALID_MD),
          link: createLink('unknown', 'ftp://example.com/file', 'FTP link', 10),
          headingsMap: fragmentIndex(),
          expected: {
            code: 'LINK_UNKNOWN',
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
          sourceFile: safePath.join(FIXTURES_DIR, VALID_MD),
          link: createLink('unknown', 'tel:+1234567890', 'Tel link', 11),
          headingsMap: fragmentIndex(),
          expected: {
            code: 'LINK_UNKNOWN',
          },
        },
        expect,
      );
    });
  });

  describe('cross-platform path handling', () => {
    it('should handle Unix-style paths', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('local_file', TARGET_FILE_LINK, 'Unix path');
      const headingsMap = fragmentIndex();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should handle paths with mixed separators', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      // Node's path.resolve will normalize this correctly on all platforms
      const link = createLink('local_file', './subdir/nested.md', 'Mixed path');
      const headingsMap = fragmentIndex();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle link without line number', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('anchor', '#heading-anchor', 'No line number');
      delete link.line;

      const headingsMap = fragmentIndex([
        [sourceFile, new Set(['heading-anchor'])],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should handle empty anchor after #', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('anchor', '#', 'Empty anchor', 5);

      const headingsMap = fragmentIndex([
        [sourceFile, new Set(['heading'])],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).not.toBeNull();
      expect(result?.code).toBe('LINK_BROKEN_ANCHOR');
    });

    it('should handle file path with anchor where file does not exist', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('local_file', './nonexistent.md#heading', 'Broken file with anchor', 5);
      const headingsMap = fragmentIndex();

      const result = await validateLink(link, sourceFile, headingsMap);

      // Should fail on file check, not anchor check
      expect(result).not.toBeNull();
      expect(result?.code).toBe('LINK_BROKEN_FILE');
    });

    it('should handle file with only anchor (empty file path)', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      // The parser classifies anchor-only hrefs as 'anchor', not 'local_file'.
      // If a synthetic ResourceLink slips through with type='local_file' and an
      // anchor-only href, validateLocalFileLink returns null (treats it as
      // valid no-op) instead of synthesizing a broken_file against cwd.
      const link = createLink('local_file', '#heading', 'Anchor as file', 5);

      const targetFile = safePath.join(FIXTURES_DIR, 'target.md');
      const headingsMap = fragmentIndex([
        [targetFile, new Set(['heading'])],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });

    it('should handle multiple nested levels', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, 'complex.md');
      const link = createLink('anchor', '#deeply-nested', 'Deep nesting', 20);

      const headingsMap = fragmentIndex([
        [sourceFile, new Set(['level-1', 'level-2', 'level-3', 'deeply-nested'])],
      ]);

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).toBeNull();
    });
  });

  describe('validation issue structure', () => {
    it('should include all required fields in error issue', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, BROKEN_FILE_MD);
      const link = createLink('local_file', NONEXISTENT_FILE_LINK, 'Broken', 3);
      const headingsMap = fragmentIndex();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result).not.toBeNull();
      expect(result).toHaveProperty('location');
      expect(result).toHaveProperty('line');
      expect(result).toHaveProperty('code');
      expect(result).toHaveProperty('link');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('suggestion');

      expect(result?.location).toBe(sourceFile);
      expect(result?.line).toBe(3);
      expect(result?.link).toBe(NONEXISTENT_FILE_LINK);
    });

    it('should include empty suggestion in broken file issue', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, BROKEN_FILE_MD);
      const link = createLink('local_file', NONEXISTENT_FILE_LINK, 'Broken');
      const headingsMap = fragmentIndex();

      const result = await validateLink(link, sourceFile, headingsMap);

      expect(result?.suggestion).toBeDefined();
      expect(result?.suggestion).toBe('');
    });

    it('should include empty suggestion in broken anchor issue', async () => {
      const sourceFile = safePath.join(FIXTURES_DIR, VALID_MD);
      const link = createLink('anchor', NONEXISTENT_ANCHOR, 'Broken');
      const headingsMap = fragmentIndex([
        [sourceFile, new Set(['valid'])],
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
      tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'link-validator-gitignore-'));
      gitRoot = tempDir;

      // Initialize git repo properly (git check-ignore needs a real repo)
      createGitRepo(gitRoot);
    });

    afterEach(async () => {
      const fs = await import('node:fs');
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should return error for links to gitignored files', async () => {
      const fs = await import('node:fs');

      // Create .gitignore file
      const gitignorePath = safePath.join(gitRoot, GITIGNORE_FILE);
      fs.writeFileSync(gitignorePath, 'ignored.md\n');

      // Create gitignored file
      const ignoredFile = safePath.join(gitRoot, 'ignored.md');
      fs.writeFileSync(ignoredFile, '# Ignored');

      // Create source file
      const sourceFile = safePath.join(gitRoot, 'source.md');
      fs.writeFileSync(sourceFile, '# Source');

      await assertGitignoreError(gitRoot, './ignored.md', 'Link to ignored');
    });

    it('should pass for links to non-gitignored files in git repo', async () => {
      const fs = await import('node:fs');

      // Create .gitignore file (ignoring other files)
      const gitignorePath = safePath.join(gitRoot, GITIGNORE_FILE);
      fs.writeFileSync(gitignorePath, 'other.md\n');

      // Create non-gitignored file
      const targetFile = safePath.join(gitRoot, 'target.md');
      fs.writeFileSync(targetFile, '# Target');

      // Create source file
      const sourceFile = safePath.join(gitRoot, 'source.md');
      fs.writeFileSync(sourceFile, '# Source');

      const link = createLink('local_file', TARGET_FILE_LINK, 'Link to target', 1);
      const headingsMap = fragmentIndex();

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

    it('should return error for links to gitignored directories', async () => {
      const fs = await import('node:fs');

      // Create .gitignore file
      const gitignorePath = safePath.join(gitRoot, GITIGNORE_FILE);
      fs.writeFileSync(gitignorePath, 'private/\n');

      // Create gitignored directory with file
      const privateDir = safePath.join(gitRoot, 'private');
      mkdirSyncReal(privateDir);
      const ignoredFile = safePath.join(privateDir, 'secret.md');
      fs.writeFileSync(ignoredFile, '# Secret');

      // Create source file
      const sourceFile = safePath.join(gitRoot, 'source.md');
      fs.writeFileSync(sourceFile, '# Source');

      await assertGitignoreError(gitRoot, './private/secret.md', 'Link to secret');
    });
  });

  describe('cross-format anchor validation', () => {
    const suite = setupSubdirTestSuite('cross-format-suite-');

    beforeAll(suite.beforeAll);
    afterAll(suite.afterAll);
    beforeEach(suite.beforeEach);

    it('validates markdown → HTML anchors and flags missing ones', async () => {
      // guide.md links to page.html#intro (valid) and page.html#nope (broken)
      await writeFile(
        safePath.join(suite.tempDir, 'guide.md'),
        '[a](./page.html#intro)\n[b](./page.html#nope)\n',
        'utf-8',
      );
      await writeFile(
        safePath.join(suite.tempDir, 'page.html'),
        '<html><body><h2 id="intro">Intro</h2></body></html>',
        'utf-8',
      );

      const result = await crawlAndValidate(suite.tempDir);

      const brokenAnchors = result.issues.filter((i) => i.code === 'LINK_BROKEN_ANCHOR');
      // Only #nope should be flagged; #intro is a valid HTML id
      expect(brokenAnchors).toHaveLength(1);
      expect(brokenAnchors[0]?.message).toContain('nope');
    });

    it('validates HTML → markdown anchors (zero broken-anchor)', async () => {
      // page.html links to guide.md#my-heading — heading slug matches
      await writeFile(
        safePath.join(suite.tempDir, 'page.html'),
        '<html><body><a href="./guide.md#my-heading">x</a></body></html>',
        'utf-8',
      );
      await writeFile(
        safePath.join(suite.tempDir, 'guide.md'),
        '## My Heading\n',
        'utf-8',
      );

      const result = await crawlAndValidate(suite.tempDir);

      const brokenAnchors = result.issues.filter((i) => i.code === 'LINK_BROKEN_ANCHOR');
      expect(brokenAnchors).toHaveLength(0);
    });

    it('skips anchor check for a non-indexed target file', async () => {
      // doc.md links to external.md#whatever — external.md is NOT present/crawled
      await writeFile(
        safePath.join(suite.tempDir, 'doc.md'),
        '[x](./external.md#whatever)\n',
        'utf-8',
      );
      // external.md intentionally absent

      const result = await crawlAndValidate(suite.tempDir);

      const brokenFiles = result.issues.filter((i) => i.code === 'LINK_BROKEN_FILE');
      const brokenAnchors = result.issues.filter((i) => i.code === 'LINK_BROKEN_ANCHOR');

      // The file is missing → LINK_BROKEN_FILE emitted
      expect(brokenFiles.length).toBeGreaterThan(0);
      // But no LINK_BROKEN_ANCHOR — target is un-indexed so anchor check is skipped
      expect(brokenAnchors).toHaveLength(0);
    });
  });

  describe('leading-/ links (RFC 3986 §4.2 absolute-path reference)', () => {
    let projectRoot: string;
    let sourceFile: string;

    beforeEach(async () => {
      const fs = await import('node:fs');
      projectRoot = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'leading-slash-'));
      // realpath to avoid macOS /private symlink mismatch with isWithinProject
      projectRoot = fs.realpathSync(projectRoot);
      const docsSub = safePath.join(projectRoot, 'docs', 'sub');
      fs.mkdirSync(docsSub, { recursive: true });
      const targetFile = safePath.join(projectRoot, 'docs', 'foo.md');
      sourceFile = safePath.join(docsSub, 'page.md');
      fs.writeFileSync(targetFile, '# Foo\n\n## Section A\n');
      fs.writeFileSync(sourceFile, '# Page\n');
    });

    afterEach(async () => {
      const fs = await import('node:fs');
      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it('resolves /docs/foo.md against projectRoot', async () => {
      const link = createLink('local_file', '/docs/foo.md', 'Leading slash', 1);
      const result = await validateLink(link, sourceFile, fragmentIndex(), {
        projectRoot,
        skipGitIgnoreCheck: true,
      });
      expect(result).toBeNull();
    });

    it('emits absolute_no_root broken_file when projectRoot is undefined', async () => {
      const link = createLink('local_file', '/docs/foo.md', 'Leading slash', 1);
      const result = await validateLink(link, sourceFile, fragmentIndex(), {
        skipGitIgnoreCheck: true,
      });
      expect(result).not.toBeNull();
      expect(result?.code).toBe('LINK_BROKEN_FILE');
      expect(result?.message).toContain('requires a configured projectRoot');
    });

    it('emits absolute_escapes_root broken_file when leading-/ escapes projectRoot', async () => {
      const link = createLink('local_file', '/../escape.md', 'Escape', 1);
      const result = await validateLink(link, sourceFile, fragmentIndex(), {
        projectRoot,
        skipGitIgnoreCheck: true,
      });
      expect(result).not.toBeNull();
      expect(result?.code).toBe('LINK_BROKEN_FILE');
      expect(result?.message).toContain('escapes the project root via path traversal');
    });

    it('resolves anchor on leading-/ link', async () => {
      const link = createLink('local_file', '/docs/foo.md#section-a', 'Leading slash anchor', 1);
      const headings = fragmentIndex([
        [
          safePath.join(projectRoot, 'docs', 'foo.md'),
          new Set(['foo', 'section-a']),
        ],
      ]);
      const result = await validateLink(link, sourceFile, headings, {
        projectRoot,
        skipGitIgnoreCheck: true,
      });
      expect(result).toBeNull();
    });

    it('treats existing directory as valid target (leading-/ href)', async () => {
      // /docs/ resolves to projectRoot/docs (an existing directory). Per #126,
      // a directory is a valid navigational link target.
      await assertValidation(
        {
          sourceFile,
          link: createLink('local_directory', '/docs/', 'Directory target', 1),
          headingsMap: fragmentIndex(),
          expected: null,
          validationOptions: { projectRoot, skipGitIgnoreCheck: true },
        },
        expect,
      );
    });

    it('treats existing directory as valid target (relative href)', async () => {
      // sourceFile is in projectRoot/docs/sub; ../  resolves to projectRoot/docs.
      await assertValidation(
        {
          sourceFile,
          link: createLink('local_directory', '../', 'Relative directory target', 1),
          headingsMap: fragmentIndex(),
          expected: null,
          validationOptions: { projectRoot, skipGitIgnoreCheck: true },
        },
        expect,
      );
    });

    it('treats slashless directory-shaped href as valid when target exists', async () => {
      // `/docs` (no trailing slash) is shape-ambiguous (local_file by
      // classification); once resolved to a directory it is treated identically
      // to `/docs/`.
      await assertValidation(
        {
          sourceFile,
          link: createLink('local_file', '/docs', 'Slashless directory target', 1),
          headingsMap: fragmentIndex(),
          expected: null,
          validationOptions: { projectRoot, skipGitIgnoreCheck: true },
        },
        expect,
      );
    });

    it('emits broken_file when a directory-shaped href targets a missing path', async () => {
      // Regression guard: existence checking still fires; missing directories
      // are LINK_BROKEN_FILE (not a directory error).
      await assertValidation(
        {
          sourceFile,
          link: createLink('local_directory', '/missing-dir/', 'Missing directory', 1),
          headingsMap: fragmentIndex(),
          expected: { code: 'LINK_BROKEN_FILE', messageContains: 'File not found' },
          validationOptions: { projectRoot, skipGitIgnoreCheck: true },
        },
        expect,
      );
    });
  });
});
