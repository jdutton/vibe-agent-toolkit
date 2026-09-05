
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Integration tests for ResourceRegistry
 *
 * Tests resource addition, crawling, validation, link resolution, and query operations
 * using real test fixtures.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- tests use dynamic file paths in temp directory */

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ResourceMetadata } from '../../src/types.js';
import { findPackageRoot, setupSubdirTestSuite } from '../test-helpers.js';

// Get test fixtures directory
const packageRoot = findPackageRoot(import.meta.dirname);
const fixturesDir = safePath.join(packageRoot, 'test-fixtures');

// Constants for commonly used file names and patterns (avoid string duplication)
const BROKEN_FILE_MD = 'broken-file.md';
const BROKEN_FILE_ID = 'broken-file-md';
const EXTERNAL_MD = 'external.md';
const VALID_MD_PATTERN = '**/valid.md';
const NESTED_FILE_ID = 'subdir-nested-md';

/**
 * Write a `toolbox.md` target and a `guide.md` source into `dir`, validate both
 * as one registry, and return every LINK_BROKEN_ANCHOR message.
 */
async function validateAnchorPair(dir: string, target: string, source: string): Promise<string[]> {
  const targetPath = safePath.join(dir, 'toolbox.md');
  const sourcePath = safePath.join(dir, 'guide.md');
  await writeFile(targetPath, target, 'utf-8');
  await writeFile(sourcePath, source, 'utf-8');

  const registry = new ResourceRegistry({ baseDir: dir });
  await registry.addResources([targetPath, sourcePath]);
  const result = await registry.validate();

  return result.issues.filter((i) => i.code === 'LINK_BROKEN_ANCHOR').map((i) => i.message);
}

// Helper to extract resource IDs (avoids nested arrow functions in tests)
function extractResourceIds(resources: ResourceMetadata[]): string[] {
  return resources.map((r) => r.id);
}

// Helper to check if all resources have required properties
function allResourcesHaveIdAndPath(resources: ResourceMetadata[]): boolean {
  return resources.every((r) => Boolean(r.id && r.filePath));
}

/** Create two readme.md files in dir1/ and dir2/ under the given base directory */
async function createDuplicateNamedFiles(baseDirectory: string): Promise<void> {
  await mkdir(safePath.join(baseDirectory, 'dir1'), { recursive: true });
  await mkdir(safePath.join(baseDirectory, 'dir2'), { recursive: true });
  await writeFile(safePath.join(baseDirectory, 'dir1', 'readme.md'), '# Dir 1', 'utf-8');
  await writeFile(safePath.join(baseDirectory, 'dir2', 'readme.md'), '# Dir 2', 'utf-8');
}

/**
 * Validate a registry and assert exactly one `DUPLICATE_RESOURCE_ID` error issue,
 * returning it so the caller can assert on its message. Shared by the
 * duplicate-id collision tests to avoid repeating the validate/filter/assert tail.
 */
async function expectSingleDuplicateIdError(reg: ResourceRegistry) {
  const result = await reg.validate({ skipGitIgnoreCheck: true });
  const dupIssues = result.issues.filter((i) => i.code === 'DUPLICATE_RESOURCE_ID');
  expect(dupIssues).toHaveLength(1);
  const issue = dupIssues[0];
  expect(issue?.severity).toBe('error');
  return issue;
}

describe('ResourceRegistry - Integration Tests', () => {
  let registry: ResourceRegistry;

  beforeEach(() => {
    registry = new ResourceRegistry();
  });

  describe('Constructor and Initialization', () => {
    it('should create an empty registry', () => {
      expect(registry.getAllResources()).toHaveLength(0);
      const stats = registry.getStats();
      expect(stats.totalResources).toBe(0);
      expect(stats.totalLinks).toBe(0);
    });
  });

  describe('addResource()', () => {
    it('should add a single resource and parse it correctly', async () => {
      const validPath = safePath.join(fixturesDir, 'valid.md');
      const resource = await registry.addResource(validPath);

      expect(resource).toBeDefined();
      expect(resource.id).toBe('valid-md');
      expect(resource.filePath).toBe(validPath);
      expect(resource.links.length).toBeGreaterThan(0);
      expect(resource.headings.length).toBeGreaterThan(0);
      expect(resource.sizeBytes).toBeGreaterThan(0);
      expect(resource.estimatedTokenCount).toBeGreaterThan(0);
    });

    it('should store frontmatter in resource metadata', async () => {
      const registry = new ResourceRegistry();
      const mdPath = safePath.join(fixturesDir, 'with-frontmatter.md');

      const resource = await registry.addResource(mdPath);

      expect(resource.frontmatter).toEqual({
        title: 'Test Document',
        tags: ['test', 'example'],
        // YAML 1.2 CORE_SCHEMA keeps unquoted ISO dates as strings —
        // previous Date-object assertion codified the YAML 1.1 timestamp
        // promotion bug that broke schema validation for adopters.
        date: '2024-01-15',
      });
    });

    it('should generate correct IDs from file paths', async () => {
      const validPath = safePath.join(fixturesDir, 'valid.md');
      const brokenPath = safePath.join(fixturesDir, BROKEN_FILE_MD);

      const resource1 = await registry.addResource(validPath);
      const resource2 = await registry.addResource(brokenPath);

      expect(resource1.id).toBe('valid-md');
      expect(resource2.id).toBe(BROKEN_FILE_ID);
    });

    it('should allow re-adding the same file path', async () => {
      const validPath = safePath.join(fixturesDir, 'valid.md');

      const resource1 = await registry.addResource(validPath);
      expect(resource1.id).toBe('valid-md');

      // Re-adding same path should succeed (update in place)
      const resource2 = await registry.addResource(validPath);
      expect(resource2.id).toBe('valid-md');
      expect(registry.getResourceById('valid-md')).toBeDefined();
    });

    it('should normalize relative paths to absolute', async () => {
      // Use a relative path from CWD to the fixtures
      const absoluteFixturePath = safePath.join(fixturesDir, 'valid.md');
      const relativePath = safePath.relative(process.cwd(), absoluteFixturePath);

      const resource = await registry.addResource(relativePath);
      expect(path.isAbsolute(resource.filePath)).toBe(true);
      expect(resource.filePath).toBe(absoluteFixturePath);
    });

    it('should parse links correctly', async () => {
      const validPath = safePath.join(fixturesDir, 'valid.md');
      const resource = await registry.addResource(validPath);

      expect(resource.links).toHaveLength(4);

      // Check link types
      const linkTypes = resource.links.map((link) => link.type);
      expect(linkTypes).toContain('local_file');
      expect(linkTypes).toContain('anchor');
      expect(linkTypes).toContain('external');
    });

    it('should parse headings correctly', async () => {
      const validPath = safePath.join(fixturesDir, 'valid.md');
      const resource = await registry.addResource(validPath);

      expect(resource.headings.length).toBeGreaterThan(0);
      const firstHeading = resource.headings[0];
      expect(firstHeading?.level).toBe(1);
      expect(firstHeading?.text).toBeDefined();
      expect(firstHeading?.slug).toBeDefined();
    });
  });

  describe('addResources()', () => {
    it('should add multiple resources at once', async () => {
      const paths = [
        safePath.join(fixturesDir, 'valid.md'),
        safePath.join(fixturesDir, BROKEN_FILE_MD),
        safePath.join(fixturesDir, EXTERNAL_MD),
      ];

      const resources = await registry.addResources(paths);

      expect(resources).toHaveLength(3);
      expect(registry.getAllResources()).toHaveLength(3);
    });

    it('should process files in parallel', async () => {
      const paths = [
        safePath.join(fixturesDir, 'valid.md'),
        safePath.join(fixturesDir, 'target.md'),
      ];

      const startTime = Date.now();
      await registry.addResources(paths);
      const duration = Date.now() - startTime;

      // Should be much faster than sequential (rough check)
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('crawl()', () => {
    it('should crawl directory and find all markdown files', async () => {
      const resources = await registry.crawl({ baseDir: fixturesDir });

      // Should find all .md files in test-fixtures
      expect(resources.length).toBeGreaterThanOrEqual(6);

      const ids = resources.map((r) => r.id);
      expect(ids).toContain('valid-md');
      expect(ids).toContain(BROKEN_FILE_ID);
      expect(ids).toContain('target-md');
    });

    it('should respect include patterns', async () => {
      const resources = await registry.crawl({
        baseDir: fixturesDir,
        include: [VALID_MD_PATTERN],
      });

      expect(resources).toHaveLength(1);
      expect(resources[0]?.id).toBe('valid-md');
    });

    it('should respect exclude patterns', async () => {
      const resources = await registry.crawl({
        baseDir: fixturesDir,
        exclude: ['**/subdir/**', '**/node_modules/**'],
      });

      // Should exclude nested.md in subdir
      const ids = resources.map((r) => r.id);
      expect(ids).not.toContain(NESTED_FILE_ID);
    });

    it('should find nested files by default', async () => {
      const resources = await registry.crawl({ baseDir: fixturesDir });

      const ids = resources.map((r) => r.id);
      expect(ids).toContain(NESTED_FILE_ID);
    });

    it('should use default include/exclude patterns', async () => {
      const resources = await registry.crawl({ baseDir: fixturesDir });

      // Should find .md files
      expect(resources.length).toBeGreaterThan(0);

      // Should exclude node_modules, .git, dist (none exist in fixtures, but pattern applies)
      const paths = resources.map((r) => r.filePath);
      expect(paths.every((p) => !p.includes('node_modules'))).toBe(true);
    });
  });

  describe('validate()', () => {
    it('should validate all resources and return results', async () => {
      await registry.crawl({ baseDir: fixturesDir });

      const result = await registry.validate();

      expect(result).toBeDefined();
      expect(result.passed).toBeDefined();
      expect(result.errorCount).toBeDefined();
      expect(result.issues).toBeInstanceOf(Array);
      expect(result.totalResources).toBeDefined();
      expect(result.totalLinks).toBeDefined();
      expect(result.linksByType).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should detect broken file links', async () => {
      const brokenPath = safePath.join(fixturesDir, BROKEN_FILE_MD);
      await registry.addResource(brokenPath);

      const result = await registry.validate();

      expect(result.passed).toBe(false);
      expect(result.errorCount).toBeGreaterThan(0);

      const brokenFileIssue = result.issues.find((i) => i.code === 'LINK_BROKEN_FILE');
      expect(brokenFileIssue).toBeDefined();
      expect(brokenFileIssue?.message).toContain('File not found');
    });

    it('should detect broken anchor links', async () => {
      // Add both broken-anchor.md and target.md (target exists but anchor doesn't)
      await registry.addResource(safePath.join(fixturesDir, 'broken-anchor.md'));
      await registry.addResource(safePath.join(fixturesDir, 'target.md'));

      const result = await registry.validate();

      expect(result.passed).toBe(false);
      expect(result.errorCount).toBeGreaterThan(0);

      const brokenAnchorIssue = result.issues.find((i) => i.code === 'LINK_BROKEN_ANCHOR');
      expect(brokenAnchorIssue).toBeDefined();
      expect(brokenAnchorIssue?.message).toContain('Anchor not found');
    });

    it('should validate valid.md without errors', async () => {
      // Add all files that valid.md links to
      await registry.addResource(safePath.join(fixturesDir, 'valid.md'));
      await registry.addResource(safePath.join(fixturesDir, 'target.md'));
      await registry.addResource(safePath.join(fixturesDir, 'subdir/nested.md'));

      const result = await registry.validate();

      // Filter to only issues from valid.md
      const validIssues = result.issues.filter((i) => i.location?.endsWith('valid.md'));

      // Should have no errors from valid.md
      expect(validIssues).toHaveLength(0);
    });

    it('should report external links', async () => {
      await registry.addResource(safePath.join(fixturesDir, EXTERNAL_MD));

      const result = await registry.validate();

      // External links no longer generate issues - they're just skipped
      // Verify the file was scanned successfully
      expect(result.totalResources).toBeGreaterThan(0);
    });

    it('should provide statistics', async () => {
      await registry.crawl({ baseDir: fixturesDir });

      const result = await registry.validate();

      expect(result.totalResources).toBeGreaterThan(0);
      expect(result.totalLinks).toBeGreaterThan(0);
      expect(result.linksByType).toBeDefined();
      expect(result.linksByType['local_file']).toBeGreaterThan(0);
    });
  });

  describe('resolveLinks()', () => {
    it('should resolve local_file links to resource IDs', async () => {
      await registry.addResource(safePath.join(fixturesDir, 'valid.md'));
      await registry.addResource(safePath.join(fixturesDir, 'target.md'));
      await registry.addResource(safePath.join(fixturesDir, 'subdir/nested.md'));

      registry.resolveLinks();

      const validResource = registry.getResourceById('valid-md');
      expect(validResource).toBeDefined();

      const localFileLinks = validResource?.links.filter((link) => link.type === 'local_file');
      expect(localFileLinks).toBeDefined();
      expect(localFileLinks).not.toBeUndefined();
      if (!localFileLinks) throw new Error('localFileLinks is undefined');
      expect(localFileLinks.length).toBeGreaterThan(0);

      // Check that at least one link has resolvedId set
      const resolvedLinks = localFileLinks.filter((link) => link.resolvedId);
      expect(resolvedLinks.length).toBeGreaterThan(0);

      // Verify resolved IDs are correct
      const targetLink = localFileLinks?.find((link) => link.href.includes('target.md'));
      expect(targetLink?.resolvedId).toBe('target-md');
    });

    it('should not set resolvedId for non-existent targets', async () => {
      await registry.addResource(safePath.join(fixturesDir, BROKEN_FILE_MD));

      registry.resolveLinks();

      const brokenResource = registry.getResourceById(BROKEN_FILE_ID);
      const localFileLinks = brokenResource?.links.filter((link) => link.type === 'local_file');

      // Links to non-existent files should not have resolvedId
      expect(localFileLinks).toBeDefined();
      if (!localFileLinks) throw new Error('localFileLinks is undefined');
      const unresolvedLinks = localFileLinks.filter((link) => !link.resolvedId);
      expect(unresolvedLinks.length).toBeGreaterThan(0);
    });

    it('should resolve root-relative (RFC 3986 §4.2) hrefs against baseDir', async () => {
      // A leading-`/` href is a project-root-relative reference, NOT a filesystem
      // absolute path. The link-graph walker already resolves it that way (via
      // resolveLocalHref), so the target gets bundled — but if resolveLinks()
      // resolves it against the OS root instead, the link never gets a resolvedId
      // and the packager's bundled-link template strips the href, shipping a
      // bundled file that nothing references (PACKAGED_UNREFERENCED_FILE).
      const rootRelativeDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'root-relative-href-'));
      try {
        await mkdir(safePath.join(rootRelativeDir, 'docs/adrs'), { recursive: true });
        await mkdir(safePath.join(rootRelativeDir, 'docs/specs'), { recursive: true });

        const adrPath = safePath.join(rootRelativeDir, 'docs/adrs/boundary.md');
        const specPath = safePath.join(rootRelativeDir, 'docs/specs/design.md');
        await writeFile(adrPath, '# Boundary ADR\n', 'utf-8');
        await writeFile(specPath, 'See [the ADR](/docs/adrs/boundary.md).\n', 'utf-8');

        const rootRelativeRegistry = new ResourceRegistry({ baseDir: rootRelativeDir });
        await rootRelativeRegistry.addResources([adrPath, specPath]);
        rootRelativeRegistry.resolveLinks();

        const spec = rootRelativeRegistry.getResource(specPath);
        const adrLink = spec?.links.find((link) => link.href.includes('boundary.md'));

        expect(adrLink).toBeDefined();
        expect(adrLink?.resolvedId).toBe('docs-adrs-boundary-md');
      } finally {
        await rm(rootRelativeDir, { recursive: true, force: true });
      }
    });

    it('should mutate links in place', async () => {
      await registry.addResource(safePath.join(fixturesDir, 'valid.md'));
      await registry.addResource(safePath.join(fixturesDir, 'target.md'));

      const validResource = registry.getResourceById('valid-md');
      const originalLinks = validResource?.links;

      registry.resolveLinks();

      // Same object references
      expect(validResource?.links).toBe(originalLinks);

      // But now has resolvedId
      const targetLink = validResource?.links.find((link) => link.href.includes('target.md'));
      expect(targetLink?.resolvedId).toBe('target-md');
    });
  });

  describe('Query Methods', () => {
    beforeEach(async () => {
      await registry.crawl({ baseDir: fixturesDir });
    });

    describe('getResource()', () => {
      it('should get resource by absolute path', () => {
        const validPath = safePath.join(fixturesDir, 'valid.md');
        const resource = registry.getResource(validPath);

        expect(resource).toBeDefined();
        expect(resource?.id).toBe('valid-md');
      });

      it('should get resource by relative path', () => {
        // Use a relative path from CWD to the fixtures
        const absoluteFixturePath = safePath.join(fixturesDir, 'valid.md');
        const relativePath = safePath.relative(process.cwd(), absoluteFixturePath);

        const resource = registry.getResource(relativePath);

        expect(resource).toBeDefined();
        expect(resource?.id).toBe('valid-md');
      });

      it('should return undefined for non-existent path', () => {
        const resource = registry.getResource('/nonexistent/path.md');
        expect(resource).toBeUndefined();
      });
    });

    describe('getResourceById()', () => {
      it('should get resource by ID', () => {
        const resource = registry.getResourceById('valid-md');

        expect(resource).toBeDefined();
        expect(resource?.filePath).toContain('valid.md');
      });

      it('should return undefined for non-existent ID', () => {
        const resource = registry.getResourceById('nonexistent');
        expect(resource).toBeUndefined();
      });
    });

    describe('getAllResources()', () => {
      it('should return all resources', () => {
        const resources = registry.getAllResources();

        expect(resources.length).toBeGreaterThanOrEqual(6);
        // Use helper to avoid nested arrow function
        expect(allResourcesHaveIdAndPath(resources)).toBe(true);
      });

      it('should return empty array for empty registry', () => {
        const emptyRegistry = new ResourceRegistry();
        expect(emptyRegistry.getAllResources()).toHaveLength(0);
      });
    });

    describe('getResourcesByPattern()', () => {
      it('should match resources by glob pattern', () => {
        const resources = registry.getResourcesByPattern(VALID_MD_PATTERN);

        expect(resources).toHaveLength(1);
        expect(resources[0]?.id).toBe('valid-md');
      });

      it('should match multiple resources with wildcard', () => {
        const resources = registry.getResourcesByPattern('**/broken*.md');

        expect(resources.length).toBeGreaterThanOrEqual(2);
        // Extract ids mapping to avoid nested arrow function
        const resourceIds = extractResourceIds(resources);
        expect(resourceIds).toContain(BROKEN_FILE_ID);
        expect(resourceIds).toContain('broken-anchor-md');
      });

      it('should match nested files', () => {
        const resources = registry.getResourcesByPattern('**/subdir/**');

        expect(resources.length).toBeGreaterThanOrEqual(1);
        expect(resources[0]?.id).toBe(NESTED_FILE_ID);
      });

      it('should return empty array for no matches', () => {
        const resources = registry.getResourcesByPattern('**/nonexistent*.md');
        expect(resources).toHaveLength(0);
      });

      it('should work with Windows-style paths (cross-platform test)', async () => {
        // This test verifies that glob matching works even when stored paths use backslashes
        // On Unix: paths stored with forward slashes → no change needed
        // On Windows: paths stored with backslashes → converted to forward slashes for matching
        const resources = registry.getResourcesByPattern(VALID_MD_PATTERN);

        expect(resources.length).toBeGreaterThanOrEqual(1);
        // Should find valid.md regardless of platform path separator
      });
    });
  });

  describe('getStats()', () => {
    it('should return correct statistics', async () => {
      await registry.addResource(safePath.join(fixturesDir, 'valid.md'));
      await registry.addResource(safePath.join(fixturesDir, EXTERNAL_MD));

      const stats = registry.getStats();

      expect(stats.totalResources).toBe(2);
      expect(stats.totalLinks).toBeGreaterThan(0);
      expect(stats.linksByType).toBeDefined();
      expect(stats.linksByType['external']).toBeGreaterThan(0);
    });

    it('should count links by type correctly', async () => {
      await registry.crawl({ baseDir: fixturesDir });

      const stats = registry.getStats();

      expect(stats.linksByType['local_file']).toBeGreaterThan(0);
      expect(stats.linksByType['external']).toBeGreaterThan(0);
      expect(stats.linksByType['anchor']).toBeGreaterThan(0);
    });

    it('should return zero stats for empty registry', () => {
      const stats = registry.getStats();

      expect(stats.totalResources).toBe(0);
      expect(stats.totalLinks).toBe(0);
      expect(Object.keys(stats.linksByType)).toHaveLength(0);
    });
  });

  describe('clear()', () => {
    it('should clear all resources', async () => {
      await registry.crawl({ baseDir: fixturesDir });

      expect(registry.getAllResources().length).toBeGreaterThan(0);

      registry.clear();

      expect(registry.getAllResources()).toHaveLength(0);
      expect(registry.getResourceById('valid-md')).toBeUndefined();
      expect(registry.getStats().totalResources).toBe(0);
    });

    it('should allow adding resources after clear', async () => {
      await registry.addResource(safePath.join(fixturesDir, 'valid.md'));
      registry.clear();

      await registry.addResource(safePath.join(fixturesDir, 'target.md'));

      expect(registry.getAllResources()).toHaveLength(1);
      expect(registry.getResourceById('target-md')).toBeDefined();
    });
  });

  describe('validate with frontmatter schema', () => {
    const suite = setupSubdirTestSuite('frontmatter-suite-');

    beforeAll(suite.beforeAll);
    afterAll(suite.afterAll);
    beforeEach(suite.beforeEach);

    it('should validate frontmatter against schema and report missing required fields', async () => {
      const registry = new ResourceRegistry();

      // Add resource with valid frontmatter
      const validPath = safePath.join(fixturesDir, 'with-frontmatter.md');
      await registry.addResource(validPath);

      // Add resource without frontmatter
      const noFrontmatterPath = safePath.join(fixturesDir, 'target.md');
      await registry.addResource(noFrontmatterPath);

      const schema = {
        type: 'object',
        required: ['title', 'tags'],
        properties: {
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      };

      const result = await registry.validate({ frontmatterSchema: schema });

      // Should have 1 error for the file without frontmatter
      expect(result.errorCount).toBe(1);
      const error = result.issues.find((i) => i.code === 'FRONTMATTER_MISSING');
      expect(error).toBeDefined();
      expect(error?.message).toContain('title');
    });

    it('should report YAML syntax errors in frontmatter', async () => {
      const registry = new ResourceRegistry();

      // Create a file with invalid YAML
      const invalidYamlPath = safePath.join(suite.tempDir, 'invalid-yaml.md');
      await writeFile(
        invalidYamlPath,
        `---
title: Test Document
invalid: [unclosed bracket
tags: test
---

# Content
`
      );

      await registry.addResource(invalidYamlPath);

      const result = await registry.validate();

      // Should have 1 error for invalid YAML
      expect(result.errorCount).toBe(1);
      const error = result.issues.find((i) => i.code === 'FRONTMATTER_INVALID_YAML');
      expect(error).toBeDefined();
      expect(error?.message).toContain('Invalid YAML syntax');
    });
  });

  describe('Edge Cases', () => {
    it('should handle adding same file multiple times', async () => {
      const validPath = safePath.join(fixturesDir, 'valid.md');

      await registry.addResource(validPath);
      await registry.addResource(validPath);

      // Should overwrite (path map) but keep same ID
      expect(registry.getAllResources()).toHaveLength(1);
      expect(registry.getResourceById('valid-md')).toBeDefined();
    });

    it('should handle empty directories gracefully', async () => {
      // Create a temporary empty directory scenario by using non-matching pattern
      const resources = await registry.crawl({
        baseDir: fixturesDir,
        include: ['**/nonexistent-pattern.md'],
      });

      expect(resources).toHaveLength(0);
      expect(registry.getAllResources()).toHaveLength(0);
    });

    it('should handle resources with no links', async () => {
      // Assuming target.md might have minimal content
      await registry.addResource(safePath.join(fixturesDir, 'target.md'));

      const result = await registry.validate();

      // Should not error on resources with no links
      expect(result).toBeDefined();
    });

    it('should handle resources with no headings', async () => {
      // Any file should work, as headings are optional
      await registry.addResource(safePath.join(fixturesDir, EXTERNAL_MD));

      const resource = registry.getResourceById('external-md');
      expect(resource).toBeDefined();

      // Should handle validation even with no headings
      const result = await registry.validate();
      expect(result).toBeDefined();
    });
  });

  describe('ID Resolution Strategy', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'id-strategy-test-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    describe('path-relative IDs with baseDir', () => {
      it('should generate IDs from relative path when baseDir is set', async () => {
        await mkdir(safePath.join(tempDir, 'docs'), { recursive: true });
        await mkdir(safePath.join(tempDir, 'api'), { recursive: true });
        await writeFile(safePath.join(tempDir, 'docs', 'guide.md'), '# Guide', 'utf-8');
        await writeFile(safePath.join(tempDir, 'api', 'reference.md'), '# Reference', 'utf-8');

        const reg = new ResourceRegistry({ baseDir: tempDir });
        const r1 = await reg.addResource(safePath.join(tempDir, 'docs', 'guide.md'));
        const r2 = await reg.addResource(safePath.join(tempDir, 'api', 'reference.md'));

        expect(r1.id).toBe('docs-guide-md');
        expect(r2.id).toBe('api-reference-md');
      });

      it('should handle files at baseDir root without directory prefix', async () => {
        await writeFile(safePath.join(tempDir, 'readme.md'), '# Readme', 'utf-8');

        const reg = new ResourceRegistry({ baseDir: tempDir });
        const resource = await reg.addResource(safePath.join(tempDir, 'readme.md'));

        expect(resource.id).toBe('readme-md');
      });

      it('should avoid collisions for same-named files in different dirs', async () => {
        await createDuplicateNamedFiles(tempDir);

        const reg = new ResourceRegistry({ baseDir: tempDir });
        const r1 = await reg.addResource(safePath.join(tempDir, 'dir1', 'readme.md'));
        const r2 = await reg.addResource(safePath.join(tempDir, 'dir2', 'readme.md'));

        expect(r1.id).toBe('dir1-readme-md');
        expect(r2.id).toBe('dir2-readme-md');
      });

      it('should propagate baseDir from crawl() when not set on constructor', async () => {
        await createDuplicateNamedFiles(tempDir);

        // Create registry WITHOUT baseDir, then crawl WITH baseDir
        const reg = new ResourceRegistry();
        expect(reg.baseDir).toBeUndefined();

        await reg.crawl({ baseDir: tempDir, include: ['**/*.md'] });

        // crawl should have propagated baseDir
        expect(reg.baseDir).toBe(tempDir);

        // IDs should be path-relative, not filename stems
        const r1 = reg.getResourceById('dir1-readme-md');
        const r2 = reg.getResourceById('dir2-readme-md');
        expect(r1).toBeDefined();
        expect(r2).toBeDefined();
      });

      it('should handle deeply nested paths', async () => {
        await mkdir(safePath.join(tempDir, 'concepts', 'core'), { recursive: true });
        await writeFile(safePath.join(tempDir, 'concepts', 'core', 'overview.md'), '# Overview', 'utf-8');

        const reg = new ResourceRegistry({ baseDir: tempDir });
        const resource = await reg.addResource(safePath.join(tempDir, 'concepts', 'core', 'overview.md'));

        expect(resource.id).toBe('concepts-core-overview-md');
      });
    });

    describe('frontmatter ID with idField', () => {
      it('should use frontmatter field as ID when idField is configured', async () => {
        await writeFile(
          safePath.join(tempDir, 'doc.md'),
          '---\nslug: my-custom-id\n---\n# Doc',
          'utf-8'
        );

        const reg = new ResourceRegistry({ idField: 'slug' });
        const resource = await reg.addResource(safePath.join(tempDir, 'doc.md'));

        expect(resource.id).toBe('my-custom-id');
      });

      it('should fall back to filename stem when frontmatter field is missing', async () => {
        await writeFile(safePath.join(tempDir, 'doc.md'), '# No frontmatter', 'utf-8');

        const reg = new ResourceRegistry({ idField: 'slug' });
        const resource = await reg.addResource(safePath.join(tempDir, 'doc.md'));

        expect(resource.id).toBe('doc-md');
      });

      it('should fall back to path-based ID when idField not in frontmatter but baseDir set', async () => {
        await mkdir(safePath.join(tempDir, 'guides'), { recursive: true });
        await writeFile(
          safePath.join(tempDir, 'guides', 'intro.md'),
          '---\ntitle: Intro\n---\n# Intro',
          'utf-8'
        );

        const reg = new ResourceRegistry({ baseDir: tempDir, idField: 'slug' });
        const resource = await reg.addResource(safePath.join(tempDir, 'guides', 'intro.md'));

        // No 'slug' in frontmatter → falls back to path-relative ID
        expect(resource.id).toBe('guides-intro-md');
      });

      it('should prioritize frontmatter ID over path-based ID', async () => {
        await mkdir(safePath.join(tempDir, 'deep', 'path'), { recursive: true });
        await writeFile(
          safePath.join(tempDir, 'deep', 'path', 'doc.md'),
          '---\nslug: custom\n---\n# Doc',
          'utf-8'
        );

        const reg = new ResourceRegistry({ baseDir: tempDir, idField: 'slug' });
        const resource = await reg.addResource(safePath.join(tempDir, 'deep', 'path', 'doc.md'));

        // Frontmatter takes priority over 'deep-path-doc'
        expect(resource.id).toBe('custom');
      });
    });

    describe('duplicate detection', () => {
      it('should throw when two files produce the same frontmatter ID', async () => {
        await writeFile(
          safePath.join(tempDir, 'a.md'),
          '---\nslug: same-id\n---\n# A',
          'utf-8'
        );
        await writeFile(
          safePath.join(tempDir, 'b.md'),
          '---\nslug: same-id\n---\n# B',
          'utf-8'
        );

        const reg = new ResourceRegistry({ idField: 'slug' });
        await reg.addResource(safePath.join(tempDir, 'a.md'));
        await expect(
          reg.addResource(safePath.join(tempDir, 'b.md'))
        ).rejects.toThrow(/Duplicate resource ID 'same-id'/);
      });

      it('should throw when frontmatter ID collides with path-based ID', async () => {
        // first.md has no slug → path-based id = 'first-md'
        await writeFile(safePath.join(tempDir, 'first.md'), '# First', 'utf-8');
        // second.md has slug: first-md → frontmatter id = 'first-md' → collision
        await writeFile(
          safePath.join(tempDir, 'second.md'),
          '---\nslug: first-md\n---\n# Second',
          'utf-8'
        );

        const reg = new ResourceRegistry({ idField: 'slug' });
        await reg.addResource(safePath.join(tempDir, 'first.md')); // ID = 'first-md'
        await expect(
          reg.addResource(safePath.join(tempDir, 'second.md')) // frontmatter slug = 'first-md'
        ).rejects.toThrow(/Duplicate resource ID 'first-md'/);
      });

      it('should throw on duplicate resource ID from different files without baseDir', async () => {
        await createDuplicateNamedFiles(tempDir);

        const reg = new ResourceRegistry();
        await reg.addResource(safePath.join(tempDir, 'dir1', 'readme.md'));
        await expect(
          reg.addResource(safePath.join(tempDir, 'dir2', 'readme.md'))
        ).rejects.toThrow(/Duplicate resource ID 'readme-md'/);
      });

      it('should detect duplicates in fromResources', () => {
        // Use type assertion for branded checksum type
        const fakeChecksum = 'a'.repeat(64) as unknown as ResourceMetadata['checksum'];
        const resource1: ResourceMetadata = {
          id: 'readme',
          filePath: '/a/readme.md',
          links: [],
          headings: [],
          sizeBytes: 10,
          estimatedTokenCount: 3,
          modifiedAt: new Date(),
          checksum: fakeChecksum,
        };
        const resource2: ResourceMetadata = {
          ...resource1,
          filePath: '/b/readme.md',
        };

        expect(() =>
          ResourceRegistry.fromResources(tempDir, [resource1, resource2])
        ).toThrow(/Duplicate resource ID 'readme'/);
      });

      it('should record duplicate-id collisions in addResources and surface them via validate()', async () => {
        await createDuplicateNamedFiles(tempDir);

        // Without baseDir, both produce 'readme-md' → duplicate.
        // addResources() now captures the collision rather than throwing; the
        // first-added file wins and the second is skipped. validate() surfaces
        // the collision as a DUPLICATE_RESOURCE_ID error.
        const reg = new ResourceRegistry();
        await expect(
          reg.addResources([
            safePath.join(tempDir, 'dir1', 'readme.md'),
            safePath.join(tempDir, 'dir2', 'readme.md'),
          ])
        ).resolves.not.toThrow();

        const issue = await expectSingleDuplicateIdError(reg);
        expect(issue?.message).toMatch(/readme-md/);
      });
    });
  });

  describe('HTML resource discovery', () => {
    let htmlTempDir: string;

    beforeEach(async () => {
      htmlTempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'html-discovery-test-'));
    });

    afterEach(async () => {
      await rm(htmlTempDir, { recursive: true, force: true });
    });

    it('discovers and parses HTML resources', async () => {
      await writeFile(
        safePath.join(htmlTempDir, 'page.html'),
        '<a href="./next.html">n</a>',
        'utf-8',
      );
      const reg = new ResourceRegistry({ baseDir: htmlTempDir });
      await reg.crawl({ baseDir: htmlTempDir });
      const html = reg.getAllResources().find((r) => r.filePath.endsWith('page.html'));
      expect(html).toBeDefined();
      expect(html?.links.map((l) => l.href)).toContain('./next.html');
    });

    it('produces distinct ids for foo.md and foo.html in the same directory', async () => {
      // Acceptance test: the original crash was caused by foo.md and foo.html
      // colliding on the same bare id. With extension suffixes they are distinct.
      await writeFile(safePath.join(htmlTempDir, 'foo.md'), '# Foo md', 'utf-8');
      await writeFile(safePath.join(htmlTempDir, 'foo.html'), '<h1>Foo html</h1>', 'utf-8');

      const reg = new ResourceRegistry({ baseDir: htmlTempDir });
      // Must not throw
      await reg.crawl({ baseDir: htmlTempDir });

      const resources = reg.getAllResources();
      const ids = resources.map((r) => r.id);
      expect(ids).toContain('foo-md');
      expect(ids).toContain('foo-html');
      // Confirm they are truly distinct (no deduplication / crash)
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('emits MALFORMED_HTML info issues for HTML parse errors', async () => {
      // A malformed HTML file: unclosed <p> tag triggers a parse5 diagnostic
      await writeFile(
        safePath.join(htmlTempDir, 'bad.html'),
        '<html><body><p>unclosed</body></html>',
        'utf-8',
      );
      const reg = new ResourceRegistry({ baseDir: htmlTempDir });
      await reg.crawl({ baseDir: htmlTempDir });
      const result = await reg.validate({ skipGitIgnoreCheck: true });

      const malformedIssues = result.issues.filter((i) => i.code === 'MALFORMED_HTML');
      expect(malformedIssues.length).toBeGreaterThan(0);
      expect(malformedIssues[0]?.severity).toBe('info');
    });
  });

  describe('Duplicate resource ID (graceful handling)', () => {
    let dupTempDir: string;

    beforeEach(async () => {
      dupTempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'dup-id-test-'));
    });

    afterEach(async () => {
      await rm(dupTempDir, { recursive: true, force: true });
    });

    it('crawl() does not throw and validate() emits DUPLICATE_RESOURCE_ID error when two same-extension files produce the same id', async () => {
      // 'My Guide.md' and 'my-guide.md' both normalise to 'my-guide-md' after Task 1's
      // extension suffix. This is the canonical same-extension collision scenario.
      await writeFile(safePath.join(dupTempDir, 'My Guide.md'), '# My Guide', 'utf-8');
      await writeFile(safePath.join(dupTempDir, 'my-guide.md'), '# my guide', 'utf-8');

      const reg = new ResourceRegistry({ baseDir: dupTempDir });

      // crawl() must not throw
      await expect(reg.crawl({ baseDir: dupTempDir })).resolves.not.toThrow();

      const issue = await expectSingleDuplicateIdError(reg);
      // Message must name both colliding paths and the shared id
      expect(issue?.message).toMatch(/my-guide-md/);
      expect(issue?.message).toMatch(/My Guide\.md/);
      expect(issue?.message).toMatch(/my-guide\.md/);
    });

    it('addResources() does not throw and validate() emits DUPLICATE_RESOURCE_ID with correct paths when two files collide via idField frontmatter slug', async () => {
      // Both files declare the same frontmatter slug value → same idField-derived ID.
      // Before the fix the catch block re-derived the id via generateIdFromPath, which
      // would produce 'beta-md' (not 'shared-slug'), so resourcesById.get('beta-md')
      // returned undefined and existingPath was recorded as '' — making the emitted
      // DUPLICATE_RESOURCE_ID issue report an empty existingPath.
      const fileA = safePath.join(dupTempDir, 'alpha.md');
      const fileB = safePath.join(dupTempDir, 'beta.md');
      await writeFile(fileA, '---\nslug: shared-slug\n---\n# Alpha', 'utf-8');
      await writeFile(fileB, '---\nslug: shared-slug\n---\n# Beta', 'utf-8');

      const reg = new ResourceRegistry({ baseDir: dupTempDir, idField: 'slug' });

      // addResources() must not throw
      await expect(reg.addResources([fileA, fileB])).resolves.not.toThrow();

      const issue = await expectSingleDuplicateIdError(reg);
      // The reported id must be the frontmatter slug, NOT a path-derived id
      expect(issue?.message).toMatch(/shared-slug/);
      // Both file names must appear — existingPath must not be '' (the pre-fix bug)
      expect(issue?.message).toMatch(/alpha\.md/);
      expect(issue?.message).toMatch(/beta\.md/);
    });
  });

  // An adopter placed `<a id="materialize"></a>` above a long heading and
  // linked to `#materialize` from another document. GitHub renders the id into
  // the DOM and the fragment resolves; VAT indexed heading slugs only and
  // reported LINK_BROKEN_ANCHOR, so they repointed a working link at the long
  // slug to appease the tool.
  describe('explicit HTML anchors in markdown', () => {
    const suite = setupSubdirTestSuite('html-anchor-suite-');

    beforeAll(suite.beforeAll);
    afterAll(suite.afterAll);
    beforeEach(suite.beforeEach);

    const TARGET_WITH_ID = [
      '<a id="materialize"></a>',
      '',
      '## Materialize the warehouse snapshot into a local DuckDB file',
      '',
      'Body.',
      '',
    ].join('\n');

    it('resolves a cross-file link to an explicit id', async () => {
      const broken = await validateAnchorPair(
        suite.tempDir,
        TARGET_WITH_ID,
        '# Guide\n\nSee [materialize](toolbox.md#materialize).\n',
      );

      expect(broken).toEqual([]);
    });

    it('resolves a same-file link to an explicit id', async () => {
      const broken = await validateAnchorPair(
        suite.tempDir,
        `${TARGET_WITH_ID}\nJump back to [the step](#materialize).\n`,
        '# Guide\n\nNo links.\n',
      );

      expect(broken).toEqual([]);
    });

    it('still reports a fragment that matches no heading and no id', async () => {
      const broken = await validateAnchorPair(
        suite.tempDir,
        TARGET_WITH_ID,
        '# Guide\n\nSee [nope](toolbox.md#materialise).\n',
      );

      expect(broken).toHaveLength(1);
      expect(broken[0]).toContain('materialise');
    });
  });
});
