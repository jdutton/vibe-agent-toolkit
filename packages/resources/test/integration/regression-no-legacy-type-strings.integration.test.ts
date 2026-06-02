/**
 * Regression guard (Task G1): protect against a half-completed migration from the
 * 14 free-form lowercase issue `type` strings to SCREAMING_CASE registry `code`s.
 *
 * The resources package formerly emitted issues with lowercase free-form `type`
 * values (`broken_file`, `frontmatter_schema_error`, `external_url_dead`, …). These
 * were promoted into the unified code registry and are now emitted via
 * `createRegistryIssue('SCREAMING_CASE', …)`. The lowercase forms still legitimately
 * exist as the `entry()` reference slugs in agent-schema and as doc anchors — but a
 * LIVE emitter must never set one as an issue `code`.
 *
 * This test runs a real `ResourceRegistry.validate()` over a fixture that exercises
 * several issue kinds (a broken local link + a frontmatter schema violation) and
 * asserts that none of the 14 legacy lowercase strings appears as an emitted issue's
 * `code`, and that every emitted `code` is a SCREAMING_CASE registry key.
 */

import { promises as fs } from 'node:fs';

import { CODE_REGISTRY } from '@vibe-agent-toolkit/agent-schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ProjectConfig } from '../../src/schemas/project-config.js';
import { setupResourceTestSuite } from '../test-helpers.js';

/**
 * The 14 legacy free-form lowercase `type` strings. NONE of these may ever appear as
 * an emitted issue `code` — they survive only as registry reference slugs / doc anchors.
 */
const LEGACY_TYPE_STRINGS = [
  'broken_file',
  'broken_anchor',
  'unknown_link',
  'link_to_gitignored',
  'frontmatter_missing',
  'frontmatter_invalid_yaml',
  'frontmatter_schema_error',
  'frontmatter_link_broken',
  'frontmatter_anchor_missing',
  'frontmatter_link_to_gitignored',
  'frontmatter_unknown_link',
  'external_url_dead',
  'external_url_timeout',
  'external_url_error',
];

const SCREAMING_CASE = /^[A-Z][A-Z0-9_]+$/;

const FRONTMATTER_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

/**
 * Write a temp project that deterministically produces multiple issue kinds:
 * - a broken local link (→ LINK_BROKEN_FILE)
 * - frontmatter that violates the collection schema (→ FRONTMATTER_SCHEMA_ERROR)
 */
async function writeFixtureProject(tempDir: string): Promise<ProjectConfig> {
  const schemaPath = safePath.join(tempDir, 'schema.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is test-controlled
  await fs.writeFile(schemaPath, JSON.stringify(FRONTMATTER_SCHEMA, null, 2), 'utf-8');

  const docPath = safePath.join(tempDir, 'doc.md');
  // Missing required `title` → schema error; broken link → LINK_BROKEN_FILE.
  const docContent = `---
description: A document that violates the schema and contains a broken link
---

# Document

See [the missing target](./does-not-exist.md) for more.
`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is test-controlled
  await fs.writeFile(docPath, docContent, 'utf-8');

  return {
    version: 1,
    resources: {
      collections: {
        docs: {
          include: ['**/doc.md'],
          validation: {
            frontmatterSchema: 'schema.json',
            mode: 'strict',
          },
        },
      },
    },
  } satisfies ProjectConfig;
}

describe('Regression guard: no legacy lowercase type strings emitted as codes', () => {
  const suite = setupResourceTestSuite('regression-legacy-types-');

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('emits only SCREAMING_CASE registry codes, never the 14 legacy strings', async () => {
    const config = await writeFixtureProject(suite.tempDir);

    const registry = new ResourceRegistry({ config, baseDir: suite.tempDir });
    await registry.crawl({ baseDir: suite.tempDir });
    const result = await registry.validate();

    // The fixture must actually produce issues, otherwise the guard is vacuous.
    expect(result.issues.length).toBeGreaterThan(0);

    const registryKeys = new Set(Object.keys(CODE_REGISTRY));

    for (const issue of result.issues) {
      expect(LEGACY_TYPE_STRINGS).not.toContain(issue.code);
      expect(issue.code).toMatch(SCREAMING_CASE);
      // Every emitted code must be a real registry key.
      expect(registryKeys.has(issue.code)).toBe(true);
    }

    // Sanity: confirm the fixture exercised both emitter families we migrated
    // (link validation + frontmatter schema validation).
    const emittedCodes = new Set(result.issues.map((i) => i.code));
    expect(emittedCodes.has('LINK_BROKEN_FILE')).toBe(true);
    expect(emittedCodes.has('FRONTMATTER_SCHEMA_ERROR')).toBe(true);
  });
});
