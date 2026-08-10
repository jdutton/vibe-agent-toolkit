/* eslint-disable security/detect-non-literal-fs-filename -- test writes to temp dirs from computed paths */
import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PARSER_MODULES,
  buildFingerprint,
  parseCacheDirectory,
  vatCacheNamespace,
  vatCacheNamespaceRoot,
  vatCacheRoot,
} from '../src/cache-namespace.js';

describe('vatCacheNamespace', () => {
  it('starts with a semver-shaped version read from the package manifest', () => {
    // Read at runtime rather than compiled in: a constant would need
    // maintaining by hand, which is the failure mode this module removes.
    expect(vatCacheNamespace()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it('marks a source checkout as a dev namespace with a short discriminator', () => {
    // The suite necessarily runs from a checkout, never from node_modules.
    const namespace = vatCacheNamespace();
    const marker = namespace.lastIndexOf('-dev-');
    expect(marker).toBeGreaterThan(0);
    expect(namespace.slice(marker + '-dev-'.length)).toMatch(/^[0-9a-f]{6}$/u);
  });

  it('is stable within a process, so two lookups cannot disagree', () => {
    expect(vatCacheNamespace()).toBe(vatCacheNamespace());
  });

  it('is a single path segment, so it cannot escape the cache root', () => {
    const namespace = vatCacheNamespace();
    expect(namespace).not.toContain('/');
    expect(namespace).not.toContain('\\');
    expect(namespace).not.toContain('..');
  });
});

describe('cache layout', () => {
  it('keeps the shared root free of the namespace', () => {
    expect(vatCacheRoot()).toBe(safePath.join(normalizedTmpdir(), '.vat-cache'));
  });

  it('puts build-dependent tenants under the namespace', () => {
    expect(vatCacheNamespaceRoot()).toBe(safePath.join(vatCacheRoot(), vatCacheNamespace()));
    expect(parseCacheDirectory()).toBe(safePath.join(vatCacheNamespaceRoot(), 'parse'));
  });

  it('leaves room beside parse/ for the tenants that come next', () => {
    // `parquet/` is planned as a sibling. Pinning the shape now means the
    // `cache clear` root derivation (which walks up two levels) stays correct
    // when it lands, rather than being rediscovered then.
    expect(safePath.relative(vatCacheNamespaceRoot(), parseCacheDirectory())).toBe('parse');
  });
});

describe('PARSER_MODULES', () => {
  it('includes unresolved-references.js, which link-parser.js imports for the unresolvedReferences fact', () => {
    // Confirmed via `grep -n "unresolved-references" src/link-parser.ts`: the
    // import is real, so a fact this module determines must be fingerprinted.
    expect(PARSER_MODULES).toContain('unresolved-references.js');
  });

  it('includes parse-cache.js, which defines the cached ParseFacts shape', () => {
    // dehydrate/rehydrate live here; a shape change (add/remove a field) must
    // invalidate old-shape entries the same way a parser change does.
    expect(PARSER_MODULES).toContain('parse-cache.js');
  });
});

describe('buildFingerprint', () => {
  const TS_MODULE_NAME = 'link-parser.ts';
  const JS_MODULE_NAME = 'link-parser.js';

  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-cache-namespace-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('changes when a fingerprinted module has no emitted .js but its .ts source changes', async () => {
    // Simulates running straight from packages/resources/src/*.ts (Vitest/tsx),
    // where there is no dist/*.js beside the source to stat.
    const tsPath = safePath.join(tempDir, TS_MODULE_NAME);
    await fs.writeFile(tsPath, 'export const version = 1;');
    const before = buildFingerprint(tempDir);

    await fs.writeFile(tsPath, 'export const version = 1; // edited, changes size');
    const after = buildFingerprint(tempDir);

    expect(after).not.toBe(before);
  });

  it('still prefers the emitted .js over a stale .ts sibling when both exist', async () => {
    // Dist-mode behavior must be unchanged: once a .js is emitted, it wins.
    const tsPath = safePath.join(tempDir, TS_MODULE_NAME);
    const jsPath = safePath.join(tempDir, JS_MODULE_NAME);
    await fs.writeFile(tsPath, 'export const version = 1;');
    await fs.writeFile(jsPath, 'exports.version = 1;');
    const withJs = buildFingerprint(tempDir);

    // Editing only the .ts sibling must not move the fingerprint while the .js
    // (what actually runs in dist mode) is untouched.
    await fs.writeFile(tsPath, 'export const version = 2;');
    const tsEditedJsUnchanged = buildFingerprint(tempDir);

    expect(tsEditedJsUnchanged).toBe(withJs);
  });

  it('records a module as absent when neither .js nor .ts exists beside it', () => {
    expect(buildFingerprint(tempDir)).toContain(`${JS_MODULE_NAME}:absent`);
  });
});
