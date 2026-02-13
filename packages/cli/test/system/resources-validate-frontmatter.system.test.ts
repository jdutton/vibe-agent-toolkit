import { afterEach, beforeEach, it } from 'vitest';

import { describe, expect, fs, getBinPath } from './test-common.js';
import { createTestTempDir, executeCli, setupSchemaAndValidate } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

// Common test constants
const SCHEMA_JSON = 'schema.json';
const SCHEMA_YAML = 'schema.yaml';
const TEST_CONTENT = '# Content';
const STATUS_SUCCESS = 'status: success';
const TEST_TITLE = 'Test Document';

// Common schemas for tests
const TITLE_DESCRIPTION_SCHEMA = {
  type: 'object',
  required: ['title', 'description'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
  },
};

const TITLE_ONLY_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
  },
};

describe('vat resources validate --frontmatter-schema (system test)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTestTempDir('vat-frontmatter-test-');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to validate with text format and return stderr output
   */
  function validateWithTextFormat(schemaFilename: string) {
    return executeCli(binPath, [
      'resources',
      'validate',
      tempDir,
      '--format',
      'text',
      '--frontmatter-schema',
      `${tempDir}/${schemaFilename}`,
    ]);
  }

  it('should validate frontmatter successfully', () => {
    const result = setupSchemaAndValidate(
      tempDir,
      TITLE_DESCRIPTION_SCHEMA,
      SCHEMA_JSON,
      {
        title: TEST_TITLE,
        description: 'A valid test document',
      },
      'valid.md',
      TEST_CONTENT,
      binPath
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(STATUS_SUCCESS);
  });

  it('should report frontmatter validation errors', () => {
    const result = setupSchemaAndValidate(
      tempDir,
      TITLE_DESCRIPTION_SCHEMA,
      SCHEMA_JSON,
      {
        title: TEST_TITLE,
        // missing description
      },
      'invalid.md',
      TEST_CONTENT,
      binPath
    );

    expect(result.status).toBe(1);

    // Check error details in stderr (use text format)
    const textResult = validateWithTextFormat(SCHEMA_JSON);
    expect(textResult.stderr).toContain('Frontmatter validation');
    expect(textResult.stderr).toContain('description');
  });

  it('should support YAML schema files', () => {
    const result = setupSchemaAndValidate(
      tempDir,
      TITLE_ONLY_SCHEMA,
      SCHEMA_YAML,
      {
        title: TEST_TITLE,
      },
      'valid.md',
      TEST_CONTENT,
      binPath
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(STATUS_SUCCESS);
  });

  it('should allow extra frontmatter fields by default', () => {
    const result = setupSchemaAndValidate(
      tempDir,
      TITLE_ONLY_SCHEMA,
      SCHEMA_JSON,
      {
        title: TEST_TITLE,
        customField: 'custom value',
        anotherField: 123,
      },
      'extra-fields.md',
      TEST_CONTENT,
      binPath
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(STATUS_SUCCESS);
  });

  it('should report missing frontmatter when required', () => {
    const result = setupSchemaAndValidate(
      tempDir,
      TITLE_ONLY_SCHEMA,
      SCHEMA_JSON,
      null,
      'no-frontmatter.md',
      '# Just Content\n\nNo frontmatter here.',
      binPath
    );

    expect(result.status).toBe(1);

    // Check error details in stderr (use text format)
    const textResult = validateWithTextFormat(SCHEMA_JSON);
    expect(textResult.stderr).toContain('No frontmatter found');
    expect(textResult.stderr).toContain('title');
  });
});
