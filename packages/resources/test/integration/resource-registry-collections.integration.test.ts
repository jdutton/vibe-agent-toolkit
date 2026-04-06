/* eslint-disable security/detect-non-literal-fs-filename */
// Test file - all file operations are in temp directories
import { mkdir, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ProjectConfig } from '../../src/schemas/project-config.js';
import { setupTempDirTestSuite } from '../test-helpers.js';

// Helper for comparing collections arrays (order doesn't matter)
function expectCollectionsEqual(actual: string[] | undefined, expected: string[]): void {
  const compareStrings = (a: string, b: string): number => a.localeCompare(b);
  expect(actual ? [...actual].sort(compareStrings) : actual).toEqual([...expected].sort(compareStrings));
}

describe('ResourceRegistry with collections', () => {
  const suite = setupTempDirTestSuite('registry-collections-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should assign collections to resources based on config', async () => {
    // Create test files
    const docsDir = safePath.join(suite.tempDir, 'docs');
    await mkdir(docsDir);
    await writeFile(safePath.join(docsDir, 'guide.md'), '# Guide\n\nContent here.');
    await writeFile(safePath.join(suite.tempDir, 'README.md'), '# Project\n\nReadme content.');

    // Create config
    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          'rag-kb': {
            include: ['docs'],
          },
          'all-docs': {
            include: ['**/*.md'],
          },
        },
      },
    };

    // Create registry with config
    const registry = new ResourceRegistry({ config });

    // Add resources
    await registry.addResource(safePath.join(docsDir, 'guide.md'));
    await registry.addResource(safePath.join(suite.tempDir, 'README.md'));

    // Check collections
    const guide = registry.getResource(safePath.join(docsDir, 'guide.md'));
    expectCollectionsEqual(guide?.collections, ['all-docs', 'rag-kb']);

    const readme = registry.getResource(safePath.join(suite.tempDir, 'README.md'));
    expect(readme?.collections).toEqual(['all-docs']);
  });

  it('should not assign collections when config is absent', async () => {
    const filePath = safePath.join(suite.tempDir, 'test.md');
    await writeFile(filePath, '# Test\n\nContent.');

    const registry = new ResourceRegistry();
    await registry.addResource(filePath);

    const resource = registry.getResource(filePath);
    expect(resource?.collections).toBeUndefined();
  });

  it('should assign empty collections array when file matches no collections', async () => {
    const filePath = safePath.join(suite.tempDir, 'test.ts');
    await writeFile(filePath, 'console.log("test");');

    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          'docs-only': {
            include: ['docs/**/*.md'],
          },
        },
      },
    };

    const registry = new ResourceRegistry({ config });
    await registry.addResource(filePath);

    const resource = registry.getResource(filePath);
    expect(resource?.collections).toBeUndefined();
  });

  it('should respect exclude patterns', async () => {
    // Create test files
    const docsDir = safePath.join(suite.tempDir, 'docs');
    await mkdir(docsDir);
    await writeFile(safePath.join(docsDir, 'guide.md'), '# Guide');
    await writeFile(safePath.join(docsDir, 'README.md'), '# Readme');

    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          'rag-kb': {
            include: ['docs'],
            exclude: ['**/README.md'],
          },
          'all-md': {
            include: ['**/*.md'],
          },
        },
      },
    };

    const registry = new ResourceRegistry({ config });
    await registry.addResource(safePath.join(docsDir, 'guide.md'));
    await registry.addResource(safePath.join(docsDir, 'README.md'));

    const guide = registry.getResource(safePath.join(docsDir, 'guide.md'));
    expectCollectionsEqual(guide?.collections, ['all-md', 'rag-kb']);

    const readme = registry.getResource(safePath.join(docsDir, 'README.md'));
    expect(readme?.collections).toEqual(['all-md']);
  });

  it('should handle overlapping collections', async () => {
    const skillPath = safePath.join(suite.tempDir, 'SKILL.md');
    await writeFile(skillPath, '# Skill\n\n## Usage');

    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          'skills': {
            include: ['**/SKILL.md'],
          },
          'all-md': {
            include: ['**/*.md'],
          },
          'root-files': {
            include: ['*.md'],
          },
        },
      },
    };

    const registry = new ResourceRegistry({ config });
    await registry.addResource(skillPath);

    const skill = registry.getResource(skillPath);
    expectCollectionsEqual(skill?.collections, ['all-md', 'root-files', 'skills']);
  });

  it('should work with crawl method', async () => {
    // Create directory structure
    const docsDir = safePath.join(suite.tempDir, 'docs');
    const guidesDir = safePath.join(suite.tempDir, 'guides');
    await mkdir(docsDir);
    await mkdir(guidesDir);

    await writeFile(safePath.join(docsDir, 'api.md'), '# API');
    await writeFile(safePath.join(guidesDir, 'tutorial.md'), '# Tutorial');
    await writeFile(safePath.join(suite.tempDir, 'README.md'), '# Project');

    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          'docs': {
            include: ['docs'],
          },
          'guides': {
            include: ['guides'],
          },
        },
      },
    };

    const registry = new ResourceRegistry({ config });
    await registry.crawl({
      baseDir: suite.tempDir,
      include: ['**/*.md'],
    });

    const api = registry.getResource(safePath.join(docsDir, 'api.md'));
    expect(api?.collections).toEqual(['docs']);

    const tutorial = registry.getResource(safePath.join(guidesDir, 'tutorial.md'));
    expect(tutorial?.collections).toEqual(['guides']);

    const readme = registry.getResource(safePath.join(suite.tempDir, 'README.md'));
    expect(readme?.collections).toBeUndefined();
  });
});
