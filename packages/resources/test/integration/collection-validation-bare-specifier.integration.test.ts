/* eslint-disable security/detect-non-literal-fs-filename -- temp dir paths constructed in test setup */
import { mkdir } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ProjectConfig } from '../../src/schemas/project-config.js';
import {
  setupTempDirTestSuite,
  writeMarkdownFileWithFrontmatter,
} from '../test-helpers.js';

/**
 * End-to-end check that ResourceRegistry resolves a bare-specifier
 * `frontmatterSchema` via `resolveAssetReference`, honoring the target
 * package's `exports` map. Uses the real workspace package
 * `@vibe-agent-toolkit/agent-skills` as the resolution target. The registry
 * is anchored at REPO_ROOT so the bare specifier resolves against the
 * workspace's installed packages.
 */
const REPO_ROOT = safePath.resolve(import.meta.dirname, '..', '..', '..', '..');

describe('Collection validation with npm bare-specifier schema (integration)', () => {
  const suite = setupTempDirTestSuite('vat-bare-spec-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('resolves @vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json via exports', async () => {
    const docsDir = safePath.join(suite.tempDir, 'docs');
    await mkdir(docsDir, { recursive: true });

    const skillPath = safePath.join(docsDir, 'skill.md');
    await writeMarkdownFileWithFrontmatter(
      skillPath,
      {
        name: 'example-skill',
        description: 'A short description used to satisfy the schema.',
      },
      '# Example\n\nBody content.\n',
    );

    const config: ProjectConfig = {
      version: 1,
      resources: {
        collections: {
          skills: {
            include: ['docs/*.md'],
            validation: {
              frontmatterSchema:
                '@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json',
              mode: 'permissive',
            },
          },
        },
      },
    };

    // Anchor the registry at REPO_ROOT so the bare specifier resolves
    // against the workspace's installed packages.
    const registry = new ResourceRegistry({ baseDir: REPO_ROOT, config });
    await registry.addResource(skillPath);

    const result = await registry.validate();

    const schemaErrors = result.issues.filter(
      (issue) => issue.code === 'FRONTMATTER_SCHEMA_ERROR',
    );
    expect(schemaErrors).toEqual([]);
  });
});
