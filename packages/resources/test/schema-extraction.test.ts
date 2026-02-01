/**
 * Tests for $schema extraction from frontmatter
 *
 * Tests Phase 4 schema assignment pipeline:
 * - Self-asserted schemas (from $schema field)
 * - SchemaReference creation with correct source
 */

/* eslint-disable security/detect-non-literal-fs-filename */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseMarkdownResource } from '../src/types/resource-parser.js';

import { setupTempDirTestSuite } from './test-helpers.js';

describe('Schema Extraction from Frontmatter', () => {
  const suite = setupTempDirTestSuite('schema-extraction-test-');

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should extract $schema from frontmatter as self-asserted schema', async () => {
    const filePath = join(suite.tempDir, 'test.md');
    const content = `---
$schema: ./schema.json
title: My Document
---

# Content`;

    await fs.writeFile(filePath, content, 'utf-8');

    const resource = await parseMarkdownResource(filePath, 'test.md', 'default');

    expect(resource.schemas).toHaveLength(1);
    expect(resource.schemas[0]).toEqual({
      schema: './schema.json',
      source: 'self',
      applied: false,
    });
  });

  it('should handle missing $schema field', async () => {
    const filePath = join(suite.tempDir, 'test.md');
    const content = `---
title: My Document
---

# Content`;

    await fs.writeFile(filePath, content, 'utf-8');

    const resource = await parseMarkdownResource(filePath, 'test.md', 'default');

    expect(resource.schemas).toHaveLength(0);
  });

  it('should handle file without frontmatter', async () => {
    const filePath = join(suite.tempDir, 'test.md');
    const content = `# Content

No frontmatter here`;

    await fs.writeFile(filePath, content, 'utf-8');

    const resource = await parseMarkdownResource(filePath, 'test.md', 'default');

    expect(resource.schemas).toHaveLength(0);
  });

  it('should ignore non-string $schema values', async () => {
    const filePath = join(suite.tempDir, 'test.md');
    const content = `---
$schema: 123
title: My Document
---

# Content`;

    await fs.writeFile(filePath, content, 'utf-8');

    const resource = await parseMarkdownResource(filePath, 'test.md', 'default');

    expect(resource.schemas).toHaveLength(0);
  });

  it('should preserve frontmatter including $schema field', async () => {
    const filePath = join(suite.tempDir, 'test.md');
    const content = `---
$schema: ./schema.json
title: My Document
description: Test
---

# Content`;

    await fs.writeFile(filePath, content, 'utf-8');

    const resource = await parseMarkdownResource(filePath, 'test.md', 'default');

    expect(resource.frontmatter).toBeDefined();
    expect(resource.frontmatter?.$schema).toBe('./schema.json');
    expect(resource.frontmatter?.title).toBe('My Document');
    expect(resource.frontmatter?.description).toBe('Test');
  });
});
