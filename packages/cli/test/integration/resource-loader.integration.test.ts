/**
 * Integration tests for resource-loader - orchestration of resource loading with config
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test file uses dynamic temp paths */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizedTmpdir, normalizePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/utils/logger.js';
import { loadResourcesWithConfig } from '../../src/utils/resource-loader.js';

const CONFIG_FILE = 'vibe-agent-toolkit.config.yaml';

/**
 * Helper to run a test within the project directory context
 */
function inProjectDir<T>(projectDir: string, fn: () => T | Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  process.chdir(projectDir);

  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => process.chdir(originalCwd));
    }
    process.chdir(originalCwd);
    return Promise.resolve(result);
  } catch (error) {
    process.chdir(originalCwd);
    throw error;
  }
}

/**
 * Helper to assert single resource with expected heading
 */
function expectSingleResource(resources: Array<{ headings: Array<{ text: string }> }>, expectedHeading: string): void {
  expect(resources).toHaveLength(1);
  expect(resources[0]?.headings[0]?.text).toBe(expectedHeading);
}

/**
 * Helper to assert result paths match expected values
 */
function expectProjectPaths(result: { scanPath: string; projectRoot: string | null }, expectedPath: string): void {
  expect(normalizePath(result.scanPath)).toBe(normalizePath(expectedPath));
  expect(normalizePath(result.projectRoot ?? '')).toBe(normalizePath(expectedPath));
}

/**
 * Compare function for sorting optional strings
 */
function compareOptionalStrings(a: string | undefined, b: string | undefined): number {
  return (a ?? '').localeCompare(b ?? '');
}

/**
 * Extract and sort headings from resources
 */
function extractHeadingTexts(resources: Array<{ headings: Array<{ text: string }> }>): Array<string | undefined> {
  return resources.map((r) => r.headings[0]?.text).sort(compareOptionalStrings);
}

describe('loadResourcesWithConfig (integration test)', () => {
  let testDir: string;
  let projectDir: string;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(async () => {
    // Create temporary directories
    testDir = join(normalizedTmpdir(), `resource-loader-test-${Date.now()}`);
    projectDir = join(testDir, 'project');

    await mkdir(projectDir, { recursive: true });

    // Create a basic project structure
    await mkdir(join(projectDir, 'docs'), { recursive: true });
    await mkdir(join(projectDir, 'other'), { recursive: true });

    // Create some markdown files
    await writeFile(join(projectDir, 'README.md'), '# Root README\n');
    await writeFile(join(projectDir, 'docs', 'guide.md'), '# Guide\n');
    await writeFile(join(projectDir, 'other', 'notes.md'), '# Notes\n');

    // Create package.json to mark as project root
    await writeFile(
      join(projectDir, 'package.json'),
      JSON.stringify({ name: 'test-project' })
    );

    logger = createLogger({ debug: false });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('with pathArg provided', () => {
    it('should use pathArg as baseDir and ignore config patterns', async () => {
      // Create config with patterns
      await writeFile(
        join(projectDir, CONFIG_FILE),
        'version: 1\nresources:\n  include:\n    - "docs/**/*.md"\n  exclude:\n    - "other/**"\n'
      );

      await inProjectDir(projectDir, async () => {
        const docsPath = join(projectDir, 'docs');
        const result = await loadResourcesWithConfig(docsPath, logger);

        expect(normalizePath(result.scanPath)).toBe(normalizePath(docsPath));
        expect(normalizePath(result.projectRoot ?? '')).toBe(normalizePath(projectDir));
        expect(result.config).toBeDefined();
        expect(result.registry).toBeDefined();

        // Should only find docs/guide.md (baseDir is docs/)
        expectSingleResource(result.registry.getAllResources(), 'Guide');
      });
    });

    it('should crawl from pathArg with default patterns', async () => {
      await inProjectDir(projectDir, async () => {
        const otherPath = join(projectDir, 'other');
        const result = await loadResourcesWithConfig(otherPath, logger);

        expect(normalizePath(result.scanPath)).toBe(normalizePath(otherPath));

        // Should find other/notes.md
        expectSingleResource(result.registry.getAllResources(), 'Notes');
      });
    });
  });

  describe('without pathArg (using project root)', () => {
    it('should use project root and apply config patterns', async () => {
      // Create config that excludes 'other'
      await writeFile(
        join(projectDir, CONFIG_FILE),
        'version: 1\nresources:\n  exclude:\n    - "other/**"\n'
      );

      await inProjectDir(projectDir, async () => {
        const result = await loadResourcesWithConfig(undefined, logger);

        expectProjectPaths(result, projectDir);
        expect(result.config).toBeDefined();

        // Should find README.md and docs/guide.md (other excluded)
        const resources = result.registry.getAllResources();
        expect(resources.length).toBeGreaterThanOrEqual(2);

        const titles = extractHeadingTexts(resources);
        expect(titles).toContain('Guide');
        expect(titles).toContain('Root README');
      });
    });

    it('should use include patterns from config', async () => {
      // Create config that only includes docs/
        await writeFile(
        join(projectDir, CONFIG_FILE),
        'version: 1\nresources:\n  include:\n    - "docs/**/*.md"\n'
      );

      await inProjectDir(projectDir, async () => {
        const result = await loadResourcesWithConfig(undefined, logger);

        // Should only find docs/guide.md
        expectSingleResource(result.registry.getAllResources(), 'Guide');
      });
    });

    it('should work without config file', async () => {
      await inProjectDir(projectDir, async () => {
        const result = await loadResourcesWithConfig(undefined, logger);

        expectProjectPaths(result, projectDir);
        expect(result.config).toBeUndefined();

        // Should find all markdown files with default patterns
        const resources = result.registry.getAllResources();
        expect(resources.length).toBeGreaterThanOrEqual(3);
      });
    });
  });

  describe('GitTracker integration', () => {
    it('should create and initialize GitTracker when project root exists', async () => {
      const result = await loadResourcesWithConfig(projectDir, logger);

      expect(result.gitTracker).toBeDefined();
      expect(result.gitTracker?.getStats().cacheSize).toBeGreaterThanOrEqual(0);
    });

    it('should not create GitTracker when no project root', async () => {
      // Create isolated directory without package.json
      const isolatedDir = join(testDir, 'isolated');
      await mkdir(isolatedDir, { recursive: true });
      await writeFile(join(isolatedDir, 'test.md'), '# Test\n');

      await inProjectDir(isolatedDir, async () => {
        const result = await loadResourcesWithConfig(isolatedDir, logger);

        expect(result.projectRoot).toBeNull();
        expect(result.gitTracker).toBeUndefined();
      });
    });
  });

  describe('config conversion', () => {
    it('should convert CLI config to resources package format', async () => {
      // Create config with collections
        await writeFile(
        join(projectDir, CONFIG_FILE),
        `version: 1
resources:
  collections:
    guides:
      include:
        - "docs/guides/**/*.md"
      validation:
        frontmatterSchema: schema.json
  include:
    - "**/*.md"
  exclude:
    - "node_modules/**"
`
      );

      const result = await loadResourcesWithConfig(projectDir, logger);

      expect(result.config).toBeDefined();
      expect(result.config?.resources?.collections).toBeDefined();
      expect(result.config?.resources?.collections?.guides).toBeDefined();
      expect(result.config?.resources?.collections?.guides?.include).toContain('docs/guides/**/*.md');

      // Registry should have been configured with the converted config
      expect(result.registry).toBeDefined();
    });
  });

  describe('return value structure', () => {
    it('should return all expected fields', async () => {
      const result = await loadResourcesWithConfig(projectDir, logger);

      expect(result).toHaveProperty('scanPath');
      expect(result).toHaveProperty('projectRoot');
      expect(result).toHaveProperty('config');
      expect(result).toHaveProperty('registry');
      expect(result).toHaveProperty('gitTracker');

      expect(typeof result.scanPath).toBe('string');
      expect(typeof result.projectRoot === 'string' || result.projectRoot === null).toBe(true);
      expect(result.registry).toBeDefined();
    });
  });
});
