/**
 * Integration tests for frontmatter URI-reference link validation.
 *
 * Each test builds a tiny in-temp-dir git repo so the gitignore code path
 * is exercised end-to-end through ResourceRegistry.validate().
 */

/* eslint-disable sonarjs/no-duplicate-string -- issue type constants repeated across tests */

import fs from 'node:fs';
import path from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ProjectConfig } from '../../src/schemas/project-config.js';
import { createGitRepo, setupTempDirTestSuite } from '../test-helpers.js';

// ---------------------------------------------------------------------------
// Project builder
// ---------------------------------------------------------------------------

interface ProjectSpec {
  schema: object;
  files: Record<string, string>; // relative path -> file contents
  gitignore?: string;
  config: ProjectConfig;
}

interface ProjectResult {
  projectRoot: string;
  markdownFiles: string[]; // absolute paths of all .md files
}

function buildProject(tempDir: string, spec: ProjectSpec): ProjectResult {
  createGitRepo(tempDir);

  if (spec.gitignore) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from test helper
    fs.writeFileSync(safePath.join(tempDir, '.gitignore'), spec.gitignore);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from test helper
  fs.mkdirSync(safePath.join(tempDir, 'schemas'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from test helper
  fs.writeFileSync(
    safePath.join(tempDir, 'schemas', 'prd.schema.json'),
    JSON.stringify(spec.schema, null, 2),
  );

  const markdownFiles: string[] = [];

  for (const [relPath, content] of Object.entries(spec.files)) {
    const abs = safePath.join(tempDir, relPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is constructed from trusted tempDir
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs is constructed from trusted tempDir
    fs.writeFileSync(abs, content);
    if (relPath.endsWith('.md')) {
      markdownFiles.push(abs);
    }
  }

  return { projectRoot: tempDir, markdownFiles };
}

/**
 * Build a registry from a project spec and validate it.
 * Uses addResource() per file instead of crawl() because crawl() relies on
 * git ls-files, which only returns committed/staged files. In these tests the
 * git repo is freshly initialised (git init only) with no staged files.
 */
async function validate(
  { projectRoot, markdownFiles }: ProjectResult,
  config: ProjectConfig,
) {
  const registry = new ResourceRegistry({ config, baseDir: projectRoot });
  for (const file of markdownFiles) {
    await registry.addResource(file);
  }
  return await registry.validate();
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    parent_prd: { type: 'string', format: 'uri-reference' },
    supersedes: { type: 'string', format: 'uri-reference' },
    adr_citations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          adr: { type: 'string', format: 'uri-reference' },
          note: { type: 'string' },
        },
      },
    },
    artifacts: { type: 'array', items: { type: 'string', format: 'uri-reference' } },
  },
};

const baseConfig: ProjectConfig = {
  version: 1,
  resources: {
    collections: {
      prds: {
        include: ['docs/*-prd.md'],
        validation: { frontmatterSchema: 'schemas/prd.schema.json', mode: 'permissive' },
      },
      adrs: { include: ['docs/adr/**/*.md'] },
    },
  },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const suite = setupTempDirTestSuite('vat-fm-link-');

describe('Frontmatter URI-reference link validation (integration)', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('produces no issues for a PRD with valid references', async () => {
    const project = buildProject(suite.tempDir, {
      schema: baseSchema,
      config: baseConfig,
      files: {
        'docs/valid-prd.md': [
          '---',
          'title: Valid PRD',
          'parent_prd: parent.md',
          'adr_citations:',
          '  - adr: adr/0001-foo.md',
          '  - adr: adr/0002-bar.md#decision',
          'artifacts:',
          '  - adr/0001-foo.md',
          '---',
          '# Valid PRD',
        ].join('\n'),
        'docs/parent.md': '# Parent PRD\n',
        'docs/adr/0001-foo.md': '# ADR 0001\n\n## Decision\n',
        'docs/adr/0002-bar.md': '# ADR 0002\n\n## Decision\n',
      },
    });

    const result = await validate(project, baseConfig);
    const validIssues = result.issues.filter((i) => i.resourcePath.endsWith('valid-prd.md'));
    expect(validIssues).toEqual([]);
  });

  it('reports broken file references and missing anchors', async () => {
    const project = buildProject(suite.tempDir, {
      schema: baseSchema,
      config: baseConfig,
      files: {
        'docs/broken-prd.md': [
          '---',
          'title: Broken PRD',
          'parent_prd: missing-parent.md',
          'supersedes: also-missing.md',
          'adr_citations:',
          '  - adr: adr/nonexistent.md',
          '  - adr: adr/0001-foo.md#bogus-anchor',
          'artifacts:',
          '  - adr/missing-artifact.md',
          '---',
          '# Broken PRD',
        ].join('\n'),
        'docs/adr/0001-foo.md': '# ADR 0001\n\n## Decision\n',
      },
    });

    const result = await validate(project, baseConfig);
    const brokenIssues = result.issues.filter(
      (i) => i.resourcePath.endsWith('broken-prd.md') && i.type === 'frontmatter_link_broken',
    );
    expect(brokenIssues).toHaveLength(4);
    const messages = brokenIssues.map((i) => i.message);
    expect(messages.some((m) => m.includes('parent_prd'))).toBe(true);
    expect(messages.some((m) => m.includes('supersedes'))).toBe(true);
    expect(messages.some((m) => m.includes('adr_citations[0].adr'))).toBe(true);
    expect(messages.some((m) => m.includes('artifacts[0]'))).toBe(true);

    const anchorIssues = result.issues.filter(
      (i) => i.resourcePath.endsWith('broken-prd.md') && i.type === 'frontmatter_anchor_missing',
    );
    expect(anchorIssues).toHaveLength(1);
    expect(anchorIssues[0]?.message).toContain('adr_citations[1].adr');
  });

  it('reports frontmatter_link_to_gitignored when referencing an ignored target', async () => {
    const project = buildProject(suite.tempDir, {
      schema: baseSchema,
      config: baseConfig,
      gitignore: 'docs/private/\n',
      files: {
        'docs/leaky-prd.md': [
          '---',
          'title: Leaky PRD',
          'parent_prd: private/secret.md',
          '---',
          '# Leaky PRD',
        ].join('\n'),
        'docs/private/secret.md': '# Secret\n',
      },
    });

    const result = await validate(project, baseConfig);
    const ignoredIssues = result.issues.filter(
      (i) => i.type === 'frontmatter_link_to_gitignored',
    );
    expect(ignoredIssues).toHaveLength(1);
    expect(ignoredIssues[0]?.message).toContain('parent_prd');
  });

  it('emits frontmatter_unknown_link for unknown URI schemes', async () => {
    const project = buildProject(suite.tempDir, {
      schema: baseSchema,
      config: baseConfig,
      files: {
        'docs/weird-prd.md': [
          '---',
          'title: Weird PRD',
          'parent_prd: "tel:+15555550100"',
          '---',
          '# Weird PRD',
        ].join('\n'),
      },
    });

    const result = await validate(project, baseConfig);
    const unknownIssues = result.issues.filter((i) => i.type === 'frontmatter_unknown_link');
    expect(unknownIssues).toHaveLength(1);
  });

  it('honors checkFrontmatterLinks: false', async () => {
    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          prds: {
            include: ['docs/*-prd.md'],
            validation: {
              frontmatterSchema: 'schemas/prd.schema.json',
              mode: 'permissive',
              checkFrontmatterLinks: false,
            },
          },
          adrs: { include: ['docs/adr/**/*.md'] },
        },
      },
    };

    const project = buildProject(suite.tempDir, {
      schema: baseSchema,
      config,
      files: {
        'docs/broken-prd.md': [
          '---',
          'title: Broken PRD',
          'parent_prd: missing.md',
          '---',
          '# Broken PRD',
        ].join('\n'),
      },
    });

    const result = await validate(project, config);
    const fmIssues = result.issues.filter(
      (i) =>
        i.type === 'frontmatter_link_broken' ||
        i.type === 'frontmatter_anchor_missing' ||
        i.type === 'frontmatter_unknown_link' ||
        i.type === 'frontmatter_link_to_gitignored',
    );
    expect(fmIssues).toEqual([]);
  });

  it('passes frontmatter external URLs through without emitting issues', async () => {
    // Absolute URLs → classified as external → silent unless checkUrlLinks: true.
    const project = buildProject(suite.tempDir, {
      schema: baseSchema,
      config: baseConfig,
      files: {
        'docs/external-prd.md': [
          '---',
          'title: External PRD',
          'parent_prd: https://example.com/parent',
          '---',
          '# External PRD',
        ].join('\n'),
      },
    });

    const result = await validate(project, baseConfig);
    const issues = result.issues.filter((i) => i.resourcePath.endsWith('external-prd.md'));
    expect(issues).toEqual([]);
  });
});
