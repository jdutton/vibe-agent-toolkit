/**
 * Seeding is what makes the offline `LOAD` possible, so its failure modes have
 * to be *reported*, never thrown at a CLI and never silently half-done.
 *
 * The fixtures here are small files, not the real 3 MB extension: seeding cares
 * about paths, sizes and hashes, and the size floor that a real extension has to
 * clear is `probe-path.ts`'s job, tested there.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath, setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  EXTENSION_MANIFEST_FILENAME,
  SHIPPED_EXTENSION_DIRNAME,
  loadShippedManifest,
  seedExtensionHome,
} from '../src/extension-seed.js';
import { DuckdbExtensionManifestSchema } from '../src/schemas/extension-manifest.js';

const RELATIVE_PATH = 'extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm';

/** Bytes every fixture ships as its "extension". */
const FIXTURE_BYTES = 'extension bytes';
/** The single extension every fixture manifest describes. */
const SEEDED = ['parquet'];

const suite = setupSyncTempDirSuite('vat-extension-seed');
beforeAll(suite.beforeAll);
afterAll(suite.afterAll);
beforeEach(suite.beforeEach);

/** A fresh, empty subdirectory of this test's temp dir. */
function subDir(name: string): string {
  const dir = safePath.join(suite.getTempDir(), name);
  mkdirSyncReal(dir, { recursive: true });
  return dir;
}

/** A stand-in package `dist/`: one extension file plus the manifest describing it. */
function fakeAssetDir(bytes: Buffer, options: { sha256?: string } = {}): string {
  const assetDir = subDir('assets');
  const target = safePath.join(assetDir, SHIPPED_EXTENSION_DIRNAME, RELATIVE_PATH);
  mkdirSyncReal(safePath.join(target, '..'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- every path here is inside a temp dir this test just created
  writeFileSync(target, bytes);
  const manifest = {
    repositoryHost: 'extensions.duckdb.org',
    coreVersion: 'v1.4.3',
    platform: 'wasm_eh',
    extensions: [
      {
        name: 'parquet',
        relativePath: RELATIVE_PATH,
        bytes: bytes.length,
        sha256: options.sha256 ?? createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- every path here is inside a temp dir this test just created
  writeFileSync(safePath.join(assetDir, EXTENSION_MANIFEST_FILENAME), JSON.stringify(manifest), 'utf8');
  return assetDir;
}

function seededPath(home: string): string {
  return safePath.join(home, '.duckdb/extensions', RELATIVE_PATH);
}

describe('seedExtensionHome', () => {
  it('mirrors the shipped tree verbatim below <home>/.duckdb/extensions', () => {
    const assetDir = fakeAssetDir(Buffer.from(FIXTURE_BYTES));
    const home = subDir('home');

    const outcome = seedExtensionHome({ home, assetDir });

    expect(outcome.failed).toEqual([]);
    expect(outcome.copied).toEqual(SEEDED);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- every path here is inside a temp dir this test just created
    expect(readFileSync(seededPath(home), 'utf8')).toBe(FIXTURE_BYTES);
  });

  it('is idempotent: a second call reuses rather than rewrites', () => {
    const assetDir = fakeAssetDir(Buffer.from(FIXTURE_BYTES));
    const home = subDir('home');

    expect(seedExtensionHome({ home, assetDir }).copied).toEqual(SEEDED);
    const second = seedExtensionHome({ home, assetDir });

    expect(second.copied).toEqual([]);
    expect(second.reused).toEqual(SEEDED);
  });

  it('replaces a file of the wrong size — a truncated seed is a load failure waiting to happen', () => {
    const assetDir = fakeAssetDir(Buffer.from(FIXTURE_BYTES));
    const home = subDir('home');
    const destination = seededPath(home);
    mkdirSyncReal(safePath.join(destination, '..'), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- every path here is inside a temp dir this test just created
    writeFileSync(destination, 'trunc');

    expect(seedExtensionHome({ home, assetDir }).copied).toEqual(SEEDED);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- every path here is inside a temp dir this test just created
    expect(readFileSync(destination, 'utf8')).toBe(FIXTURE_BYTES);
  });

  it('leaves no staging file behind', () => {
    const assetDir = fakeAssetDir(Buffer.from(FIXTURE_BYTES));
    const home = subDir('home');

    seedExtensionHome({ home, assetDir });

    const dir = safePath.join(home, '.duckdb/extensions/extensions.duckdb.org/v1.4.3/wasm_eh');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- every path here is inside a temp dir this test just created
    expect(readdirSync(dir)).toEqual(['parquet.duckdb_extension.wasm']);
  });

  it('reports — never throws — when the shipped bytes do not match the manifest hash', () => {
    const assetDir = fakeAssetDir(Buffer.from(FIXTURE_BYTES), { sha256: 'a'.repeat(64) });
    const home = subDir('home');

    const outcome = seedExtensionHome({ home, assetDir });

    expect(outcome.copied).toEqual([]);
    expect(outcome.failed[0]?.name).toBe('parquet');
    expect(outcome.failed[0]?.reason).toContain('manifest says');
    // Nothing half-copied: a partially seeded home is indistinguishable from a
    // poisoned one, and the engine would refuse it anyway.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- every path here is inside a temp dir this test just created
    expect(existsSync(seededPath(home))).toBe(false);
  });

  it('reports a missing manifest instead of throwing at a CLI', () => {
    const outcome = seedExtensionHome({ home: subDir('home'), assetDir: subDir('empty-assets') });

    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.reason).toContain('No DuckDB extension manifest');
  });
});

describe('DuckdbExtensionManifestSchema', () => {
  const valid = {
    repositoryHost: 'extensions.duckdb.org',
    coreVersion: 'v1.4.3',
    platform: 'wasm_eh',
    extensions: [
      { name: 'parquet', relativePath: RELATIVE_PATH, bytes: 3_045_039, sha256: 'a'.repeat(64) },
    ],
  };

  it('accepts a manifest of the shape the build script writes', () => {
    expect(DuckdbExtensionManifestSchema.parse(valid).coreVersion).toBe('v1.4.3');
  });

  it('rejects an empty extension list, which would seed nothing and read as fine', () => {
    expect(() => DuckdbExtensionManifestSchema.parse({ ...valid, extensions: [] })).toThrow();
  });

  it('rejects a hash that is not lowercase hex SHA-256', () => {
    const badHash = { ...valid, extensions: [{ ...valid.extensions[0], sha256: 'NOTAHASH' }] };
    expect(() => DuckdbExtensionManifestSchema.parse(badHash)).toThrow();
  });

  it('rejects a zero-byte entry', () => {
    const zero = { ...valid, extensions: [{ ...valid.extensions[0], bytes: 0 }] };
    expect(() => DuckdbExtensionManifestSchema.parse(zero)).toThrow();
  });
});

describe('loadShippedManifest', () => {
  it('names the missing file and the fix when the package was not built', () => {
    expect(() => loadShippedManifest(subDir('empty-assets'))).toThrow(/No DuckDB extension manifest/);
  });
});
