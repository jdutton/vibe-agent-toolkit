import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
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
