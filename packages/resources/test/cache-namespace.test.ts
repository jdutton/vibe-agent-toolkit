/* eslint-disable security/detect-non-literal-fs-filename -- test writes to temp dirs from computed paths */
import { promises as fs } from 'node:fs';

import { normalizedTmpdir, resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PARSER_BEHAVIOR_REVISION,
  devNamespaceDigest,
  parseCacheDirectory,
  vatCacheNamespace,
  vatCacheNamespaceRoot,
  vatCacheRoot,
} from '../src/cache-namespace.js';

/**
 * The emitted modules the *removed* build fingerprint used to stat.
 *
 * Kept here and nowhere else: they are no longer an input to anything, so a
 * production constant would be dead weight. The tests still need them by name,
 * because "a rebuild of exactly these files does not move the namespace" is the
 * property this change exists to create.
 */
const REBUILT_MODULE_FILES = [
  'link-parser.js',
  'html-link-parser.js',
  'content-key.js',
  'unresolved-references.js',
  'parse-cache.js',
  // The `.ts` siblings mattered too: under Vitest the old fingerprint fell back
  // to them, so a stability claim that ignored them would be testing half the
  // old behaviour.
  'link-parser.ts',
  'html-link-parser.ts',
  'content-key.ts',
  'unresolved-references.ts',
  'parse-cache.ts',
] as const;

/** Write every module the old fingerprint watched, with the given body. */
async function writeRebuiltModules(dir: string, body: string): Promise<void> {
  await Promise.all(REBUILT_MODULE_FILES.map(async (name) => fs.writeFile(safePath.join(dir, name), body)));
}

/** Stamp a distinct mtime on every module, the way `tsc --build` does. */
async function restampModules(dir: string, epochSeconds: number): Promise<void> {
  await Promise.all(
    REBUILT_MODULE_FILES.map(async (name) => fs.utimes(safePath.join(dir, name), epochSeconds, epochSeconds))
  );
}

/** The digest under the shipped revision — the common case in these tests. */
function digestOf(moduleDir: string): string {
  return devNamespaceDigest(moduleDir, PARSER_BEHAVIOR_REVISION);
}

describe('devNamespaceDigest', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-cache-namespace-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('survives a rebuild of every module the old fingerprint watched', async () => {
    // THE property this whole change exists for. The previous implementation
    // mixed size+mtime of exactly these files into the digest, so this test is
    // a negative control by construction: it was RED before, because both the
    // size (different body length) and the mtime move below.
    await writeRebuiltModules(tempDir, 'export const version = 1;');
    const before = digestOf(tempDir);

    await writeRebuiltModules(tempDir, 'export const version = 2; // rebuilt, and longer than before');
    await restampModules(tempDir, Date.now() / 1000 + 3600);
    const after = digestOf(tempDir);

    expect(after).toBe(before);
  });

  it('survives the modules disappearing entirely, as during a clean rebuild', async () => {
    // `build:clean` empties dist/ before repopulating it. The old fingerprint
    // recorded each missing module as `<name>:absent`, so mid-clean runs got
    // their own namespace; nothing about a parse fact changed.
    await writeRebuiltModules(tempDir, 'export const version = 1;');
    const populated = digestOf(tempDir);

    await Promise.all(REBUILT_MODULE_FILES.map(async (name) => fs.rm(safePath.join(tempDir, name))));

    expect(digestOf(tempDir)).toBe(populated);
  });

  it('moves when the parser behaviour revision is bumped', () => {
    // The replacement for the fingerprint: deliberate, hand-driven invalidation.
    expect(devNamespaceDigest(tempDir, PARSER_BEHAVIOR_REVISION + 1)).not.toBe(digestOf(tempDir));
  });

  it('moves when the module directory moves, so two worktrees never share a namespace', () => {
    // The one thing the path component is for. Every worktree reads the same
    // version from the same manifest, so without this, branch A and branch B
    // would collide — precisely when invalidation matters most.
    expect(digestOf(safePath.join(tempDir, 'other-worktree'))).not.toBe(digestOf(tempDir));
  });

  it('is six lowercase hex digits, so it is safe as a path segment', () => {
    expect(digestOf(tempDir)).toMatch(/^[0-9a-f]{6}$/u);
  });
});

describe('PARSER_BEHAVIOR_REVISION', () => {
  it('is a non-negative integer, so a bump is unambiguous in the digest', () => {
    expect(Number.isInteger(PARSER_BEHAVIOR_REVISION)).toBe(true);
    expect(PARSER_BEHAVIOR_REVISION).toBeGreaterThanOrEqual(0);
  });
});

describe('vatCacheNamespace', () => {
  it('starts with a semver-shaped version read from the package manifest', () => {
    // Read at runtime rather than compiled in: the version is already written
    // down, so nothing about it needs hand-maintaining.
    expect(vatCacheNamespace()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it('marks a source checkout as a dev namespace with a short discriminator', () => {
    // The suite necessarily runs from a checkout, never from node_modules — so
    // this is also the installed-vs-dev discrimination, exercised from the dev
    // side. An installed run takes the early return and gets `<version>` alone.
    const namespace = vatCacheNamespace();
    const marker = namespace.lastIndexOf('-dev-');
    expect(marker).toBeGreaterThan(0);
    expect(namespace.slice(marker + '-dev-'.length)).toMatch(/^[0-9a-f]{6}$/u);
  });

  it('derives its discriminator from the exported pure digest, not a private copy', () => {
    // Ties the memoized entry point to the function the tests above exercise:
    // without this, `devNamespaceDigest` could drift into being decoration.
    const moduleDir = safePath.join(resolveFromImportMeta(import.meta.url), '..', '..', 'src');
    expect(vatCacheNamespace().endsWith(`-dev-${digestOf(moduleDir)}`)).toBe(true);
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
