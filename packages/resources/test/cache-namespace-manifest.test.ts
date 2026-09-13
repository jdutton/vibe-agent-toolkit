/**
 * `vatCacheNamespace` reads VAT's OWN `package.json` for the version. The
 * `no-blind-catch` split: a manifest that is not at a candidate path is "try
 * the next"; a manifest that IS there but the OS refuses, or that is not JSON,
 * is a broken install and must not quietly become the `unknown` namespace —
 * which would file every cache entry under a bucket no other build reads.
 *
 * Its own file because the mock is module-wide: `node:fs` is replaced for every
 * module this file imports, and the memo inside `vatCacheNamespace` has to be
 * defeated with `vi.resetModules()` before each import.
 */

import type * as NodeFs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ManifestBehaviour = 'real' | { readonly throws: unknown };

const manifest = vi.hoisted(() => ({ behaviour: 'real' as ManifestBehaviour }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const readFileSync: typeof actual.readFileSync = (path, ...rest) => {
    if (manifest.behaviour !== 'real' && String(path).endsWith('package.json')) {
      throw manifest.behaviour.throws;
    }
    return actual.readFileSync(path, ...rest);
  };
  return { ...actual, readFileSync };
});

async function namespaceFromFreshModule(): Promise<string> {
  vi.resetModules();
  const { vatCacheNamespace } = await import('../src/cache-namespace.js');
  return vatCacheNamespace();
}

describe('vatCacheNamespace — the manifest read', () => {
  beforeEach(() => {
    manifest.behaviour = 'real';
  });

  afterEach(() => {
    manifest.behaviour = 'real';
  });

  it('reads the version from the real manifest (positive control)', async () => {
    expect(await namespaceFromFreshModule()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it('falls through to "unknown" only when NO candidate manifest is there', async () => {
    manifest.behaviour = { throws: Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }) };

    expect(await namespaceFromFreshModule()).toMatch(/^unknown/u);
  });

  it('throws when the OS refuses the manifest, rather than filing the cache under "unknown"', async () => {
    const refusal = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    manifest.behaviour = { throws: refusal };

    await expect(namespaceFromFreshModule()).rejects.toBe(refusal);
  });

  it('throws when the manifest is not JSON', async () => {
    const corrupt = new SyntaxError('Unexpected token in JSON');
    manifest.behaviour = { throws: corrupt };

    await expect(namespaceFromFreshModule()).rejects.toBe(corrupt);
  });
});
