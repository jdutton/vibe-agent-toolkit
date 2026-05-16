/* eslint-disable security/detect-non-literal-fs-filename -- temp dir paths constructed in test setup */
import { symlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ProjectConfig } from '../../src/schemas/project-config.js';
import {
  setupTempDirTestSuite,
  writeMarkdownFileWithFrontmatter,
} from '../test-helpers.js';

/**
 * End-to-end repro for adopter (avonrisk-sdlc, pnpm 10, Windows CI) failure
 * in https://github.com/jdutton/vibe-agent-toolkit/issues/102.
 *
 * The companion unit-level test in `packages/utils/test/integration/asset-
 * reference-symlink.integration.test.ts` covers `resolveAssetReference` in
 * isolation — and passes on Windows CI even though the adopter fails.
 * This file drives the same fixture through the full
 * `ResourceRegistry.validate()` → `validateAgainstCollectionSchema` →
 * `resolveAssetReference` chain that the adopter's `vat resources validate`
 * invocation actually hits.
 *
 * Each scenario builds a consumer at `tempDir` with a workspace-symlinked
 * `@vat-test/sdlc-mirror` package whose `exports` use the same subpath-
 * pattern shape (`"./schemas/*.json": "./dist/schemas/*.json"`) as
 * `@ihiservices/sdlc-data-types`, then runs ResourceRegistry validation
 * against a SKILL.md.
 */

const PKG_SCOPE = '@vat-test';
const PKG_NAME = 'sdlc-mirror';
const BARE_SPECIFIER = '@vat-test/sdlc-mirror/schemas/skill-frontmatter.schema.json';
const NODE_MODULES = 'node_modules';
const SCHEMA_FILENAME = 'skill-frontmatter.schema.json';

function buildPackageSource(packageRoot: string): void {
  const distSchemas = safePath.join(packageRoot, 'dist', 'schemas');
  mkdirSyncReal(distSchemas, { recursive: true });

  writeFileSync(
    safePath.join(distSchemas, SCHEMA_FILENAME),
    JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' } },
      required: ['name', 'description'],
      additionalProperties: true,
    }),
    'utf-8',
  );

  writeFileSync(
    safePath.join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@vat-test/sdlc-mirror',
      version: '0.0.0',
      type: 'module',
      exports: { './schemas/*.json': './dist/schemas/*.json' },
    }),
    'utf-8',
  );
}

function buildConsumerPackageJson(consumerDir: string): void {
  writeFileSync(
    safePath.join(consumerDir, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      version: '0.0.0',
      type: 'module',
      dependencies: { '@vat-test/sdlc-mirror': '*' },
    }),
    'utf-8',
  );
}

async function writeSkill(consumerDir: string): Promise<string> {
  const docsDir = safePath.join(consumerDir, 'docs');
  await mkdir(docsDir, { recursive: true });
  const skillPath = safePath.join(docsDir, 'skill.md');
  await writeMarkdownFileWithFrontmatter(
    skillPath,
    { name: 'example', description: 'A description satisfying the schema.' },
    '# Example\n\nBody.\n',
  );
  return skillPath;
}

function buildConfig(): ProjectConfig {
  return {
    version: 1,
    resources: {
      collections: {
        skills: {
          include: ['docs/*.md'],
          validation: {
            frontmatterSchema: BARE_SPECIFIER,
            mode: 'permissive',
          },
        },
      },
    },
  };
}

async function setupSymlinkFixture(tempDir: string): Promise<{ skillPath: string }> {
  buildConsumerPackageJson(tempDir);

  // Workspace-pkg source outside node_modules (mirrors `packages/<pkg>/`)
  const pkgSource = safePath.join(tempDir, 'packages', PKG_NAME);
  mkdirSyncReal(pkgSource, { recursive: true });
  buildPackageSource(pkgSource);

  // Link node_modules/@scope/pkg → packages/<pkg>. On Windows pnpm uses
  // junctions to absolute paths.
  const linkParent = safePath.join(tempDir, NODE_MODULES, PKG_SCOPE);
  mkdirSyncReal(linkParent, { recursive: true });
  const linkPath = safePath.join(linkParent, PKG_NAME);
  const linkType: 'junction' | 'dir' = process.platform === 'win32' ? 'junction' : 'dir';
  // Junctions on Windows want OS-native absolute paths.
  // eslint-disable-next-line local/no-path-resolve -- need OS-native absolute path for Windows junction
  const targetAbs = nodePath.resolve(pkgSource);
  symlinkSync(targetAbs, linkPath, linkType);

  const skillPath = await writeSkill(tempDir);
  return { skillPath };
}

async function runRegistryValidationScenario(args: {
  tempDir: string;
  baseDir: string;
}): Promise<void> {
  const { skillPath } = await setupSymlinkFixture(args.tempDir);

  const registry = new ResourceRegistry({ baseDir: args.baseDir, config: buildConfig() });
  await registry.addResource(skillPath);

  const result = await registry.validate();

  const schemaErrors = result.issues.filter(
    (issue) =>
      issue.type === 'frontmatter_schema_error' ||
      (typeof issue.message === 'string' && issue.message.includes('Failed to resolve asset')),
  );
  expect(schemaErrors, JSON.stringify(result.issues, null, 2)).toEqual([]);
}

describe('ResourceRegistry collection validation with workspace-symlinked bare specifier (integration)', () => {
  const suite = setupTempDirTestSuite('vat-rr-symlink-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('resolves bare specifier via ResourceRegistry when package is a junction/symlink (mirrors adopter pnpm layout)', async () => {
    await runRegistryValidationScenario({ tempDir: suite.tempDir, baseDir: suite.tempDir });
  });

  it('resolves bare specifier via ResourceRegistry with OS-native baseDir (mirrors adopter projectRoot on Windows)', async () => {
    // CLI sets baseDir from findProjectRoot(process.cwd()) — OS-native
    // (backslashes on Windows). `safePath.resolve` would force forward slashes.
    // eslint-disable-next-line local/no-path-resolve -- deliberately OS-native to mirror CLI
    const osNativeBase = nodePath.resolve(suite.tempDir);
    await runRegistryValidationScenario({ tempDir: suite.tempDir, baseDir: osNativeBase });
  });
});
