/* eslint-disable security/detect-non-literal-fs-filename */
import { promises as fs } from 'node:fs';

import { safePath, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../src/resource-registry.js';
import type { ProjectConfig } from '../src/schemas/project-config.js';

/** ADR schema requiring three fields, so an unreadable document has something to fail. */
const ADR_SCHEMA = JSON.stringify({
  type: 'object',
  required: ['type', 'status', 'date'],
  properties: {
    type: { type: 'string' },
    status: { type: 'string' },
    date: { type: 'string' },
  },
});

const ADR_CONFIG: ProjectConfig = {
  version: 1,
  resources: {
    collections: {
      adrs: {
        include: ['**/*.md'],
        validation: { frontmatterSchema: 'schemas/adr.schema.json', mode: 'strict' },
      },
    },
  },
};

/** Write `doc` against {@link ADR_SCHEMA} and return the validation codes it produces. */
async function codesForAdrDoc(tempDir: string, doc: string): Promise<string[]> {
  await fs.mkdir(safePath.join(tempDir, 'schemas'), { recursive: true });
  await fs.writeFile(safePath.join(tempDir, 'schemas', 'adr.schema.json'), ADR_SCHEMA, 'utf-8');
  const docPath = safePath.join(tempDir, 'doc.md');
  await fs.writeFile(docPath, doc, 'utf-8');

  const registry = ResourceRegistry.empty(tempDir, { config: ADR_CONFIG });
  await registry.addResource(docPath);
  const result = await registry.validate({ skipGitIgnoreCheck: true });
  return result.issues.map((i) => i.code);
}

/**
 * E2 — proves the unified validation framework runs INSIDE
 * ResourceRegistry.validate() (not in the CLI). We assert that a
 * `validationConfig` severity override changes what `validate()` returns:
 * `ignore` drops the issue and `error` promotes it (flipping `hasErrors`).
 */
describe('ResourceRegistry.validate runs the validation framework', () => {
  const suite = setupAsyncTempDirSuite('registry-framework');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('drops a FRONTMATTER_SCHEMA_ERROR when severity is ignore (hasErrors false)', async () => {
    // A collection pointing at a non-existent schema file → validate() emits
    // FRONTMATTER_SCHEMA_ERROR (default severity 'error') for the matched doc.
    const docPath = safePath.join(tempDir, 'doc.md');
    await fs.writeFile(docPath, '---\ntitle: Hi\n---\n\n# Heading\n', 'utf-8');

    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          docs: {
            include: ['**/*.md'],
            validation: { frontmatterSchema: 'schemas/missing.schema.json' },
          },
        },
      },
    };

    const registry = ResourceRegistry.empty(tempDir, { config });
    await registry.addResource(docPath);

    // Baseline: without override the schema-load failure is an error.
    const baseline = await registry.validate({ skipGitIgnoreCheck: true });
    expect(baseline.issues.some((i) => i.code === 'FRONTMATTER_SCHEMA_ERROR')).toBe(true);
    expect(baseline.hasErrors).toBe(true);

    // With severity: ignore the framework drops the issue inside validate().
    const result = await registry.validate({
      skipGitIgnoreCheck: true,
      validationConfig: { severity: { FRONTMATTER_SCHEMA_ERROR: 'ignore' } },
    });

    expect(result.issues.some((i) => i.code === 'FRONTMATTER_SCHEMA_ERROR')).toBe(false);
    expect(result.hasErrors).toBe(false);
  });

  it('promotes a LINK_UNKNOWN warning to error when severity is error (hasErrors true)', async () => {
    // A `tel:` link is classified as an unknown link type → LINK_UNKNOWN
    // (default severity 'warning').
    const docPath = safePath.join(tempDir, 'links.md');
    await fs.writeFile(docPath, '# Title\n\n[call](tel:5551234)\n', 'utf-8');

    const registry = ResourceRegistry.empty(tempDir);
    await registry.addResource(docPath);

    // Baseline: warning-default → hasErrors false.
    const baseline = await registry.validate({ skipGitIgnoreCheck: true });
    const baselineIssue = baseline.issues.find((i) => i.code === 'LINK_UNKNOWN');
    expect(baselineIssue).toBeDefined();
    expect(baselineIssue?.severity).toBe('warning');
    expect(baseline.hasErrors).toBe(false);

    // With severity: error the framework promotes it inside validate().
    const result = await registry.validate({
      skipGitIgnoreCheck: true,
      validationConfig: { severity: { LINK_UNKNOWN: 'error' } },
    });

    const promoted = result.issues.find((i) => i.code === 'LINK_UNKNOWN');
    expect(promoted).toBeDefined();
    expect(promoted?.severity).toBe('error');
    expect(result.hasErrors).toBe(true);
  });

  it('surfaces a dangling reference-style link as LINK_UNRESOLVED_REFERENCE (warning, not hasErrors)', async () => {
    // End-to-end path: link-parser's raw-source scan (findUnresolvedReferences)
    // populates ResourceMetadata.unresolvedReferences, which
    // collectUnresolvedReferenceIssues() turns into a validate() issue —
    // proving the finding reaches a user-visible ValidationResult even though
    // it never becomes a `linkReference` AST node / ResourceLink.
    const docPath = safePath.join(tempDir, 'dangling-ref.md');
    await fs.writeFile(docPath, 'Line 1\n\nSee [some text][nope] for details.\n', 'utf-8');

    const registry = ResourceRegistry.empty(tempDir);
    await registry.addResource(docPath);

    const result = await registry.validate({ skipGitIgnoreCheck: true });

    const issue = result.issues.find((i) => i.code === 'LINK_UNRESOLVED_REFERENCE');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
    expect(issue?.line).toBe(3);
    expect(result.hasErrors).toBe(false);
  });

  /**
   * "Frontmatter that failed to parse" and "no frontmatter" are different facts,
   * and only one of them is true of any given file.
   *
   * Two lanes answer "does this file have frontmatter?" — the parser, which
   * records a `frontmatterError` and knows the block is present but broken, and
   * the schema validator, which sees only the parse *result*. A failed parse
   * yields `undefined`, which the schema validator read as "absent". So a file
   * with a duplicate YAML key drew BOTH `FRONTMATTER_INVALID_YAML` and
   * `FRONTMATTER_MISSING` — the second asserting "No frontmatter found in file"
   * about a file whose frontmatter is plainly there, handing the author two
   * conflicting remediations. Found on a real adopter monorepo: an archived ADR
   * declaring `superseded_by` twice.
   *
   * `collectYamlErrors` is unconditional, so the parse error always fires; the
   * schema lane must stay quiet about a document it could not read.
   */
  it('reports unparseable frontmatter as a YAML error only, never as missing frontmatter', async () => {
    const codes = await codesForAdrDoc(
      tempDir,
      '---\ntype: adr\narea: db\narea: platform\n---\n\n# Storage topology\n',
    );

    expect(codes).toContain('FRONTMATTER_INVALID_YAML');
    expect(codes).not.toContain('FRONTMATTER_MISSING');
    // Nor may it fault individual required fields — it never saw the document.
    expect(codes).not.toContain('FRONTMATTER_SCHEMA_ERROR');
  });

  it('still reports FRONTMATTER_MISSING for a file that genuinely has none', async () => {
    // The guard must not silence the real case sitting next to it.
    const codes = await codesForAdrDoc(tempDir, '# Just a heading, no frontmatter\n');

    expect(codes).toContain('FRONTMATTER_MISSING');
    expect(codes).not.toContain('FRONTMATTER_INVALID_YAML');
  });
});
