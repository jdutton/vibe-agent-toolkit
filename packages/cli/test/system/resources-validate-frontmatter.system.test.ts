import { afterEach, beforeEach, it } from 'vitest';

import { describe, expect, fs, getBinPath } from './test-common.js';
import { createTestTempDir, executeCli, setupSchemaAndValidate } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

// Common test constants
const SCHEMA_JSON = 'schema.json';
const SCHEMA_YAML = 'schema.yaml';
const TEST_CONTENT = '# Content';
const STATUS_OK = 'status: ok';
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

/**
 * Helper to validate with text format (one line per finding, on stdout)
 */
function validateWithTextFormat(dir: string, schemaFilename: string) {
  return executeCli(binPath, [
    'resources',
    'validate',
    dir,
    '--format',
    'text',
    '--frontmatter-schema',
    `${dir}/${schemaFilename}`,
  ]);
}

/** A project holding one document and a package whose exported schema was never built. */
function bareSpecifierProject(dir: string): void {
  fs.mkdirSync(`${dir}/docs`, { recursive: true });
  fs.writeFileSync(`${dir}/docs/a.md`, '---\ntitle: A\n---\n# A\n');
  const pkg = `${dir}/node_modules/@fake/pkg`;
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(`${pkg}/package.json`, JSON.stringify({ name: '@fake/pkg', exports: { './schema.json': './dist/schema.json' } }));
  // Installed, but its manifest is not JSON: it names something Node cannot read.
  fs.mkdirSync(`${dir}/node_modules/@fake/malformed`, { recursive: true });
  fs.writeFileSync(`${dir}/node_modules/@fake/malformed/package.json`, '{bad json');
}

/** A run that found something (exit 1) whose text rendering — one line per finding, stdout — holds each of `expected`. */
function expectTextFindings(status: number | null, dir: string, expected: readonly string[]): void {
  expect(status).toBe(1);
  const textResult = validateWithTextFormat(dir, SCHEMA_JSON);
  for (const text of expected) expect(textResult.stdout).toContain(text);
}

/** `vat resources validate` over {@link bareSpecifierProject} with its collection's frontmatterSchema set to `specifier`. */
function collectionSchemaFinding(dir: string, specifier: string): { stdout: string; status: number | null; finding: { code?: string; message?: string } | undefined } {
  bareSpecifierProject(dir);
  fs.writeFileSync(
    `${dir}/vibe-agent-toolkit.config.yaml`,
    `resources:\n  collections:\n    docs:\n      include: ['docs/*.md']\n      validation:\n        frontmatterSchema: '${specifier}'\n`,
  );
  const result = executeCli(binPath, ['resources', 'validate', '--format', 'json'], { cwd: dir });
  const report = JSON.parse(result.stdout) as { findings?: Array<{ code?: string; message?: string }> };
  return { stdout: result.stdout, status: result.status, finding: report.findings?.find((entry) => entry.code === 'FRONTMATTER_SCHEMA_ERROR') };
}

describe('vat resources validate --frontmatter-schema (system test)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTestTempDir('vat-frontmatter-test-');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

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
    expect(result.stdout).toContain(STATUS_OK);
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

    expectTextFindings(result.status, tempDir, ['Frontmatter validation', 'description']);
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
    expect(result.stdout).toContain(STATUS_OK);
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
    expect(result.stdout).toContain(STATUS_OK);
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

    expectTextFindings(result.status, tempDir, ['No frontmatter found', 'title']);
  });

  // A bare specifier that resolves to nothing is the operator's mistake, never INTERNAL_ERROR:
  // a package not installed, or one whose `exports` target is not on disk.
  describe('a schema named by a bare specifier that resolves to nothing', () => {
    const MISSING_PACKAGE = '@nope/missing/schema.json';
    const MISSING_TARGET = '@fake/pkg/schema.json';

    it.each([MISSING_PACKAGE, MISSING_TARGET])('--frontmatter-schema %s is USAGE_INVALID', (specifier) => {
      bareSpecifierProject(tempDir);
      const result = executeCli(binPath, ['resources', 'validate', 'docs', '--format', 'json', '--frontmatter-schema', specifier], { cwd: tempDir });

      expect(result.status).toBe(2);
      const report = JSON.parse(result.stdout) as { error?: { code?: string; message?: string } };
      expect(report.error?.code).toBe('USAGE_INVALID');
      expect(report.error?.message).toContain(specifier);
    });

    it.each([MISSING_PACKAGE, MISSING_TARGET])('a collection frontmatterSchema %s is a finding against the schema', (specifier) => {
      const { stdout, status, finding } = collectionSchemaFinding(tempDir, specifier);

      expect(stdout).not.toContain('INTERNAL_ERROR');
      expect(status).toBe(1);
      expect(finding?.message).toContain(specifier);
    });
  });

  // A package that is installed but unreadable names something: it is the package
  // that is broken, so it is never filed as naming nothing.
  describe('a schema named by a bare specifier whose package Node cannot read', () => {
    const MALFORMED = '@fake/malformed/schema.json';

    it('--frontmatter-schema is INPUT_UNREADABLE, not USAGE_INVALID', () => {
      bareSpecifierProject(tempDir);
      const result = executeCli(binPath, ['resources', 'validate', 'docs', '--format', 'json', '--frontmatter-schema', MALFORMED], { cwd: tempDir });

      expect(result.status).toBe(2);
      const report = JSON.parse(result.stdout) as { error?: { code?: string; message?: string } };
      expect(report.error?.code).toBe('INPUT_UNREADABLE');
      expect(report.error?.message).toContain('Node cannot read it');
    });

    it('a collection frontmatterSchema is a finding against the schema that says the package is unreadable', () => {
      const { status, finding } = collectionSchemaFinding(tempDir, MALFORMED);

      expect(status).toBe(1);
      expect(finding?.message).toContain('Node cannot read it');
    });
  });
});
