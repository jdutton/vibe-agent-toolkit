/* eslint-disable sonarjs/no-duplicate-string */
// Test data legitimately repeats file paths and config patterns

import { afterAll, beforeAll, it } from 'vitest';

import { describe, expect, fs, getBinPath, join } from './test-common.js';
import {
  assertValidationFailureWithErrorInStderr,
  createMarkdownWithFrontmatter,
  createSchemaFile,
  createTestTempDir,
  executeValidateAndParse,
  setupTestProject,
} from './test-helpers.js';

const binPath = getBinPath(import.meta.url);

/**
 * Helper to create a test project with schemas and directories
 */
function setupCollectionTestProject(
  tempDir: string,
  projectName: string,
  config: string,
  schemas: Array<{ filename: string; schema: Record<string, unknown> }>,
  directories: string[]
): string {
  const projectDir = setupTestProject(tempDir, { name: projectName, config });

  // Create schemas
  for (const { filename, schema } of schemas) {
    createSchemaFile(projectDir, filename, schema);
  }

  // Create directories
  for (const dir of directories) {
    const fullPath = join(projectDir, dir);
    fs.mkdirSync(fullPath, { recursive: true });
  }

  return projectDir;
}

// Common test schemas
const STRICT_SCHEMA = {
  type: 'object',
  required: ['title', 'category'],
  properties: {
    title: { type: 'string' },
    category: { type: 'string' },
  },
  additionalProperties: false,
};

const PERMISSIVE_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
  },
  additionalProperties: true,
};

const GUIDES_SCHEMA = {
  type: 'object',
  required: ['title', 'level'],
  properties: {
    title: { type: 'string' },
    level: { enum: ['beginner', 'intermediate', 'advanced'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: true,
};

describe('Resources validate with collections (system test)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-collections-test-');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should apply collection-specific validation in strict mode', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'strict-collection-test',
      config: `version: 1
resources:
  exclude:
    - "node_modules/**"
  collections:
    strict-docs:
      include:
        - "docs/*.md"
      validation:
        frontmatterSchema: "strict-schema.json"
        mode: strict
`,
    });

    // Create schema
    createSchemaFile(projectDir, 'strict-schema.json', STRICT_SCHEMA);

    // Create docs directory
    const docsDir = join(projectDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });

    // Valid document
    createMarkdownWithFrontmatter(
      docsDir,
      'valid.md',
      { title: 'Valid Doc', category: 'guide' },
      '# Valid Content'
    );

    // Invalid document - missing required field + extra field
    createMarkdownWithFrontmatter(
      docsDir,
      'invalid.md',
      { title: 'Invalid Doc', extraField: 'not-allowed' },
      '# Invalid Content'
    );

    // Should fail with validation error - check stderr contains expected error
    const { textResult } = assertValidationFailureWithErrorInStderr(binPath, projectDir, 'invalid.md');

    // Also verify the specific field error
    expect(textResult.stderr).toContain('category'); // Missing required field
  });

  it('should allow extra fields in permissive mode', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'permissive-collection-test',
      config: `version: 1
resources:
  collections:
    permissive-guides:
      include:
        - "guides/*.md"
      validation:
        frontmatterSchema: "permissive-schema.json"
        mode: permissive
`,
    });

    // Create schema
    createSchemaFile(projectDir, 'permissive-schema.json', PERMISSIVE_SCHEMA);

    // Create guides directory
    const guidesDir = join(projectDir, 'guides');
    fs.mkdirSync(guidesDir, { recursive: true });

    // Document with extra fields (should be OK in permissive mode)
    createMarkdownWithFrontmatter(
      guidesDir,
      'extra-fields.md',
      {
        title: 'Guide with Extras',
        description: 'A guide',
        customField: 'custom-value',
        anotherField: 123,
      },
      '# Guide Content'
    );

    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    // Should succeed because permissive mode allows extra fields
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('should handle resources in multiple collections with compatible schemas', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'multi-collection-test',
      config: `version: 1
resources:
  collections:
    docs-collection:
      include:
        - "docs/**/*.md"
      validation:
        frontmatterSchema: "permissive-schema.json"
        mode: permissive
    guides-collection:
      include:
        - "**/guide*.md"
      validation:
        frontmatterSchema: "guides-schema.json"
        mode: permissive
`,
    });

    // Create schemas - both permissive to allow fields from each other
    createSchemaFile(projectDir, 'permissive-schema.json', PERMISSIVE_SCHEMA);
    createSchemaFile(projectDir, 'guides-schema.json', GUIDES_SCHEMA);

    // Create docs directory
    const docsDir = join(projectDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });

    // File matching both collections: docs/guide-intro.md
    // Must satisfy BOTH schemas (both permissive, so extra fields OK)
    createMarkdownWithFrontmatter(
      docsDir,
      'guide-intro.md',
      {
        title: 'Getting Started', // Required by both
        level: 'beginner', // Required by guides-schema
        description: 'A getting started guide', // Optional in permissive-schema
      },
      '# Introduction'
    );

    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    // Should succeed because it satisfies both schemas (both permissive)
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('should fail when resource violates one of multiple collections', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'multi-collection-fail-test',
      config: `version: 1
resources:
  collections:
    docs-collection:
      include:
        - "docs/**/*.md"
      validation:
        frontmatterSchema: "strict-schema.json"
        mode: strict
    guides-collection:
      include:
        - "**/guide*.md"
      validation:
        frontmatterSchema: "guides-schema.json"
        mode: permissive
`,
    });

    // Create schemas
    createSchemaFile(projectDir, 'strict-schema.json', STRICT_SCHEMA);
    createSchemaFile(projectDir, 'guides-schema.json', GUIDES_SCHEMA);

    // Create docs directory
    const docsDir = join(projectDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });

    // File matching both collections but missing required field from guides-schema
    createMarkdownWithFrontmatter(
      docsDir,
      'guide-intro.md',
      {
        title: 'Getting Started',
        category: 'tutorial', // Satisfies strict-schema
        // Missing 'level' required by guides-schema
      },
      '# Introduction'
    );

    // Should fail because it violates guides-schema
    const { textResult } = assertValidationFailureWithErrorInStderr(binPath, projectDir, 'guide-intro.md');

    // Also verify the specific field error
    expect(textResult.stderr).toContain('level'); // Missing required field
  });

  it('should handle resources in no collections (default validation only)', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'no-collection-test',
      config: `version: 1
resources:
  collections:
    docs-collection:
      include:
        - "docs/*.md"
      validation:
        frontmatterSchema: "strict-schema.json"
        mode: strict
`,
    });

    // Create schema
    createSchemaFile(projectDir, 'strict-schema.json', STRICT_SCHEMA);

    // Create docs directory
    const docsDir = join(projectDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });

    // Document in collection
    createMarkdownWithFrontmatter(
      docsDir,
      'in-collection.md',
      { title: 'In Collection', category: 'guide' },
      '# Content'
    );

    // Document NOT in collection (in root)
    createMarkdownWithFrontmatter(
      projectDir,
      'not-in-collection.md',
      { anything: 'goes' }, // No schema validation
      '# Root Content'
    );

    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    // Should succeed - not-in-collection.md doesn't need schema validation
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('should warn on missing schema file and report as failure', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'missing-schema-test',
      config: `version: 1
resources:
  collections:
    docs-collection:
      include:
        - "docs/*.md"
      validation:
        frontmatterSchema: "nonexistent-schema.json"
        mode: strict
`,
    });

    // Create docs directory
    const docsDir = join(projectDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });

    // Create markdown file
    createMarkdownWithFrontmatter(
      docsDir,
      'test.md',
      { title: 'Test' },
      '# Test Content'
    );

    // Should fail (exit code 1) due to error about missing schema
    assertValidationFailureWithErrorInStderr(binPath, projectDir, 'nonexistent-schema.json');
  });

  it('should apply different validation modes to different collections', () => {
    const projectDir = setupCollectionTestProject(
      tempDir,
      'mixed-modes-test',
      `version: 1
resources:
  collections:
    strict-docs:
      include:
        - "docs/*.md"
      validation:
        frontmatterSchema: "strict-schema.json"
        mode: strict
    permissive-guides:
      include:
        - "guides/*.md"
      validation:
        frontmatterSchema: "permissive-schema.json"
        mode: permissive
`,
      [
        { filename: 'strict-schema.json', schema: STRICT_SCHEMA },
        { filename: 'permissive-schema.json', schema: PERMISSIVE_SCHEMA },
      ],
      ['docs', 'guides']
    );

    const docsDir = join(projectDir, 'docs');
    const guidesDir = join(projectDir, 'guides');

    // Strict doc - must follow schema exactly
    createMarkdownWithFrontmatter(
      docsDir,
      'strict.md',
      { title: 'Strict Doc', category: 'api' },
      '# Strict Content'
    );

    // Permissive guide - extra fields allowed
    createMarkdownWithFrontmatter(
      guidesDir,
      'permissive.md',
      {
        title: 'Permissive Guide',
        extraField1: 'allowed',
        extraField2: 'also-allowed',
      },
      '# Permissive Content'
    );

    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    // Should succeed - both files validate according to their mode
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('should fail when strict mode doc has extra fields', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'strict-mode-fail-test',
      config: `version: 1
resources:
  collections:
    strict-docs:
      include:
        - "docs/*.md"
      validation:
        frontmatterSchema: "strict-schema.json"
        mode: strict
`,
    });

    // Create schema
    createSchemaFile(projectDir, 'strict-schema.json', STRICT_SCHEMA);

    // Create docs directory
    const docsDir = join(projectDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });

    // Document with extra field (not allowed in strict mode with additionalProperties: false)
    createMarkdownWithFrontmatter(
      docsDir,
      'extra-fields.md',
      {
        title: 'Doc with Extras',
        category: 'guide',
        extraField: 'not-allowed-in-strict',
      },
      '# Content'
    );

    // Should fail because strict mode + additionalProperties: false
    const { textResult } = assertValidationFailureWithErrorInStderr(binPath, projectDir, 'extra-fields.md');

    // Verify specific error about additional properties
    expect(textResult.stderr).toContain('must NOT have additional properties');
  });

  it('should validate resources with nested directory patterns', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'nested-patterns-test',
      config: `version: 1
resources:
  collections:
    api-docs:
      include:
        - "docs/api/**/*.md"
      validation:
        frontmatterSchema: "strict-schema.json"
        mode: strict
    tutorials:
      include:
        - "docs/tutorials/**/*.md"
      validation:
        frontmatterSchema: "guides-schema.json"
        mode: permissive
`,
    });

    // Create schemas
    createSchemaFile(projectDir, 'strict-schema.json', STRICT_SCHEMA);
    createSchemaFile(projectDir, 'guides-schema.json', GUIDES_SCHEMA);

    // Create nested directory structure
    const apiDir = join(projectDir, 'docs/api/auth');
    const tutorialsDir = join(projectDir, 'docs/tutorials/getting-started');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(tutorialsDir, { recursive: true });

    // API doc
    createMarkdownWithFrontmatter(
      apiDir,
      'authentication.md',
      { title: 'Authentication API', category: 'api' },
      '# Auth API'
    );

    // Tutorial doc
    createMarkdownWithFrontmatter(
      tutorialsDir,
      'setup.md',
      { title: 'Setup Guide', level: 'beginner', tags: ['setup', 'intro'] },
      '# Setup'
    );

    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    // Should succeed - both docs validate in their respective collections
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('should report all validation errors across multiple collections', () => {
    const projectDir = setupCollectionTestProject(
      tempDir,
      'multiple-errors-test',
      `version: 1
resources:
  collections:
    docs-collection:
      include:
        - "docs/*.md"
      validation:
        frontmatterSchema: "strict-schema.json"
        mode: strict
    guides-collection:
      include:
        - "guides/*.md"
      validation:
        frontmatterSchema: "guides-schema.json"
        mode: strict
`,
      [
        { filename: 'strict-schema.json', schema: STRICT_SCHEMA },
        { filename: 'guides-schema.json', schema: GUIDES_SCHEMA },
      ],
      ['docs', 'guides']
    );

    const docsDir = join(projectDir, 'docs');
    const guidesDir = join(projectDir, 'guides');

    // Invalid doc - missing category
    createMarkdownWithFrontmatter(
      docsDir,
      'invalid-doc.md',
      { title: 'Invalid Doc' },
      '# Content'
    );

    // Invalid guide - missing level
    createMarkdownWithFrontmatter(
      guidesDir,
      'invalid-guide.md',
      { title: 'Invalid Guide' },
      '# Guide Content'
    );

    // Should fail with multiple errors
    const { textResult, parsed } = assertValidationFailureWithErrorInStderr(binPath, projectDir, 'invalid-doc.md');

    expect(parsed.errorsFound).toBeGreaterThanOrEqual(2);

    // Check both errors in stderr
    expect(textResult.stderr).toContain('category');
    expect(textResult.stderr).toContain('invalid-guide.md');
    expect(textResult.stderr).toContain('level');
  });
});
