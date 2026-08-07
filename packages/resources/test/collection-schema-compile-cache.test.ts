/* eslint-disable security/detect-non-literal-fs-filename -- test file operations are confined to temp directories */
/**
 * Collection frontmatter schemas are read, parsed and Ajv-compiled ONCE per
 * (resolved schema file, mode) per registry — never once per resource.
 *
 * Compilation is counted by spying on the single choke point every compile goes
 * through, `createAjvWithUriFormats`. Counting calls rather than timing keeps
 * the assertion exact: "one compile for 12 documents" is a fact, not a
 * threshold that a slow CI box can flake on.
 */
import { mkdir, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAjvWithUriFormats } from '../src/ajv-factory.js';
import type * as AjvFactory from '../src/ajv-factory.js';
import {
  compileFrontmatterSchema,
  validateCompiledFrontmatter,
  validateFrontmatter,
} from '../src/frontmatter-validator.js';
import { ResourceRegistry } from '../src/resource-registry.js';
import type { ProjectConfig } from '../src/schemas/project-config.js';

import { createSchemaFile, setupTempDirTestSuite } from './test-helpers.js';

vi.mock('../src/ajv-factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AjvFactory>();
  return {
    ...actual,
    createAjvWithUriFormats: vi.fn(actual.createAjvWithUriFormats),
  };
});

/** Number of Ajv compilations performed since the last reset. */
function compileCount(): number {
  return vi.mocked(createAjvWithUriFormats).mock.calls.length;
}

const DOC_SCHEMA_FILE = 'doc.schema.json';
const DOC_SCHEMA_REF = './doc.schema.json';
const DOCS_COLLECTION = 'docs';

const REQUIRES_TITLE_AND_DESCRIPTION = {
  type: 'object',
  required: ['title', 'description'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
  },
};

const REQUIRES_CATEGORY = {
  type: 'object',
  required: ['category'],
  properties: {
    category: { type: 'string' },
  },
};

/** Build a config whose collections all match `docs/**` with the given schema specifiers. */
function configForSchemas(
  entries: Array<{ id: string; schema: string; mode?: 'strict' | 'permissive' }>,
): ProjectConfig {
  const collections: NonNullable<NonNullable<ProjectConfig['resources']>['collections']> = {};
  for (const { id, schema, mode } of entries) {
    collections[id] = {
      include: ['docs/**/*.md'],
      validation: { frontmatterSchema: schema, mode: mode ?? 'strict' },
    };
  }
  return { version: 1, resources: { collections } };
}

/** Write `count` documents whose frontmatter has a title but no description. */
async function writeDocs(tempDir: string, count: number): Promise<string[]> {
  const docsDir = safePath.join(tempDir, 'docs');
  await mkdir(docsDir, { recursive: true });

  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const filePath = safePath.join(docsDir, `doc-${i}.md`);
    await writeFile(filePath, `---\ntitle: "Doc ${i}"\n---\n\n# Doc ${i}\n`, 'utf-8');
    paths.push(filePath);
  }
  return paths;
}

/** Validate `filePaths` through a fresh registry and return the issues. */
async function validateWith(
  tempDir: string,
  config: ProjectConfig,
  filePaths: string[],
): Promise<ReturnType<ResourceRegistry['validate']>> {
  const registry = new ResourceRegistry({ baseDir: tempDir, config });
  for (const filePath of filePaths) {
    await registry.addResource(filePath);
  }
  return registry.validate({ skipGitIgnoreCheck: true });
}

describe('collection schema compile cache', () => {
  const suite = setupTempDirTestSuite('schema-compile-cache-');

  beforeEach(async () => {
    await suite.beforeEach();
    vi.mocked(createAjvWithUriFormats).mockClear();
  });
  afterEach(suite.afterEach);

  it('compiles a collection schema once for the whole corpus, not once per resource', async () => {
    await createSchemaFile(suite.tempDir, DOC_SCHEMA_FILE, REQUIRES_TITLE_AND_DESCRIPTION);
    const files = await writeDocs(suite.tempDir, 12);

    const result = await validateWith(
      suite.tempDir,
      configForSchemas([{ id: DOCS_COLLECTION, schema: DOC_SCHEMA_REF }]),
      files,
    );

    expect(compileCount()).toBe(1);

    // Output is unchanged by the caching: every resource still reports its own
    // issue, with the message the schema produces for it.
    const schemaIssues = result.issues.filter((issue) => issue.code === 'FRONTMATTER_SCHEMA_ERROR');
    expect(schemaIssues).toHaveLength(12);
    for (const issue of schemaIssues) {
      expect(issue.message).toContain('Missing required property: "description"');
    }
  });

  it('shares one compiled validator between collections whose specifiers resolve to the same file', async () => {
    await createSchemaFile(suite.tempDir, DOC_SCHEMA_FILE, REQUIRES_TITLE_AND_DESCRIPTION);
    const files = await writeDocs(suite.tempDir, 3);

    // Same file, two spellings: relative-to-config and absolute.
    const result = await validateWith(
      suite.tempDir,
      configForSchemas([
        { id: 'relative', schema: DOC_SCHEMA_REF },
        { id: 'absolute', schema: safePath.join(suite.tempDir, DOC_SCHEMA_FILE) },
      ]),
      files,
    );

    expect(compileCount()).toBe(1);
    // Both collections still validate: two issues per document, not one.
    expect(result.issues.filter((issue) => issue.code === 'FRONTMATTER_SCHEMA_ERROR')).toHaveLength(6);
  });

  it('compiles a separate validator for each distinct schema file', async () => {
    await createSchemaFile(suite.tempDir, DOC_SCHEMA_FILE, REQUIRES_TITLE_AND_DESCRIPTION);
    await createSchemaFile(suite.tempDir, 'category.schema.json', REQUIRES_CATEGORY);
    const files = await writeDocs(suite.tempDir, 4);

    await validateWith(
      suite.tempDir,
      configForSchemas([
        { id: DOCS_COLLECTION, schema: DOC_SCHEMA_REF },
        { id: 'categorized', schema: './category.schema.json' },
      ]),
      files,
    );

    expect(compileCount()).toBe(2);
  });

  it('compiles one validator per mode, because permissive mode compiles a rewritten clone', async () => {
    await createSchemaFile(suite.tempDir, DOC_SCHEMA_FILE, {
      ...REQUIRES_TITLE_AND_DESCRIPTION,
      additionalProperties: false,
    });
    const files = await writeDocs(suite.tempDir, 3);

    await validateWith(
      suite.tempDir,
      configForSchemas([
        { id: 'strict-docs', schema: DOC_SCHEMA_REF, mode: 'strict' },
        { id: 'permissive-docs', schema: DOC_SCHEMA_REF, mode: 'permissive' },
      ]),
      files,
    );

    expect(compileCount()).toBe(2);
  });

  it('does not share compiled schemas between registry instances', async () => {
    await createSchemaFile(suite.tempDir, DOC_SCHEMA_FILE, REQUIRES_TITLE_AND_DESCRIPTION);
    const files = await writeDocs(suite.tempDir, 5);
    const config = configForSchemas([{ id: DOCS_COLLECTION, schema: DOC_SCHEMA_REF }]);

    await validateWith(suite.tempDir, config, files);
    expect(compileCount()).toBe(1);

    await validateWith(suite.tempDir, config, files);
    expect(compileCount()).toBe(2);
  });

  it('picks up a schema edited between runs (the cache never outlives its registry)', async () => {
    await createSchemaFile(suite.tempDir, DOC_SCHEMA_FILE, REQUIRES_TITLE_AND_DESCRIPTION);
    const files = await writeDocs(suite.tempDir, 1);
    const config = configForSchemas([{ id: DOCS_COLLECTION, schema: DOC_SCHEMA_REF }]);

    const before = await validateWith(suite.tempDir, config, files);
    expect(before.issues[0]?.message).toContain('description');

    await createSchemaFile(suite.tempDir, DOC_SCHEMA_FILE, REQUIRES_CATEGORY);

    const after = await validateWith(suite.tempDir, config, files);
    expect(after.issues[0]?.message).toContain('category');
  });

  it('drops the cache on clear(), so a reused registry re-reads its schemas', async () => {
    await createSchemaFile(suite.tempDir, DOC_SCHEMA_FILE, REQUIRES_TITLE_AND_DESCRIPTION);
    const [file] = await writeDocs(suite.tempDir, 1);
    const config = configForSchemas([{ id: DOCS_COLLECTION, schema: DOC_SCHEMA_REF }]);

    const registry = new ResourceRegistry({ baseDir: suite.tempDir, config });
    await registry.addResource(file as string);
    await registry.validate({ skipGitIgnoreCheck: true });
    expect(compileCount()).toBe(1);

    registry.clear();
    await registry.addResource(file as string);
    await registry.validate({ skipGitIgnoreCheck: true });
    expect(compileCount()).toBe(2);
  });

  it('reports an unreadable schema identically for every resource, without retrying the read', async () => {
    const files = await writeDocs(suite.tempDir, 4);

    const result = await validateWith(
      suite.tempDir,
      configForSchemas([{ id: DOCS_COLLECTION, schema: './missing.schema.json' }]),
      files,
    );

    const loadErrors = result.issues.filter((issue) =>
      issue.message.includes('Failed to load or parse frontmatter schema'),
    );
    expect(loadErrors).toHaveLength(4);
    expect(new Set(loadErrors.map((issue) => issue.message)).size).toBe(1);
    expect(loadErrors[0]?.message).toContain('./missing.schema.json');
    // Nothing compiled: the failure happened before Ajv was reached, and the
    // cached failure is replayed rather than re-attempted.
    expect(compileCount()).toBe(0);
  });
});

describe('compileFrontmatterSchema / validateCompiledFrontmatter', () => {
  beforeEach(() => {
    vi.mocked(createAjvWithUriFormats).mockClear();
  });

  const frontmatter = { title: 'A doc', extra: 'field' };
  const schema = { ...REQUIRES_TITLE_AND_DESCRIPTION, additionalProperties: false };

  it.each(['strict', 'permissive'] as const)(
    'produces output identical to validateFrontmatter in %s mode',
    (mode) => {
      const oneShot = validateFrontmatter(frontmatter, schema, '/doc.md', mode, '/s.json', '/');
      const reused = validateCompiledFrontmatter(
        frontmatter,
        compileFrontmatterSchema(schema, mode),
        '/doc.md',
        '/s.json',
        '/',
      );

      expect(reused).toEqual(oneShot);
    },
  );

  it('compiles once and validates many documents through the same validator', () => {
    const compiled = compileFrontmatterSchema(REQUIRES_TITLE_AND_DESCRIPTION, 'strict');
    expect(compileCount()).toBe(1);

    const good = validateCompiledFrontmatter({ title: 't', description: 'd' }, compiled, '/a.md');
    const bad = validateCompiledFrontmatter({ title: 't' }, compiled, '/b.md');

    expect(good).toHaveLength(0);
    expect(bad).toHaveLength(1);
    // Still one compile after two validations — the validator is reused, and it
    // carries no state between calls.
    expect(compileCount()).toBe(1);
  });

  it('bakes the mode into the compiled schema', () => {
    const strict = compileFrontmatterSchema(schema, 'strict');
    const permissive = compileFrontmatterSchema(schema, 'permissive');
    const withExtra = { title: 't', description: 'd', extra: 'x' };

    expect(validateCompiledFrontmatter(withExtra, strict, '/a.md')).toHaveLength(1);
    expect(validateCompiledFrontmatter(withExtra, permissive, '/a.md')).toHaveLength(0);
    expect(strict.mode).toBe('strict');
    expect(permissive.mode).toBe('permissive');
  });
});
