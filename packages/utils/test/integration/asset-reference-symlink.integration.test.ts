/* eslint-disable security/detect-non-literal-fs-filename -- temp dir paths constructed in test setup */
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resolveAssetReference } from '../../src/asset-reference.js';
import { mkdirSyncReal, safePath, toForwardSlash } from '../../src/path-utils.js';
import { setupSyncTempDirSuite } from '../../src/test-helpers.js';

/**
 * Reproduce adopter (avonrisk-sdlc, pnpm 10, Windows CI) scenario for
 * `resolveAssetReference` with a bare specifier:
 *
 *   - Consumer at <tempDir> declares `@vat-test/sdlc-mirror` as a dep
 *   - Package source lives at <tempDir>/pkg-source
 *   - `<tempDir>/node_modules/@vat-test/sdlc-mirror` is a symlink (POSIX) or
 *     junction (Windows) to the package source — mirrors pnpm's workspace
 *     linking shape
 *   - Package's `exports` map uses the subpath-pattern form
 *     `"./schemas/*.json": "./dist/schemas/*.json"` — matches both
 *     `@ihiservices/sdlc-data-types` and `@vibe-agent-toolkit/agent-skills`
 *
 * The Linux+macOS path is well-trodden by `asset-reference.test.ts` and the
 * resources-level integration test. This file exists to catch the Windows
 * regression reported in https://github.com/jdutton/vibe-agent-toolkit/issues/102
 * via Windows CI, since the bug does not reproduce on POSIX.
 */

const SCHEMA_REL_PATH = 'dist/schemas/adr.schema.json';
const BARE_SPECIFIER = '@vat-test/sdlc-mirror/schemas/adr.schema.json';
const NODE_MODULES = 'node_modules';
const PKG_SCOPE = '@vat-test';
const PKG_NAME = 'sdlc-mirror';

function buildPackageSource(packageRoot: string): string {
  const distSchemas = safePath.join(packageRoot, 'dist', 'schemas');
  mkdirSyncReal(distSchemas, { recursive: true });

  const schemaPath = safePath.join(distSchemas, 'adr.schema.json');
  writeFileSync(
    schemaPath,
    JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { id: { type: 'string' } },
    }),
    'utf-8',
  );

  writeFileSync(
    safePath.join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@vat-test/sdlc-mirror',
      version: '0.0.0',
      type: 'module',
      exports: {
        './schemas/*.json': './dist/schemas/*.json',
      },
    }),
    'utf-8',
  );

  return schemaPath;
}

function setupDirectPackageFixture(tempDir: string): { expectedSchema: string } {
  buildConsumerPackageJson(tempDir);
  const directPkg = safePath.join(tempDir, NODE_MODULES, PKG_SCOPE, PKG_NAME);
  mkdirSyncReal(directPkg, { recursive: true });
  return { expectedSchema: buildPackageSource(directPkg) };
}

function buildConsumerPackageJson(consumerDir: string): void {
  writeFileSync(
    safePath.join(consumerDir, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      version: '0.0.0',
      type: 'module',
      dependencies: {
        '@vat-test/sdlc-mirror': '*',
      },
    }),
    'utf-8',
  );
}

describe('resolveAssetReference with workspace-symlink layout (integration)', () => {
  const suite = setupSyncTempDirSuite('vat-asset-ref-symlink-');
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('resolves bare specifier when package is a direct (non-symlinked) directory in node_modules', () => {
    const tempDir = suite.getTempDir();
    const { expectedSchema } = setupDirectPackageFixture(tempDir);

    const resolved = resolveAssetReference(BARE_SPECIFIER, tempDir);

    expect(toForwardSlash(resolved)).toBe(toForwardSlash(expectedSchema));
  });

  it('resolves bare specifier when node_modules/@scope/pkg is a symlink (mirrors pnpm workspace layout)', () => {
    const tempDir = suite.getTempDir();
    buildConsumerPackageJson(tempDir);

    // Real package source lives outside node_modules (mirrors workspace pkgs)
    const pkgSource = safePath.join(tempDir, 'pkg-source');
    mkdirSyncReal(pkgSource, { recursive: true });
    buildPackageSource(pkgSource);

    // Link it into node_modules. On Windows pnpm uses junctions; mirror that.
    const linkParent = safePath.join(tempDir, NODE_MODULES, PKG_SCOPE);
    mkdirSyncReal(linkParent, { recursive: true });
    const linkPath = safePath.join(linkParent, PKG_NAME);

    // Junctions require absolute target paths on Windows; use absolute on both.
    const linkType: 'junction' | 'dir' = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(safePath.resolve(pkgSource), linkPath, linkType);

    const resolved = resolveAssetReference(BARE_SPECIFIER, tempDir);

    // Resolution may surface either the link path or the realpath target;
    // both refer to the same on-disk file. Accept either.
    const resolvedFwd = toForwardSlash(resolved);
    const expectedThroughLink = toForwardSlash(safePath.join(linkPath, SCHEMA_REL_PATH));
    const expectedThroughRealpath = toForwardSlash(safePath.join(pkgSource, SCHEMA_REL_PATH));
    expect([expectedThroughLink, expectedThroughRealpath]).toContain(resolvedFwd);
  });

  it('resolves bare specifier when baseDir is passed in OS-native form (backslashes on Windows)', () => {
    const tempDir = suite.getTempDir();
    const { expectedSchema } = setupDirectPackageFixture(tempDir);

    // Adopter callers typically pass `process.cwd()` (OS-native separators)
    // or a config baseDir read from disk. `safePath.resolve` would force
    // forward slashes; we want backslashes on Windows to exercise the
    // separator-handling path the adopter actually hits.
    // eslint-disable-next-line local/no-path-resolve -- deliberately exercising OS-native baseDir
    const osNativeBase = nodePath.resolve(tempDir);

    const resolved = resolveAssetReference(BARE_SPECIFIER, osNativeBase);

    expect(toForwardSlash(resolved)).toBe(toForwardSlash(expectedSchema));
  });

  // Regression test for the actual issue #102 root cause. The adopter shipped a
  // package whose `exports` map pointed `./schemas/*.json` → `./dist/schemas/*.json`
  // but its `dist/schemas/` was empty on disk (a publisher-side build glitch:
  // the package's `gen-schemas` script had a broken Windows main-module check,
  // so the write loop never ran on Windows). VAT's resolver correctly threw
  // MODULE_NOT_FOUND — but the original error message ("Cannot find module
  // 'C:\...\dist\schemas\adr.schema.json'. Check the package's exports field,
  // or run install in <baseDir>") pointed everyone at VAT and at install state,
  // turning an obvious "publisher didn't build the artifact" into a multi-day
  // platform-bug hunt.
  //
  // This test pins the *adopter-facing diagnosis*: when the exports map
  // resolves to a path that doesn't exist on disk, VAT must say so plainly,
  // name the missing file, and point at the publishing package's build —
  // not at the consumer's install.
  it('error message names the missing on-disk file when exports map points to a non-existent path', () => {
    const tempDir = suite.getTempDir();
    const { expectedSchema } = setupDirectPackageFixture(tempDir);

    // Simulate a publisher that shipped package.json + exports map but did
    // not produce the build output. Delete the schema file (and the schemas
    // dir) — the exports pattern still maps to this path.
    rmSync(expectedSchema);

    let err: unknown;
    try {
      resolveAssetReference(BARE_SPECIFIER, tempDir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;

    // Must name the original specifier (so the user can find the offending config line)
    expect(message).toContain(BARE_SPECIFIER);
    // Must name the resolved on-disk path (so the user can verify it's missing)
    expect(toForwardSlash(message)).toContain(toForwardSlash(expectedSchema));
    // Must explain that the file is missing on disk, not that the package is missing
    expect(message).toMatch(/does not exist on disk/);
    // Must point at the publisher's build, not the consumer's install
    expect(message).toMatch(/[Rr]ebuild|build step|"exports" subpath/);
    // Should NOT push the user toward running install in baseDir — that was
    // the unhelpful hint that wasted hours of debugging in the avonrisk-sdlc
    // case. The package is installed; the publisher's build is incomplete.
    expect(message).not.toMatch(/run install in/);
  });
});
