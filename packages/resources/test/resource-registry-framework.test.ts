/* eslint-disable security/detect-non-literal-fs-filename */
import { promises as fs } from 'node:fs';

import { safePath, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../src/resource-registry.js';
import type { ProjectConfig } from '../src/schemas/project-config.js';

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
});
