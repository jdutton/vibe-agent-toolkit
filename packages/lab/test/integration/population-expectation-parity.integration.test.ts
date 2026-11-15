/**
 * The lab's reading of an arm's store and parse-cache switches must be vat's
 * own: a lab that expected a store (or a parse shard) where the built vat
 * writes none, or the reverse, would fail every honest cache-off arm or pass a
 * cache-on one that wrote nothing. Both halves are pinned: the store against
 * the cli's `projectionStoreSelected()`, the shard against `ParseCache`'s own
 * `enabled`, over one table of switches.
 *
 * Integration-tier: it loads the BUILT cli and resources (turbo orders
 * `@vibe-agent-toolkit/cli#build`, and so resources', first).
 */

import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { populationExpectation } from '../../src/harness/population-expectation.js';

/** The built cli module that owns the selector. */
const PROJECTION_STORE_MODULE = safePath.resolve(import.meta.dirname, '../../../cli/dist/utils/projection-store.js');

/** The built resources entry that owns `ParseCache`. */
const RESOURCES_MODULE = safePath.resolve(import.meta.dirname, '../../../resources/dist/index.js');

/** Every switch combination both halves are judged over. */
const SWITCHES: Array<Record<string, string>> = [
  {},
  { VAT_PROJECTION_STORE: 'off' },
  { VAT_PROJECTION_STORE: '' },
  { VAT_PROJECTION_STORE: 'sqlite' },
  { VAT_PROJECTION_STORE: 'maybe' },
  { VAT_PROJECTION_STORE: 'FALSE' },
  { VAT_CACHE: '0' },
  { VAT_CACHE: 'false' },
  { VAT_CACHE: 'garbage' },
  { VAT_CACHE: '' },
  { VAT_CACHE: 'no', VAT_PROJECTION_STORE: 'sqlite' },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('populationExpectation — parity with the built cli', () => {
  it.for(SWITCHES)('agrees with the store selector on %o', async (set) => {
    const { projectionStoreSelected } = (await import(pathToFileURL(PROJECTION_STORE_MODULE).href)) as {
      projectionStoreSelected: () => boolean;
    };
    vi.stubEnv('VAT_PROJECTION_STORE', undefined);
    vi.stubEnv('VAT_CACHE', undefined);
    for (const [name, value] of Object.entries(set)) vi.stubEnv(name, value);

    expect(populationExpectation({ set, unset: [] }, process.platform).store).toBe(projectionStoreSelected());
  });

  it.for(SWITCHES)("agrees with ParseCache's own switch on %o", async (set) => {
    const { ParseCache } = (await import(pathToFileURL(RESOURCES_MODULE).href)) as {
      ParseCache: new (options: { env: NodeJS.ProcessEnv; cacheDir: string }) => { readonly enabled: boolean };
    };
    // The cache is only constructed, never written: its directory need not exist.
    const cache = new ParseCache({ env: { ...set }, cacheDir: safePath.join(normalizedTmpdir(), 'lab-parity-never-written') });

    expect(populationExpectation({ set, unset: [] }, process.platform).parseShard).toBe(cache.enabled);
  });
});
