/**
 * Integration tests for resource parsing
 * Tests parsing real markdown, JSON, and YAML files with proper resource type detection
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseJsonResource,
  parseJsonSchemaResource,
  parseMarkdownResource,
  parseYamlResource,
} from '../../src/types/resource-parser.ts';
import { ResourceType } from '../../src/types/resources.ts';

// ============================================================================
// Test suite setup
// ============================================================================

const suite = {
  tempDir: '',
  beforeEach: async () => {
    suite.tempDir = await mkdtemp(join(normalizedTmpdir(), 'resource-parser-integration-'));
  },
  afterEach: async () => {
    await rm(suite.tempDir, { recursive: true, force: true });
  },
};

describe('parseMarkdownResource', () => {
  // Test constants
  const COLLECTION_DOCS = 'docs';

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should parse markdown with frontmatter', async () => {
    const filePath = join(suite.tempDir, 'doc.md');
    const content = `---
title: Test Document
tags: [test, demo]
---

# Heading 1

Content here with [link](./other.md).

## Heading 2

More content.`;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test file in controlled temp directory
    await writeFile(filePath, content, 'utf-8');

    const result = await parseMarkdownResource(filePath, 'doc.md', COLLECTION_DOCS);

    expect(result.type).toBe(ResourceType.MARKDOWN);
    expect(result.mimeType).toBe('text/markdown');
    expect(result.projectPath).toBe('doc.md');
    expect(result.absolutePath).toBe(filePath);
    expect(result.collections).toEqual([COLLECTION_DOCS]);
    expect(result.frontmatter).toEqual({
      title: 'Test Document',
      tags: ['test', 'demo'],
    });
    expect(result.content).toContain('# Heading 1');
    expect(result.links).toContain('./other.md');
    expect(result.headings).toHaveLength(2);
    expect(result.headings[0]?.level).toBe(1);
    expect(result.headings[0]?.text).toBe('Heading 1');
    expect(result.estimatedTokenCount).toBeGreaterThan(0);
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('should parse markdown without frontmatter', async () => {
    const filePath = join(suite.tempDir, 'simple.md');
    const content = '# Simple Doc\n\nJust content.';

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test file in controlled temp directory
    await writeFile(filePath, content, 'utf-8');

    const result = await parseMarkdownResource(filePath, 'simple.md', COLLECTION_DOCS);

    expect(result.type).toBe(ResourceType.MARKDOWN);
    expect(result.frontmatter).toBeUndefined();
    expect(result.content).toBe(content);
    expect(result.headings).toHaveLength(1);
  });

  it('should handle markdown with no links', async () => {
    const filePath = join(suite.tempDir, 'no-links.md');
    const content = '# Title\n\nText without links.';

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test file in controlled temp directory
    await writeFile(filePath, content, 'utf-8');

    const result = await parseMarkdownResource(filePath, 'no-links.md', COLLECTION_DOCS);

    expect(result.links).toEqual([]);
  });

  it('should estimate token count correctly', async () => {
    const filePath = join(suite.tempDir, 'tokens.md');
    const content = 'a'.repeat(400); // 400 chars = ~100 tokens

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test file in controlled temp directory
    await writeFile(filePath, content, 'utf-8');

    const result = await parseMarkdownResource(filePath, 'tokens.md', COLLECTION_DOCS);

    expect(result.estimatedTokenCount).toBe(100);
  });
});

describe('parseJsonSchemaResource', () => {
  // Test constants
  const COLLECTION_SCHEMAS = 'schemas';
  const USER_SCHEMA_FILE = 'user.schema.json';

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should parse JSON Schema with $schema keyword', async () => {
    const filePath = join(suite.tempDir, USER_SCHEMA_FILE);
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'https://example.com/schemas/user',
      title: 'User Schema',
      description: 'Defines a user object',
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    };

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test file in controlled temp directory
    await writeFile(filePath, JSON.stringify(schema, null, 2), 'utf-8');

    const result = await parseJsonSchemaResource(filePath, USER_SCHEMA_FILE, COLLECTION_SCHEMAS);

    expect(result.type).toBe(ResourceType.JSON_SCHEMA);
    expect(result.mimeType).toBe('application/schema+json');
    expect(result.projectPath).toBe(USER_SCHEMA_FILE);
    expect(result.collections).toEqual([COLLECTION_SCHEMAS]);
    expect(result.schema).toEqual(schema);
    expect(result.schemaId).toBe('https://example.com/schemas/user');
    expect(result.schemaVersion).toBe('http://json-schema.org/draft-07/schema#');
    expect(result.title).toBe('User Schema');
    expect(result.description).toBe('Defines a user object');
    expect(result.referencedBy).toEqual([]);
  });

  it('should parse JSON Schema without $schema keyword', async () => {
    const filePath = join(suite.tempDir, 'config.schema.json');
    const schema = {
      title: 'Config',
      type: 'object',
      properties: {
        debug: { type: 'boolean' },
      },
    };

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test file in controlled temp directory
    await writeFile(filePath, JSON.stringify(schema), 'utf-8');

    const result = await parseJsonSchemaResource(filePath, 'config.schema.json', COLLECTION_SCHEMAS);

    expect(result.type).toBe(ResourceType.JSON_SCHEMA);
    expect(result.schemaVersion).toBeUndefined();
    expect(result.title).toBe('Config');
  });
});

describe('parseJsonResource', () => {
  // Test constants
  const COLLECTION_DATA = 'data';

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should parse regular JSON data', async () => {
    const filePath = join(suite.tempDir, 'data.json');
    const data = {
      users: [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ],
    };

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test file in controlled temp directory
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');

    const result = await parseJsonResource(filePath, 'data.json', COLLECTION_DATA);

    expect(result.type).toBe(ResourceType.JSON);
    expect(result.mimeType).toBe('application/json');
    expect(result.projectPath).toBe('data.json');
    expect(result.collections).toEqual([COLLECTION_DATA]);
    expect(result.data).toEqual(data);
    expect(result.schemas).toBeUndefined();
  });

  it('should handle empty JSON object', async () => {
    const filePath = join(suite.tempDir, 'empty.json');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test file in controlled temp directory
    await writeFile(filePath, '{}', 'utf-8');

    const result = await parseJsonResource(filePath, 'empty.json', COLLECTION_DATA);

    expect(result.data).toEqual({});
  });

  it('should handle JSON arrays', async () => {
    const filePath = join(suite.tempDir, 'array.json');
    const data = [1, 2, 3, 4, 5];

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test file in controlled temp directory
    await writeFile(filePath, JSON.stringify(data), 'utf-8');

    const result = await parseJsonResource(filePath, 'array.json', COLLECTION_DATA);

    expect(result.data).toEqual(data);
  });
});

describe('parseYamlResource', () => {
  // Test constants
  const COLLECTION_CONFIG = 'config';
  const CONFIG_YAML_FILE = 'config.yaml';

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should parse YAML data', async () => {
    const filePath = join(suite.tempDir, CONFIG_YAML_FILE);
    const yaml = `
name: MyApp
version: 1.0.0
settings:
  debug: true
  port: 3000
`;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test file in controlled temp directory
    await writeFile(filePath, yaml, 'utf-8');

    const result = await parseYamlResource(filePath, CONFIG_YAML_FILE, COLLECTION_CONFIG);

    expect(result.type).toBe(ResourceType.YAML);
    expect(result.mimeType).toBe('application/yaml');
    expect(result.projectPath).toBe(CONFIG_YAML_FILE);
    expect(result.collections).toEqual([COLLECTION_CONFIG]);
    expect(result.data).toEqual({
      name: 'MyApp',
      version: '1.0.0',
      settings: {
        debug: true,
        port: 3000,
      },
    });
  });

  it('should handle YAML with arrays', async () => {
    const COLLECTION_DATA = 'data';
    const filePath = join(suite.tempDir, 'list.yml');
    const yaml = `
items:
  - name: Item 1
    value: 100
  - name: Item 2
    value: 200
`;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test file in controlled temp directory
    await writeFile(filePath, yaml, 'utf-8');

    const result = await parseYamlResource(filePath, 'list.yml', COLLECTION_DATA);

    expect(result.data).toHaveProperty('items');
    const items = (result.data as { items: unknown[] }).items;
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(2);
  });
});
