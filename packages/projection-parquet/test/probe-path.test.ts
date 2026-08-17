/**
 * The probe path and the seed verdict are the two things standing between a
 * `LOAD` and an uninterruptible `Atomics.wait`, so they are pinned here without
 * a filesystem or an engine in the way.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath, setupSyncTempDirSuite, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  EXTENSION_CACHE_RELATIVE_DIR,
  EXTENSION_FILE_SUFFIX,
  type ExtensionCoordinates,
  MINIMUM_EXTENSION_BYTES,
  classifyExtensionSeed,
  extensionProbePath,
  extensionRelativePath,
  verifyExtensionSeed,
} from '../src/probe-path.js';

/**
 * Coordinates as a real run reported them (`pragma_version()` /
 * `pragma_platform()`, plus the host a real download created). Written down
 * HERE, in a test, and nowhere in `src/` — production derives all three.
 */
const MEASURED: ExtensionCoordinates = {
  repositoryHost: 'extensions.duckdb.org',
  coreVersion: 'v1.4.3',
  platform: 'wasm_eh',
};

const suite = setupSyncTempDirSuite('vat-probe-path');
beforeAll(suite.beforeAll);
afterAll(suite.afterAll);
beforeEach(suite.beforeEach);

describe('extensionRelativePath', () => {
  it('spells the four segments DuckDB keys its cache on, in order', () => {
    expect(extensionRelativePath(MEASURED, 'parquet')).toBe(
      'extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm',
    );
  });

  it('uses the same suffix DuckDB writes', () => {
    expect(extensionRelativePath(MEASURED, 'json').endsWith(EXTENSION_FILE_SUFFIX)).toBe(true);
  });

  it('carries the coordinates through rather than normalising them', () => {
    // A future DuckDB core version or wasm ABI token must flow through untouched:
    // the moment this function "helpfully" rewrites a segment, the derived path
    // stops being the path the engine probes — which is the hang.
    const future: ExtensionCoordinates = {
      repositoryHost: 'example.invalid',
      coreVersion: 'v99.0.0',
      platform: 'wasm_threads',
    };
    expect(extensionRelativePath(future, 'parquet')).toBe(
      'example.invalid/v99.0.0/wasm_threads/parquet.duckdb_extension.wasm',
    );
  });
});

describe('extensionProbePath', () => {
  it('places the tree under <home>/.duckdb/extensions', () => {
    const probePath = extensionProbePath('/home/someone', MEASURED, 'parquet');
    expect(probePath).toBe(
      `/home/someone/${EXTENSION_CACHE_RELATIVE_DIR}/extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm`,
    );
  });

  it('returns a forward-slashed path from a Windows-shaped home', () => {
    expect(toForwardSlash(extensionProbePath(String.raw`C:\Users\runner`, MEASURED, 'parquet'))).toContain(
      'C:/Users/runner/.duckdb/extensions/',
    );
  });
});

describe('classifyExtensionSeed', () => {
  it('rejects absence, the ONE condition that hangs', () => {
    const verdict = classifyExtensionSeed(undefined);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toContain('Atomics.wait');
  });

  it('rejects a directory sitting at the probe path', () => {
    expect(classifyExtensionSeed({ isFile: false, size: 4096 }).ok).toBe(false);
  });

  it('rejects a 15-byte poisoned cache entry, which existsSync alone would accept', () => {
    // Measured: an unchecked HTTP 404 body written straight to the cache path.
    const verdict = classifyExtensionSeed({ isFile: true, size: 15 });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toContain('poisoned');
  });

  it('rejects a file one byte below the floor and accepts one at it', () => {
    expect(classifyExtensionSeed({ isFile: true, size: MINIMUM_EXTENSION_BYTES - 1 }).ok).toBe(false);
    expect(classifyExtensionSeed({ isFile: true, size: MINIMUM_EXTENSION_BYTES }).ok).toBe(true);
  });

  it('accepts the measured size of the real parquet extension and reports it', () => {
    const verdict = classifyExtensionSeed({ isFile: true, size: 3_045_039 });
    expect(verdict).toEqual({ ok: true, bytes: 3_045_039 });
  });
});

describe('verifyExtensionSeed', () => {
  it('reports absence for a path that does not exist', () => {
    const missing = safePath.join(suite.getTempDir(), 'nothing.duckdb_extension.wasm');
    expect(verifyExtensionSeed(missing).ok).toBe(false);
  });

  it('accepts a file that clears the floor', () => {
    const target = safePath.join(suite.getTempDir(), 'parquet.duckdb_extension.wasm');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is inside a temp dir this test just created
    writeFileSync(target, Buffer.alloc(MINIMUM_EXTENSION_BYTES + 1));
    expect(verifyExtensionSeed(target)).toEqual({ ok: true, bytes: MINIMUM_EXTENSION_BYTES + 1 });
  });

  it('rejects a directory at the probe path instead of throwing', () => {
    const dir = safePath.join(suite.getTempDir(), 'parquet.duckdb_extension.wasm');
    mkdirSyncReal(dir, { recursive: true });
    expect(verifyExtensionSeed(dir).ok).toBe(false);
  });
});
