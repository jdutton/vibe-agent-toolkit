/* eslint-disable security/detect-non-literal-fs-filename -- temp dir paths constructed in test setup */
import { symlinkSync } from 'node:fs';
import * as nodePath from 'node:path';

import { afterAll, beforeAll, it } from 'vitest';

import { describe, expect, fs, getBinPath, safePath } from './test-common.js';
import {
  createTestTempDir,
  executeValidateAndParse,
  setupTestProject,
} from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

/**
 * System repro for adopter (avonrisk-sdlc, pnpm 10, Windows CI) failure
 * in https://github.com/jdutton/vibe-agent-toolkit/issues/102.
 *
 * Unit-level (`resolveAssetReference`) and integration-level
 * (`ResourceRegistry.validate()`) scenarios in their respective integration
 * test files all PASSED on Windows CI against synthetic pnpm-style fixtures.
 * This system test exercises the highest remaining layer below
 * `pnpm exec` itself — spawning the real `vat` CLI against the fixture —
 * to determine whether the bug lives in the CLI shim / config-loader /
 * `findProjectRoot` path-handling layer.
 *
 * If this also passes on Windows CI, the bug must be specific to:
 *   - pnpm's `exec` wrapper (env/cwd/PATH handling),
 *   - pnpm's content-addressed `.pnpm/` store layout (not modeled here), or
 *   - some adopter-specific factor (a particular config interaction).
 */

const PKG_SCOPE = '@vat-test';
const PKG_NAME = 'sdlc-mirror';
const NODE_MODULES = 'node_modules';
const SCHEMA_FILENAME = 'skill-frontmatter.schema.json';
const BARE_SPECIFIER = `${PKG_SCOPE}/${PKG_NAME}/schemas/${SCHEMA_FILENAME}`;

function writePackageSource(packageRoot: string): void {
  const distSchemas = safePath.join(packageRoot, 'dist', 'schemas');
  fs.mkdirSync(distSchemas, { recursive: true });

  // Minimal schema — the test cares about whether the bare specifier resolves,
  // not about schema-validation semantics (covered by the integration tests).
  fs.writeFileSync(
    safePath.join(distSchemas, SCHEMA_FILENAME),
    JSON.stringify({ type: 'object' }),
  );

  fs.writeFileSync(
    safePath.join(packageRoot, 'package.json'),
    JSON.stringify({
      name: `${PKG_SCOPE}/${PKG_NAME}`,
      version: '0.0.0',
      type: 'module',
      exports: { './schemas/*.json': './dist/schemas/*.json' },
    }),
  );
}

function buildSymlinkFixture(tempDir: string): string {
  const projectDir = setupTestProject(tempDir, {
    name: 'bare-spec-symlink-fixture',
    config: `version: 1

resources:
  collections:
    skills:
      include: ["docs/*.md"]
      validation:
        frontmatterSchema: "${BARE_SPECIFIER}"
        mode: permissive
`,
  });

  // package.json declaring the workspace dep.
  fs.writeFileSync(
    safePath.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      version: '0.0.0',
      type: 'module',
      dependencies: { [`${PKG_SCOPE}/${PKG_NAME}`]: '*' },
    }),
  );

  // Workspace package source outside node_modules (mirrors `packages/<pkg>/`).
  const pkgSource = safePath.join(projectDir, 'packages', PKG_NAME);
  fs.mkdirSync(pkgSource, { recursive: true });
  writePackageSource(pkgSource);

  // Symlink/junction it into node_modules — mirrors pnpm's workspace linking.
  const linkParent = safePath.join(projectDir, NODE_MODULES, PKG_SCOPE);
  fs.mkdirSync(linkParent, { recursive: true });
  const linkPath = safePath.join(linkParent, PKG_NAME);
  const linkType: 'junction' | 'dir' = process.platform === 'win32' ? 'junction' : 'dir';
  // eslint-disable-next-line local/no-path-resolve -- need OS-native absolute path for Windows junction
  const target = nodePath.resolve(pkgSource);
  symlinkSync(target, linkPath, linkType);

  // SKILL.md under docs/ to be discovered by the collection.
  const docsDir = safePath.join(projectDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(
    safePath.join(docsDir, 'skill.md'),
    `---
name: example
description: A description satisfying the schema.
---

# Example
`,
  );

  return projectDir;
}

describe('vat resources validate against bare-specifier symlinked workspace pkg (system)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-bare-spec-cli-');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves bare specifier via the real CLI when the workspace pkg is symlinked into node_modules', () => {
    const projectDir = buildSymlinkFixture(tempDir);

    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    expect(
      result.status,
      `vat resources validate failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(parsed.status).toBe('success');
  });
});
