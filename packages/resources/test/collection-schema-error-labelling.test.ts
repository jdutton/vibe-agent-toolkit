/* eslint-disable security/detect-non-literal-fs-filename -- test file operations are confined to temp directories */
/**
 * The collection-schema `catch` in `ResourceRegistry` speaks for the schema and
 * for nothing else.
 *
 * Its message — `Failed to load or parse frontmatter schema '<schema>'` — is a
 * claim about a file. It must therefore only be reachable when that file could
 * not be read, parsed or compiled. Frontmatter LINK validation runs afterwards,
 * over a schema that already compiled; a throw out of it is not a schema
 * failure and must not be relabelled as one.
 *
 * The throw that matters is the one the link fact tables raise on purpose:
 * `realpathFrom`/`siblingNamesFrom` crash on a missing row so that a fill/judge
 * divergence names its own remedy. These tests pin that the crash reaches the
 * caller intact rather than being reworded into a schema complaint — the fix is
 * the propagation, not a new finding code.
 */
import { mkdir, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FrontmatterLinkValidator from '../src/frontmatter-link-validator.js';
import { ResourceRegistry } from '../src/resource-registry.js';
import type { ProjectConfig } from '../src/schemas/project-config.js';
import type { ValidationResult } from '../src/schemas/validation-result.js';

import { createSchemaFile, setupTempDirTestSuite } from './test-helpers.js';

/** When set, the frontmatter link walk throws this instead of running. */
const linkFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }));

vi.mock('../src/frontmatter-link-validator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof FrontmatterLinkValidator>();
  return {
    ...actual,
    validateFrontmatterLinks: vi.fn(
      async (...args: Parameters<typeof actual.validateFrontmatterLinks>) => {
        if (linkFailure.error) {
          throw linkFailure.error;
        }
        return actual.validateFrontmatterLinks(...args);
      },
    ),
  };
});

const SCHEMA_FILE = 'doc.schema.json';
const SCHEMA_REF = './doc.schema.json';
const MISSING_SCHEMA_REF = './missing.schema.json';

/** A schema that reads, parses and compiles cleanly. */
const COMPILES_CLEANLY = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    source: { type: 'string', format: 'uri-reference' },
  },
};

/** Verbatim shape of the fill/judge divergence crash from `realpathFrom`. */
const FILL_DIVERGENCE_MESSAGE =
  'No canonical path for "/tmp/docs/target.md". Fill it with fillRealpaths() before judging.';

function configWithSchema(schemaRef: string): ProjectConfig {
  return {
    version: 1,
    resources: {
      collections: {
        docs: {
          include: ['docs/**/*.md'],
          validation: { frontmatterSchema: schemaRef, mode: 'strict' },
        },
      },
    },
  };
}

/** Write one collection document with the given frontmatter body. */
async function writeDoc(tempDir: string, frontmatter: string): Promise<string> {
  const docsDir = safePath.join(tempDir, 'docs');
  await mkdir(docsDir, { recursive: true });
  const filePath = safePath.join(docsDir, 'doc.md');
  await writeFile(filePath, `---\n${frontmatter}---\n\n# Doc\n`, 'utf-8');
  return filePath;
}

/** Validate a single collection document through a fresh registry. */
async function validateDoc(
  tempDir: string,
  schemaRef: string,
  frontmatter: string,
): Promise<ValidationResult> {
  const filePath = await writeDoc(tempDir, frontmatter);
  const registry = new ResourceRegistry({ baseDir: tempDir, config: configWithSchema(schemaRef) });
  await registry.addResource(filePath);
  return registry.validate({ skipGitIgnoreCheck: true });
}

describe('collection schema error labelling', () => {
  const suite = setupTempDirTestSuite('schema-error-labelling-');

  beforeEach(async () => {
    await suite.beforeEach();
    linkFailure.error = undefined;
  });
  afterEach(suite.afterEach);

  it('lets a frontmatter link-validation throw propagate instead of blaming the schema', async () => {
    await createSchemaFile(suite.tempDir, SCHEMA_FILE, COMPILES_CLEANLY);
    linkFailure.error = new Error(FILL_DIVERGENCE_MESSAGE);

    // The crash is the contract: a fill/judge divergence is a programming error
    // and must reach the operator with its own remedy, not be turned into a
    // finding about a schema that compiled perfectly well.
    await expect(
      validateDoc(suite.tempDir, SCHEMA_REF, 'title: "Doc"\nsource: "./target.md"\n'),
    ).rejects.toThrow(FILL_DIVERGENCE_MESSAGE);
  });

  it('still reports an unreadable schema as FRONTMATTER_SCHEMA_ERROR', async () => {
    const result = await validateDoc(suite.tempDir, MISSING_SCHEMA_REF, 'title: "Doc"\n');

    const schemaIssues = result.issues.filter((issue) => issue.code === 'FRONTMATTER_SCHEMA_ERROR');
    expect(schemaIssues).toHaveLength(1);
    expect(schemaIssues[0]?.message).toContain(
      `Failed to load or parse frontmatter schema '${MISSING_SCHEMA_REF}'`,
    );
  });

  it('keeps schema issues ahead of frontmatter link issues when the walk succeeds', async () => {
    await createSchemaFile(suite.tempDir, SCHEMA_FILE, COMPILES_CLEANLY);

    // No `title` (schema violation) plus a `source` pointing at nothing.
    const result = await validateDoc(suite.tempDir, SCHEMA_REF, 'source: "./nowhere.md"\n');

    const schemaIndex = result.issues.findIndex(
      (issue) => issue.code === 'FRONTMATTER_SCHEMA_ERROR',
    );
    const linkIndex = result.issues.findIndex((issue) =>
      issue.message.includes('field `source`'),
    );

    expect(schemaIndex).toBeGreaterThanOrEqual(0);
    expect(linkIndex).toBeGreaterThan(schemaIndex);
  });
});
