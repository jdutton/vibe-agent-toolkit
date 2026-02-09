/**
 * Edge case and error path tests for ResourceRegistry
 * Focuses on coverage gaps: constructor optionals, error handling, validation edge cases
 */

/* eslint-disable security/detect-non-literal-fs-filename */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { GitTracker, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, beforeAll, afterAll } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ProjectConfig } from '../../src/schemas/project-config.js';
import type { ResourceMetadata } from '../../src/schemas/resource-metadata.js';

/**
 * Helper to create a registry with a config and add a simple test file
 */
async function createRegistryWithTestFile(
  tempDir: string,
  config: ProjectConfig
): Promise<{ registry: ResourceRegistry; resource: ResourceMetadata; filePath: string }> {
  const registry = new ResourceRegistry({ rootDir: tempDir, config });
  const filePath = join(tempDir, 'test.md');
  await fs.writeFile(filePath, '# Test', 'utf-8');
  const resource = await registry.addResource(filePath);
  return { registry, resource, filePath };
}

describe('ResourceRegistry constructor optionals', () => {
  it('should handle all optional parameters as undefined', () => {
    const registry = new ResourceRegistry();

    expect(registry.rootDir).toBeUndefined();
    expect(registry.config).toBeUndefined();
    expect(registry.gitTracker).toBeUndefined();
  });

  it('should handle only rootDir provided', () => {
    const registry = new ResourceRegistry({ rootDir: '/test' });

    expect(registry.rootDir).toBe('/test');
    expect(registry.config).toBeUndefined();
    expect(registry.gitTracker).toBeUndefined();
  });

  it('should handle only config provided', () => {
    const config: ProjectConfig = { version: 1 };
    const registry = new ResourceRegistry({ config });

    expect(registry.rootDir).toBeUndefined();
    expect(registry.config).toBe(config);
    expect(registry.gitTracker).toBeUndefined();
  });

  it('should handle all parameters provided', () => {
    const config: ProjectConfig = { version: 1 };
    const gitTracker = new GitTracker('/test');

    const registry = new ResourceRegistry({
      rootDir: '/test',
      config,
      gitTracker,
    });

    expect(registry.rootDir).toBe('/test');
    expect(registry.config).toBe(config);
    expect(registry.gitTracker).toBe(gitTracker);
  });
});

describe('ResourceRegistry.fromResources index building', () => {
  const suite = setupAsyncTempDirSuite('registry-indexes');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should build all 4 indexes correctly', async () => {
    // Create test files
    await fs.writeFile(join(tempDir, 'doc1.md'), '# Doc 1', 'utf-8');
    await fs.writeFile(join(tempDir, 'doc2.md'), '# Doc 2', 'utf-8');

    // Parse resources
    const tempRegistry = new ResourceRegistry();
    const resource1 = await tempRegistry.addResource(join(tempDir, 'doc1.md'));
    const resource2 = await tempRegistry.addResource(join(tempDir, 'doc2.md'));

    // Create registry from resources
    const registry = ResourceRegistry.fromResources(tempDir, [resource1, resource2]);

    // Verify all 4 indexes are populated
    // 1. By path
    expect(registry.getResource(resource1.filePath)).toBe(resource1);
    expect(registry.getResource(resource2.filePath)).toBe(resource2);

    // 2. By ID
    expect(registry.getResourceById(resource1.id)).toBe(resource1);
    expect(registry.getResourceById(resource2.id)).toBe(resource2);

    // 3. By name
    expect(registry.getResourcesByName('doc1.md')).toContain(resource1);
    expect(registry.getResourcesByName('doc2.md')).toContain(resource2);

    // 4. By checksum
    expect(registry.getResourcesByChecksum(resource1.checksum)).toContain(resource1);
    expect(registry.getResourcesByChecksum(resource2.checksum)).toContain(resource2);
  });
});

describe('ResourceRegistry.addResource with collections', () => {
  const suite = setupAsyncTempDirSuite('registry-collections');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should handle resources when config has no collections', async () => {
    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {}, // Empty collections object
      },
    };

    const { resource } = await createRegistryWithTestFile(tempDir, config);

    // Collections should be undefined when no matching collections
    expect(resource.collections).toBeUndefined();
  });

  it('should handle resources when no matching collections', async () => {
    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          docs: {
            include: ['docs/**/*.md'], // Won't match root-level file
          },
        },
      },
    };

    const { resource } = await createRegistryWithTestFile(tempDir, config);

    // Should have empty collections array when no patterns match
    expect(resource.collections).toBeUndefined();
  });
});

describe('ResourceRegistry.validate without rootDir', () => {
  const suite = setupAsyncTempDirSuite('registry-validate');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should validate links when rootDir is undefined', async () => {
    const registry = new ResourceRegistry(); // No rootDir

    await fs.writeFile(join(tempDir, 'test.md'), '# Test\n\n[Link](./other.md)', 'utf-8');
    await registry.addResource(join(tempDir, 'test.md'));

    const result = await registry.validate();

    // Should still validate (will fail because other.md doesn't exist)
    expect(result).toBeDefined();
    expect(result.totalResources).toBe(1);
  });
});

describe('ResourceRegistry schema validation error handling', () => {
  const suite = setupAsyncTempDirSuite('registry-schema-errors');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should handle missing schema file gracefully', async () => {
    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          docs: {
            include: ['**/*.md'],
            validation: {
              frontmatterSchema: 'nonexistent.json', // File doesn't exist
              mode: 'strict',
            },
          },
        },
      },
    };

    const registry = new ResourceRegistry({ rootDir: tempDir, config });

    await fs.writeFile(join(tempDir, 'test.md'), '---\ntitle: Test\n---\n\n# Test', 'utf-8');
    await registry.addResource(join(tempDir, 'test.md'));

    const result = await registry.validate();

    // Should have error about missing schema (tests catch block)
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.message.includes('Failed to load'))).toBe(true);
    expect(result.issues.some((i) => i.message.includes('nonexistent.json'))).toBe(true);
  });

  it('should handle invalid JSON in schema file', async () => {
    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          docs: {
            include: ['**/*.md'],
            validation: {
              frontmatterSchema: 'invalid.json',
              mode: 'strict',
            },
          },
        },
      },
    };

    const registry = new ResourceRegistry({ rootDir: tempDir, config });

    // Write invalid JSON to schema file
    await fs.writeFile(join(tempDir, 'invalid.json'), '{invalid json}', 'utf-8');

    await fs.writeFile(join(tempDir, 'test.md'), '---\ntitle: Test\n---\n\n# Test', 'utf-8');
    await registry.addResource(join(tempDir, 'test.md'));

    const result = await registry.validate();

    // Should have error about invalid JSON (tests catch block with JSON.parse error)
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.message.includes('Failed to load'))).toBe(true);
  });

  it('should validate successfully with valid schema', async () => {
    const schema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
      },
    };

    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          docs: {
            include: ['**/*.md'],
            validation: {
              frontmatterSchema: 'schema.json',
              mode: 'strict',
            },
          },
        },
      },
    };

    const registry = new ResourceRegistry({ rootDir: tempDir, config });

    // Write valid schema
    await fs.writeFile(join(tempDir, 'schema.json'), JSON.stringify(schema), 'utf-8');

    // Write document with valid frontmatter
    await fs.writeFile(join(tempDir, 'test.md'), '---\ntitle: Test Document\n---\n\n# Test', 'utf-8');
    await registry.addResource(join(tempDir, 'test.md'));

    const result = await registry.validate();

    expect(result.passed).toBe(true);
    expect(result.errorCount).toBe(0);
  });
});

describe('ResourceRegistry.getCollectionStats edge cases', () => {
  const suite = setupAsyncTempDirSuite('registry-stats');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should return undefined when no collections configured', () => {
    const registry = new ResourceRegistry({ rootDir: tempDir });

    const stats = registry.getCollectionStats();

    expect(stats).toBeUndefined();
  });

  it('should handle config without resources field', () => {
    const config: ProjectConfig = { version: 1 };
    const registry = new ResourceRegistry({ rootDir: tempDir, config });

    const stats = registry.getCollectionStats();

    expect(stats).toBeUndefined();
  });

  it('should handle collection with validation mode defined', async () => {
    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          docs: {
            include: ['**/*.md'],
            validation: { mode: 'permissive' },
          },
        },
      },
    };

    const { registry } = await createRegistryWithTestFile(tempDir, config);
    const stats = registry.getCollectionStats();

    expect(stats?.collections['docs']?.validationMode).toBe('permissive');
  });

  it('should not set validationMode when undefined', async () => {
    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          docs: {
            include: ['**/*.md'],
          },
        },
      },
    };

    const { registry } = await createRegistryWithTestFile(tempDir, config);
    const stats = registry.getCollectionStats();

    expect(stats?.collections['docs']?.validationMode).toBeUndefined();
  });
});
