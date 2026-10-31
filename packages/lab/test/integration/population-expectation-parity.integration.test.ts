/**
 * The lab's reading of an arm's store switch must be vat's own: a lab that
 * expected a store where the built cli selects none (or the reverse) would fail
 * every honest store-off arm or pass a store-on one that wrote nothing.
 *
 * Integration-tier: it loads the BUILT cli (turbo orders `@vibe-agent-toolkit/cli#build` first).
 */

import { pathToFileURL } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { populationExpectation } from '../../src/harness/population-expectation.js';

/** The built cli module that owns the selector. */
const PROJECTION_STORE_MODULE = safePath.resolve(import.meta.dirname, '../../../cli/dist/utils/projection-store.js');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('populationExpectation — parity with the built cli', () => {
  it.for([
    {},
    { VAT_PROJECTION_STORE: 'off' },
    { VAT_PROJECTION_STORE: '' },
    { VAT_PROJECTION_STORE: 'sqlite' },
    { VAT_PROJECTION_STORE: 'maybe' },
    { VAT_PROJECTION_STORE: 'FALSE' },
    { VAT_CACHE: '0' },
    { VAT_CACHE: 'garbage' },
    { VAT_CACHE: 'no', VAT_PROJECTION_STORE: 'sqlite' },
  ] as Array<Record<string, string>>)('agrees on %o', async (set) => {
    const { projectionStoreSelected } = (await import(pathToFileURL(PROJECTION_STORE_MODULE).href)) as {
      projectionStoreSelected: () => boolean;
    };
    vi.stubEnv('VAT_PROJECTION_STORE', undefined);
    vi.stubEnv('VAT_CACHE', undefined);
    for (const [name, value] of Object.entries(set)) vi.stubEnv(name, value);

    expect(populationExpectation({ set, unset: [] }, process.platform).store).toBe(projectionStoreSelected());
  });
});
