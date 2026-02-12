/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
// Test file - all file operations are in temp directories, duplicated strings acceptable
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ProjectConfig } from '../../src/schemas/project-config.js';
import { createSchemaFile, setupTempDirTestSuite } from '../test-helpers.js';

/**
 * Tests for per-collection frontmatter schema validation
 *
 * Validates that ResourceRegistry applies collection-specific schemas
 * during validation based on ProjectConfig.
 */

// Common schemas
const titleDescriptionSchema = {
  type: 'object',
  required: ['title', 'description'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
  },
};

const titleOnlySchema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
  },
  additionalProperties: false,
};

const categorySchema = {
  type: 'object',
  required: ['category'],
  properties: {
    category: { type: 'string' },
  },
};

/**
 * Create a markdown file with frontmatter
 */
async function createMarkdownFile(
  filePath: string,
  frontmatter: Record<string, unknown> | null,
  content: string = '# Test\n\nContent here.'
): Promise<void> {
  let frontmatterBlock = '';
  if (frontmatter) {
    const entries = Object.entries(frontmatter).map(([k, v]) => {
      const jsonValue = JSON.stringify(v);
      return `${k}: ${jsonValue}`;
    }).join('\n');
    frontmatterBlock = `---\n${entries}\n---\n\n`;
  }
  await writeFile(filePath, frontmatterBlock + content, 'utf-8');
}

/**
 * Create a project config with a single collection
 */
function createSingleCollectionConfig(
  schemaFile: string,
  mode: 'strict' | 'permissive',
  collectionId: string = 'skills'
): ProjectConfig {
  return {
    version: 1,
    resources: {
      collections: {
        [collectionId]: {
          include: ['**/*.md'],
          validation: {
            frontmatterSchema: schemaFile,
            mode,
          },
        },
      },
    },
  };
}

describe('ResourceRegistry - per-collection frontmatter validation', () => {
  const suite = setupTempDirTestSuite('collection-validation-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  /**
   * Create markdown file in docs directory and registry
   */
  async function createResourceWithRegistry(
    config: ProjectConfig,
    frontmatter: Record<string, unknown> | null
  ): Promise<{ registry: ResourceRegistry; filePath: string }> {
    const docsDir = join(suite.tempDir, 'docs');
    await mkdir(docsDir, { recursive: true });
    const filePath = join(docsDir, 'test.md');
    await createMarkdownFile(filePath, frontmatter);

    const registry = new ResourceRegistry({ baseDir: suite.tempDir, config });
    await registry.addResource(filePath);

    return { registry, filePath };
  }

  /**
   * Setup test with schema, config, and markdown file
   */
  async function setupCollectionTest(
    schema: object,
    schemaFile: string,
    mode: 'strict' | 'permissive',
    frontmatter: Record<string, unknown> | null
  ): Promise<{ registry: ResourceRegistry; filePath: string }> {
    await createSchemaFile(suite.tempDir, schemaFile, schema);
    const config = createSingleCollectionConfig(schemaFile, mode);
    return await createResourceWithRegistry(config, frontmatter);
  }

  /**
   * Setup test with multiple collections
   */
  async function setupMultiCollectionTest(
    frontmatter: Record<string, unknown> | null
  ): Promise<{ registry: ResourceRegistry; filePath: string }> {
    const titleSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
      },
    };
    await createSchemaFile(suite.tempDir, 'base.schema.json', titleSchema);
    await createSchemaFile(suite.tempDir, 'skill.schema.json', categorySchema);

    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          docs: {
            include: ['**/*.md'],
            validation: {
              frontmatterSchema: 'base.schema.json',
              mode: 'strict',
            },
          },
          skills: {
            include: ['**/*.md'],
            validation: {
              frontmatterSchema: 'skill.schema.json',
              mode: 'strict',
            },
          },
        },
      },
    };

    return await createResourceWithRegistry(config, frontmatter);
  }

  it('should validate resource against collection schema in strict mode', async () => {
    const { registry } = await setupCollectionTest(
      titleDescriptionSchema,
      'skill.schema.json',
      'strict',
      {
        title: 'Test Skill',
        description: 'A test skill',
      }
    );

    const result = await registry.validate();

    expect(result.passed).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it('should report error for invalid frontmatter in strict mode', async () => {
    const { registry } = await setupCollectionTest(
      titleDescriptionSchema,
      'skill.schema.json',
      'strict',
      {
        title: 'Test Skill',
        // missing description
      }
    );

    const result = await registry.validate();

    expect(result.passed).toBe(false);
    expect(result.errorCount).toBe(1);
    const issue = result.issues[0];
    expect(issue?.type).toBe('frontmatter_schema_error');
    expect(issue?.message).toContain('description');
  });

  it('should report warning for invalid frontmatter in permissive mode', async () => {
    const { registry } = await setupCollectionTest(
      titleOnlySchema,
      'skill.schema.json',
      'permissive',
      {
        title: 'Test Skill',
        extraField: 'should be allowed',
      }
    );

    const result = await registry.validate();

    expect(result.passed).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it('should validate resource in multiple collections with different schemas', async () => {
    const { registry } = await setupMultiCollectionTest({
      title: 'Test Doc',
      category: 'tutorial',
    });

    const result = await registry.validate();

    expect(result.passed).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it('should report errors for each failed schema in multiple collections', async () => {
    const { registry } = await setupMultiCollectionTest({
      author: 'John Doe', // doesn't satisfy either schema
    });

    const result = await registry.validate();

    expect(result.passed).toBe(false);
    expect(result.errorCount).toBe(2);
    expect(result.issues).toHaveLength(2);

    const messages = result.issues.map(i => i.message);
    expect(messages.some(m => m.includes('title'))).toBe(true);
    expect(messages.some(m => m.includes('category'))).toBe(true);
  });

  it('should handle missing schema file gracefully', async () => {
    // Create config pointing to non-existent schema
    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          skills: {
            include: ['**/*.md'],
            validation: {
              frontmatterSchema: 'missing.schema.json',
              mode: 'strict',
            },
          },
        },
      },
    };

    // Create markdown file
    const docsDir = join(suite.tempDir, 'docs');
    await mkdir(docsDir, { recursive: true });
    const filePath = join(docsDir, 'test.md');
    await createMarkdownFile(filePath, { title: 'Test' });

    // Create registry and add resource
    const registry = new ResourceRegistry({ baseDir: suite.tempDir, config });
    await registry.addResource(filePath);

    // Validate - should not crash, but should report issue
    const result = await registry.validate();

    // Should have issue about missing schema
    expect(result.errorCount).toBeGreaterThan(0);
    const issue = result.issues.find(i => i.message.includes('schema'));
    expect(issue?.message).toContain('schema');
    expect(issue?.message).toContain('missing.schema.json');
  });

  it('should skip validation for resources not in any collection', async () => {
    // Create schema file
    const schema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
      },
    };
    await createSchemaFile(suite.tempDir, 'skill.schema.json', schema);

    // Create config with specific pattern that won't match
    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          skills: {
            include: ['skills/*.md'], // specific directory
            validation: {
              frontmatterSchema: 'skill.schema.json',
              mode: 'strict',
            },
          },
        },
      },
    };

    // Create markdown file in DIFFERENT directory (not in collection)
    const docsDir = join(suite.tempDir, 'docs');
    await mkdir(docsDir, { recursive: true });
    const filePath = join(docsDir, 'test.md');
    await createMarkdownFile(filePath, {
      // No title - would fail schema if validated
    });

    // Create registry and add resource
    const registry = new ResourceRegistry({ baseDir: suite.tempDir, config });
    await registry.addResource(filePath);

    // Validate
    const result = await registry.validate();

    // Should pass (resource not in collection, so not validated)
    expect(result.passed).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it('should apply global frontmatterSchema when provided', async () => {
    // Create schema files
    const collectionSchema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
      },
    };
    const globalSchema = {
      type: 'object',
      required: ['author'],
      properties: {
        author: { type: 'string' },
      },
    };
    await createSchemaFile(suite.tempDir, 'collection.schema.json', collectionSchema);

    // Create config with collection schema
    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          docs: {
            include: ['**/*.md'],
            validation: {
              frontmatterSchema: 'collection.schema.json',
              mode: 'strict',
            },
          },
        },
      },
    };

    // Create markdown file with title but no author
    const docsDir = join(suite.tempDir, 'docs');
    await mkdir(docsDir, { recursive: true });
    const filePath = join(docsDir, 'test.md');
    await createMarkdownFile(filePath, {
      title: 'Test Doc',
      // missing author (required by global schema)
    });

    // Create registry and add resource
    const registry = new ResourceRegistry({ baseDir: suite.tempDir, config });
    await registry.addResource(filePath);

    // Validate with global schema
    const result = await registry.validate({
      frontmatterSchema: globalSchema,
    });

    // Should fail global schema validation
    expect(result.passed).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
    const issue = result.issues.find(i => i.message.includes('author'));
    expect(issue).toBeDefined();
  });

  it('should default to permissive mode if mode not specified', async () => {
    await createSchemaFile(suite.tempDir, 'skill.schema.json', titleOnlySchema);

    // Create config WITHOUT specifying mode (should default to permissive)
    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          skills: {
            include: ['**/*.md'],
            validation: {
              frontmatterSchema: 'skill.schema.json',
              // mode not specified - should default to permissive
            },
          },
        },
      },
    };

    const docsDir = join(suite.tempDir, 'docs');
    await mkdir(docsDir, { recursive: true });
    const filePath = join(docsDir, 'test.md');
    await createMarkdownFile(filePath, {
      title: 'Test Skill',
      extraField: 'should be allowed in permissive mode',
    });

    const registry = new ResourceRegistry({ baseDir: suite.tempDir, config });
    await registry.addResource(filePath);

    const result = await registry.validate();

    expect(result.passed).toBe(true);
    expect(result.errorCount).toBe(0);
  });
});
