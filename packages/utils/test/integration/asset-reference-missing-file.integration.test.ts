/* eslint-disable security/detect-non-literal-fs-filename -- temp dir paths constructed in test setup */
import { rmSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resolveAssetReference } from '../../src/asset-reference.js';
import { mkdirSyncReal, safePath, toForwardSlash } from '../../src/path-utils.js';
import { setupSyncTempDirSuite } from '../../src/test-helpers.js';

/**
 * Regression test for the actual issue #102 root cause: when a package's
 * `exports` map resolves to a path that doesn't exist on disk (e.g. publisher
 * shipped package.json + exports map but its build never wrote the artifact),
 * VAT's error message must point at the missing file and the publisher's
 * build — not at the consumer's install state. The original misleading hint
 * ("run install in <baseDir>") cost multiple days of debugging in the
 * avonrisk-sdlc case.
 *
 * Fixture mirrors `@ihiservices/sdlc-data-types` shape: subpath-pattern
 * exports (`"./schemas/*.json": "./dist/schemas/*.json"`) + a workspace
 * package directly placed under `node_modules/`. (Symlink/junction variants
 * intentionally not modeled — Node's resolver handles those transparently;
 * the bug is in our error message, not in path resolution.)
 */

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

describe('resolveAssetReference exports-map missing-file diagnosis (integration)', () => {
  const suite = setupSyncTempDirSuite('vat-asset-ref-missing-');
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

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
