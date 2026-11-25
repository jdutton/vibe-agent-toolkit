import { promises as fs } from 'node:fs';

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isVatCacheRootEntryName, parseCacheDirectory, vatCacheNamespace, vatCacheNamespaceRoot } from '../src/cache-namespace.js';
import { vatCacheRoot } from '../src/cache-root.js';
import { isProjectionStoreDirectoryName, projectionShapeDigest, projectionStoreDirectoryName } from '../src/projection/store.js';
import { ParseFactsSchema, parseFactsShapeSource, schemaShapeSource } from '../src/schemas/parse-facts.js';

/** This package's own manifest version: the VAT version. */
async function manifestVersion(): Promise<string> {
  const manifestPath = safePath.join(resolveFromImportMeta(import.meta.url), '..', '..', 'package.json');
  return z.object({ version: z.string().min(1) }).parse(JSON.parse(await fs.readFile(manifestPath, 'utf8'))).version;
}

describe('vatCacheNamespace', () => {
  it('is the VAT version and nothing else, in a source checkout exactly as in an installed build', async () => {
    // The namespace is versioned by the VAT version only. Within one version no
    // code edit, rebuild, checkout location or dependency resolution moves it;
    // a developer who wants a cold cache clears it (`vat cache clear`).
    expect(vatCacheNamespace()).toBe(await manifestVersion());
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

describe('parseFactsShapeSource', () => {
  it('moves when an OPTIONAL field is added, the case validation provably cannot see', () => {
    // `ParseFactsSchema` accepts an entry that predates an optional field and an
    // entry that legitimately lacks one identically, because they are the same
    // bytes (pinned as a negative in parse-cache.test.ts). The shape source sees
    // the difference, so a parse-conformance report records it.
    const withNewOptionalField = ParseFactsSchema.extend({ someLaterAddition: z.string().optional() });

    expect(schemaShapeSource(withNewOptionalField)).not.toBe(parseFactsShapeSource());
  });

  it('ignores a reworded description, since prose is not shape', () => {
    const reworded = ParseFactsSchema.extend({
      estimatedTokenCount: z.number().int().nonnegative().describe('a rewording, and nothing else'),
    });

    expect(schemaShapeSource(reworded)).toBe(parseFactsShapeSource());
  });

  it('represents the recursive heading branch rather than collapsing it to `any`', () => {
    // Guards `$refStrategy: 'root'`. The wrapper's default of 'none' cannot
    // inline `HeadingNode`'s self-reference: it warns on the console and emits
    // `{}` for `children`, which would make every change under that branch
    // invisible here: a silent hole, not a loud one.
    expect(parseFactsShapeSource()).toContain('"$ref"');
  });

  it('is deterministic, so two processes on one build agree', () => {
    expect(parseFactsShapeSource()).toBe(parseFactsShapeSource());
  });
});

describe('cache layout', () => {
  // The test setup points VAT_CACHE_DIR at a per-file directory, so the root is that directory here; the
  // default spelling (`<tmpdir>/.vat-cache`) is pinned in cache-root.integration.test.ts.
  it('keeps the shared root free of the namespace', () => {
    expect(vatCacheRoot()).not.toContain(vatCacheNamespace());
  });

  it('puts build-dependent tenants under the namespace', () => {
    expect(vatCacheNamespaceRoot()).toBe(safePath.join(vatCacheRoot(), vatCacheNamespace()));
    expect(parseCacheDirectory()).toBe(safePath.join(vatCacheNamespaceRoot(), 'parse'));
  });

  it('leaves room beside parse/ for the projection store', () => {
    // A `projection-<shapeDigest>/` store is a sibling. Pinning the shape means the
    // `cache clear` root derivation (which walks up two levels) stays correct.
    expect(safePath.relative(vatCacheNamespaceRoot(), parseCacheDirectory())).toBe('parse');
  });
});

describe('the names prune may remove', () => {
  it('recognises namespaces of any VAT build, the suffixed names earlier builds wrote, and the legacy root names', () => {
    // `-dev-<hex>` (a source checkout before the namespace became the version alone) is left
    // behind in caches those builds wrote; prune must still see it as VAT's so it can remove it.
    for (const name of [vatCacheNamespace(), '0.1.42', '0.2.0-rc.17', '0.2.0-rc.17-dev-9f2c1a', 'external-links.json', 'auth-jeff', 'parse']) {
      expect(isVatCacheRootEntryName(name), name).toBe(true);
    }
  });

  it('recognises nothing else, so a foreign entry is never a candidate', () => {
    for (const name of ['CACHEDIR.TAG', 'notes.txt', 'node_modules', '.git', 'src', '1.2', 'v0.1.42', 'parse-old', 'auth-', 'projection-abc']) {
      expect(isVatCacheRootEntryName(name), name).toBe(false);
    }
  });

  it('names this build\'s store from the shape digest, and recognises every shape\'s store', () => {
    expect(projectionStoreDirectoryName()).toBe(`projection-${projectionShapeDigest()}`);
    expect(isProjectionStoreDirectoryName(projectionStoreDirectoryName())).toBe(true);
    expect(isProjectionStoreDirectoryName('projection-000000000000')).toBe(true);
    expect(isProjectionStoreDirectoryName('parse')).toBe(false);
  });
});
