import { afterAll, beforeAll, it } from 'vitest';

import { describe, expect, fs, getBinPath, safePath } from './test-common.js';
import {
  createMarkdownWithFrontmatter,
  createSchemaFile,
  createTestTempDir,
  executeCli,
  setupTestProject,
} from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

// Schema that declares parent_prd as uri-reference so the link walker fires.
const PRD_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    parent_prd: { type: 'string', format: 'uri-reference' },
  },
};

/**
 * Setup a project with a broken frontmatter link (parent_prd points to a missing file).
 */
function setupBrokenFrontmatterLinkProject(tempDir: string, name: string): string {
  const projectDir = setupTestProject(tempDir, {
    name,
    config: `version: 1
resources:
  collections:
    prds:
      include:
        - "docs/*.md"
      validation:
        frontmatterSchema: "schemas/prd.schema.json"
        mode: permissive`,
  });

  // Create schema
  const schemasDir = safePath.join(projectDir, 'schemas');
  fs.mkdirSync(schemasDir, { recursive: true });
  createSchemaFile(schemasDir, 'prd.schema.json', PRD_SCHEMA);

  // Create docs dir and a file with a broken frontmatter link
  const docsDir = safePath.join(projectDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  createMarkdownWithFrontmatter(
    docsDir,
    'broken.md',
    { title: 'Broken', parent_prd: 'missing.md' },
    '# Broken',
  );

  return projectDir;
}

describe('vat resources validate --no-check-frontmatter-links (system test)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-fm-flag-');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports frontmatter_link_broken without the flag', () => {
    const projectDir = setupBrokenFrontmatterLinkProject(tempDir, 'without-flag');

    const result = executeCli(binPath, ['resources', 'validate'], { cwd: projectDir });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('frontmatter_link_broken');
  });

  it('suppresses frontmatter_link_broken with --no-check-frontmatter-links', () => {
    const projectDir = setupBrokenFrontmatterLinkProject(tempDir, 'with-flag');

    const result = executeCli(binPath, ['resources', 'validate', '--no-check-frontmatter-links'], { cwd: projectDir });

    expect(result.stdout + result.stderr).not.toContain('frontmatter_link_broken');
  });
});
