/**
 * Integration tests for ResourceRegistry
 *
 * Tests resource addition, crawling, validation, link resolution, and query operations
 * using real test fixtures.
 */

import path from 'node:path';

import { describe, expect, it, beforeEach } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ResourceMetadata } from '../../src/types.js';
import { findPackageRoot } from '../test-helpers.js';

// Get test fixtures directory
const packageRoot = findPackageRoot(import.meta.dirname);
const fixturesDir = path.join(packageRoot, 'test-fixtures');

// Constants for commonly used file names and patterns (avoid string duplication)
const BROKEN_FILE_MD = 'broken-file.md';
const BROKEN_FILE_ID = 'broken-file';
const EXTERNAL_MD = 'external.md';
const VALID_MD_PATTERN = '**/valid.md';

// Helper to extract resource IDs (avoids nested arrow functions in tests)
function extractResourceIds(resources: ResourceMetadata[]): string[] {
  return resources.map((r) => r.id);
}

// Helper to check if all resources have required properties
function allResourcesHaveIdAndPath(resources: ResourceMetadata[]): boolean {
  return resources.every((r) => Boolean(r.id && r.filePath));
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

    it('should accept validateOnAdd option', () => {
      const registryWithValidation = new ResourceRegistry({ validateOnAdd: false });
      expect(registryWithValidation).toBeDefined();
    });
  });

  describe('addResource()', () => {
    it('should add a single resource and parse it correctly', async () => {
      const validPath = path.join(fixturesDir, 'valid.md');
      const resource = await registry.addResource(validPath);

      expect(resource).toBeDefined();
      expect(resource.id).toBe('valid');
      expect(resource.filePath).toBe(validPath);
      expect(resource.links.length).toBeGreaterThan(0);
      expect(resource.headings.length).toBeGreaterThan(0);
      expect(resource.sizeBytes).toBeGreaterThan(0);
      expect(resource.estimatedTokenCount).toBeGreaterThan(0);
    });

    it('should generate correct IDs from file paths', async () => {
      const validPath = path.join(fixturesDir, 'valid.md');
      const brokenPath = path.join(fixturesDir, BROKEN_FILE_MD);

      const resource1 = await registry.addResource(validPath);
      const resource2 = await registry.addResource(brokenPath);

      expect(resource1.id).toBe('valid');
      expect(resource2.id).toBe(BROKEN_FILE_ID);
    });

    it('should handle ID collisions by appending suffix', async () => {
      // Add same file twice to force collision
      const validPath = path.join(fixturesDir, 'valid.md');

      const resource1 = await registry.addResource(validPath);
      expect(resource1.id).toBe('valid');

      // Add same file again - it should overwrite the path entry but generate new ID
      const resource2 = await registry.addResource(validPath);
      expect(resource2.id).toBe('valid-2'); // Gets a suffix due to ID collision

      // Verify the resource by path returns the latest (resource2)
      const byPath = registry.getResource(validPath);
      expect(byPath?.id).toBe('valid-2');

      // Both IDs should be in the ID map
      expect(registry.getResourceById('valid')).toBeDefined();
      expect(registry.getResourceById('valid-2')).toBeDefined();
    });

    it('should normalize relative paths to absolute', async () => {
      // Use a relative path from CWD to the fixtures
      const absoluteFixturePath = path.join(fixturesDir, 'valid.md');
      const relativePath = path.relative(process.cwd(), absoluteFixturePath);

      const resource = await registry.addResource(relativePath);
      expect(path.isAbsolute(resource.filePath)).toBe(true);
      expect(resource.filePath).toBe(absoluteFixturePath);
    });

    it('should parse links correctly', async () => {
      const validPath = path.join(fixturesDir, 'valid.md');
      const resource = await registry.addResource(validPath);

      expect(resource.links.length).toBe(4);

      // Check link types
      const linkTypes = resource.links.map((link) => link.type);
      expect(linkTypes).toContain('local_file');
      expect(linkTypes).toContain('anchor');
      expect(linkTypes).toContain('external');
    });

    it('should parse headings correctly', async () => {
      const validPath = path.join(fixturesDir, 'valid.md');
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
        path.join(fixturesDir, 'valid.md'),
        path.join(fixturesDir, BROKEN_FILE_MD),
        path.join(fixturesDir, EXTERNAL_MD),
      ];

      const resources = await registry.addResources(paths);

      expect(resources).toHaveLength(3);
      expect(registry.getAllResources()).toHaveLength(3);
    });

    it('should process files in parallel', async () => {
      const paths = [
        path.join(fixturesDir, 'valid.md'),
        path.join(fixturesDir, 'target.md'),
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
      expect(ids).toContain('valid');
      expect(ids).toContain(BROKEN_FILE_ID);
      expect(ids).toContain('target');
    });

    it('should respect include patterns', async () => {
      const resources = await registry.crawl({
        baseDir: fixturesDir,
        include: [VALID_MD_PATTERN],
      });

      expect(resources).toHaveLength(1);
      expect(resources[0]?.id).toBe('valid');
    });

    it('should respect exclude patterns', async () => {
      const resources = await registry.crawl({
        baseDir: fixturesDir,
        exclude: ['**/subdir/**', '**/node_modules/**'],
      });

      // Should exclude nested.md in subdir
      const ids = resources.map((r) => r.id);
      expect(ids).not.toContain('nested');
    });

    it('should find nested files by default', async () => {
      const resources = await registry.crawl({ baseDir: fixturesDir });

      const ids = resources.map((r) => r.id);
      expect(ids).toContain('nested');
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
      expect(result.warningCount).toBeDefined();
      expect(result.infoCount).toBeDefined();
      expect(result.issues).toBeInstanceOf(Array);
      expect(result.totalResources).toBeDefined();
      expect(result.totalLinks).toBeDefined();
      expect(result.linksByType).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should detect broken file links', async () => {
      const brokenPath = path.join(fixturesDir, BROKEN_FILE_MD);
      await registry.addResource(brokenPath);

      const result = await registry.validate();

      expect(result.passed).toBe(false);
      expect(result.errorCount).toBeGreaterThan(0);

      const brokenFileIssue = result.issues.find((i) => i.type === 'broken_file');
      expect(brokenFileIssue).toBeDefined();
      expect(brokenFileIssue?.severity).toBe('error');
      expect(brokenFileIssue?.message).toContain('File not found');
    });

    it('should detect broken anchor links', async () => {
      // Add both broken-anchor.md and target.md (target exists but anchor doesn't)
      await registry.addResource(path.join(fixturesDir, 'broken-anchor.md'));
      await registry.addResource(path.join(fixturesDir, 'target.md'));

      const result = await registry.validate();

      expect(result.passed).toBe(false);
      expect(result.errorCount).toBeGreaterThan(0);

      const brokenAnchorIssue = result.issues.find((i) => i.type === 'broken_anchor');
      expect(brokenAnchorIssue).toBeDefined();
      expect(brokenAnchorIssue?.severity).toBe('error');
      expect(brokenAnchorIssue?.message).toContain('Anchor not found');
    });

    it('should validate valid.md without errors', async () => {
      // Add all files that valid.md links to
      await registry.addResource(path.join(fixturesDir, 'valid.md'));
      await registry.addResource(path.join(fixturesDir, 'target.md'));
      await registry.addResource(path.join(fixturesDir, 'subdir/nested.md'));

      const result = await registry.validate();

      // Filter to only issues from valid.md
      const validIssues = result.issues.filter((i) => i.resourcePath.endsWith('valid.md'));

      // Should have no errors, only info for external link
      const validErrors = validIssues.filter((i) => i.severity === 'error');
      expect(validErrors).toHaveLength(0);
    });

    it('should report external links as info', async () => {
      await registry.addResource(path.join(fixturesDir, EXTERNAL_MD));

      const result = await registry.validate();

      expect(result.infoCount).toBeGreaterThan(0);

      const externalIssue = result.issues.find((i) => i.type === 'external_url');
      expect(externalIssue).toBeDefined();
      expect(externalIssue?.severity).toBe('info');
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
      await registry.addResource(path.join(fixturesDir, 'valid.md'));
      await registry.addResource(path.join(fixturesDir, 'target.md'));
      await registry.addResource(path.join(fixturesDir, 'subdir/nested.md'));

      registry.resolveLinks();

      const validResource = registry.getResourceById('valid');
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
      expect(targetLink?.resolvedId).toBe('target');
    });

    it('should not set resolvedId for non-existent targets', async () => {
      await registry.addResource(path.join(fixturesDir, BROKEN_FILE_MD));

      registry.resolveLinks();

      const brokenResource = registry.getResourceById(BROKEN_FILE_ID);
      const localFileLinks = brokenResource?.links.filter((link) => link.type === 'local_file');

      // Links to non-existent files should not have resolvedId
      expect(localFileLinks).toBeDefined();
      if (!localFileLinks) throw new Error('localFileLinks is undefined');
      const unresolvedLinks = localFileLinks.filter((link) => !link.resolvedId);
      expect(unresolvedLinks.length).toBeGreaterThan(0);
    });

    it('should mutate links in place', async () => {
      await registry.addResource(path.join(fixturesDir, 'valid.md'));
      await registry.addResource(path.join(fixturesDir, 'target.md'));

      const validResource = registry.getResourceById('valid');
      const originalLinks = validResource?.links;

      registry.resolveLinks();

      // Same object references
      expect(validResource?.links).toBe(originalLinks);

      // But now has resolvedId
      const targetLink = validResource?.links.find((link) => link.href.includes('target.md'));
      expect(targetLink?.resolvedId).toBe('target');
    });
  });

  describe('Query Methods', () => {
    beforeEach(async () => {
      await registry.crawl({ baseDir: fixturesDir });
    });

    describe('getResource()', () => {
      it('should get resource by absolute path', () => {
        const validPath = path.join(fixturesDir, 'valid.md');
        const resource = registry.getResource(validPath);

        expect(resource).toBeDefined();
        expect(resource?.id).toBe('valid');
      });

      it('should get resource by relative path', () => {
        // Use a relative path from CWD to the fixtures
        const absoluteFixturePath = path.join(fixturesDir, 'valid.md');
        const relativePath = path.relative(process.cwd(), absoluteFixturePath);

        const resource = registry.getResource(relativePath);

        expect(resource).toBeDefined();
        expect(resource?.id).toBe('valid');
      });

      it('should return undefined for non-existent path', () => {
        const resource = registry.getResource('/nonexistent/path.md');
        expect(resource).toBeUndefined();
      });
    });

    describe('getResourceById()', () => {
      it('should get resource by ID', () => {
        const resource = registry.getResourceById('valid');

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

        expect(resources.length).toBe(1);
        expect(resources[0]?.id).toBe('valid');
      });

      it('should match multiple resources with wildcard', () => {
        const resources = registry.getResourcesByPattern('**/broken*.md');

        expect(resources.length).toBeGreaterThanOrEqual(2);
        // Extract ids mapping to avoid nested arrow function
        const resourceIds = extractResourceIds(resources);
        expect(resourceIds).toContain(BROKEN_FILE_ID);
        expect(resourceIds).toContain('broken-anchor');
      });

      it('should match nested files', () => {
        const resources = registry.getResourcesByPattern('**/subdir/**');

        expect(resources.length).toBeGreaterThanOrEqual(1);
        expect(resources[0]?.id).toBe('nested');
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
      await registry.addResource(path.join(fixturesDir, 'valid.md'));
      await registry.addResource(path.join(fixturesDir, EXTERNAL_MD));

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
      expect(registry.getResourceById('valid')).toBeUndefined();
      expect(registry.getStats().totalResources).toBe(0);
    });

    it('should allow adding resources after clear', async () => {
      await registry.addResource(path.join(fixturesDir, 'valid.md'));
      registry.clear();

      await registry.addResource(path.join(fixturesDir, 'target.md'));

      expect(registry.getAllResources()).toHaveLength(1);
      expect(registry.getResourceById('target')).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle adding same file multiple times', async () => {
      const validPath = path.join(fixturesDir, 'valid.md');

      await registry.addResource(validPath);
      await registry.addResource(validPath);

      // Should overwrite (path map) but keep same ID
      expect(registry.getAllResources()).toHaveLength(1);
      expect(registry.getResourceById('valid')).toBeDefined();
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
      await registry.addResource(path.join(fixturesDir, 'target.md'));

      const result = await registry.validate();

      // Should not error on resources with no links
      expect(result).toBeDefined();
    });

    it('should handle resources with no headings', async () => {
      // Any file should work, as headings are optional
      await registry.addResource(path.join(fixturesDir, EXTERNAL_MD));

      const resource = registry.getResourceById('external');
      expect(resource).toBeDefined();

      // Should handle validation even with no headings
      const result = await registry.validate();
      expect(result).toBeDefined();
    });
  });
});
