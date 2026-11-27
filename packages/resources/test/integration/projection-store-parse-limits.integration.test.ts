/**
 * A run under other parse limits than the store's facts were filed under answers as store-off does.
 *
 * The store holds what a parse under `POPULATION_PARSE_LIMITS` produced, and a parse a run's own
 * limits stop is never stored, so no stored row can stand for a run that parses under tighter ones.
 * It is decided once, where a lane resolves the run's store (`populationOracles`, through
 * `hydratesUnder`), so every store path sees the store or none: the stored membership read, the
 * extent hit, the blob-tier read on an extent miss, admission, and the write.
 */

import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultParseCache } from '../../src/parse-cache.js';
import { ParseDispatcher } from '../../src/parse-dispatcher.js';
import type { ParseLimits } from '../../src/parse-limits.js';
import { BLOB_PARSE_LIMIT_EXCEEDED } from '../../src/projection/blob-condition-codes.js';
import { RunContentCache } from '../../src/projection/content-cache.js';
import { ContributorRegistry } from '../../src/projection/contributor.js';
import { DEFAULT_CONTENT_DEMAND, FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../../src/projection/crawl-source.js';
import { populate, populationOracles, type PopulateResult, type PopulationCache } from '../../src/projection/merge.js';
import { buildResourcePopulation, type ResourceEnumeration } from '../../src/projection/resource-population.js';
import { runStoredReads } from '../../src/projection/stored-reads.js';
import { FakeFactStore, WIDE_STORE_BUDGETS } from '../fake-fact-store.js';
import { createCommittedRepo } from '../test-helpers.js';

/** Frontmatter three mappings deep, `a.b.c`, in both documents. */
const NESTED = '---\na:\n  b:\n    c: 1\n---\n';

const TREE: Readonly<Record<string, string>> = {
  'README.md': `${NESTED}# Home\n\nSee [two](./docs/two.md).\n`,
  'docs/two.md': `${NESTED}# Two\n\nThe end.\n`,
};

/** A frontmatter depth cap under the three levels either document's frontmatter reaches. */
const TIGHT: Partial<Omit<ParseLimits, 'inputBytes'>> = { outputDepth: 2 };

let root = '';

beforeAll(() => {
  // The parse cache would serve a run what an earlier run parsed; this suite judges the store alone.
  vi.stubEnv('VAT_CACHE', '0');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  root = createCommittedRepo('vat-store-parse-limits-', { files: { ...TREE }, gitignore: '' });
});

afterEach(() => {
  removeTempDir(root);
});

/** The store-on half of a run: the store and the tree hash it is asked under. */
interface StoreUnder {
  readonly store: FakeFactStore;
  readonly treeHash: string;
}

/**
 * Run `work` under a run of its own, its dispatcher under `limits`, the run's store resolved the
 * one way every lane resolves it ({@link populationOracles}).
 */
async function underRun<T>(
  limits: Partial<Omit<ParseLimits, 'inputBytes'>> | undefined,
  cache: StoreUnder | undefined,
  work: (oracles: ReturnType<typeof populationOracles>) => Promise<T>,
): Promise<T> {
  const content = new RunContentCache();
  const dispatcher = new ParseDispatcher(defaultParseCache(), { content, ...(limits !== undefined && { limits }) });
  const store: PopulationCache | undefined = cache === undefined
    ? undefined
    : { store: cache.store, treeHash: cache.treeHash, treeUnchanged: () => true };
  try {
    return await work(populationOracles({ run: { content, dispatcher, stored: runStoredReads() }, cache: store }));
  } finally {
    await dispatcher.shutdown();
  }
}

/**
 * One population of {@link root} under a run of its own, its dispatcher under `limits`, through
 * `store` under `treeHash` or store-off.
 */
function populateUnder(limits: Partial<Omit<ParseLimits, 'inputBytes'>> | undefined, cache: StoreUnder | undefined): Promise<PopulateResult> {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor((at) => crawlSourceFor(at, []), DEFAULT_CONTENT_DEMAND));
  return underRun(limits, cache, (oracles) => populate({ root, registry, ...oracles }));
}

/** The resources lanes' membership of {@link root}, as {@link populateUnder} runs a population. */
function membershipUnder(limits: Partial<Omit<ParseLimits, 'inputBytes'>> | undefined, cache: StoreUnder | undefined): Promise<ResourceEnumeration> {
  return underRun(limits, cache, (oracles) => buildResourcePopulation({ root, outputs: [], ...oracles }));
}

/** The keys a projection refused at a parse limit. */
function limitRefused(result: PopulateResult): string[] {
  return result.projection.blobConditions.filter((row) => row.code === BLOB_PARSE_LIMIT_EXCEEDED).map((row) => row.blob);
}

describe('a run under tighter parse limits than the store was filed under', () => {
  it('answers as store-off does on an extent hit', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    await populateUnder(undefined, { store, treeHash: 'tree' });
    const storeOff = await populateUnder(TIGHT, undefined);
    expect(limitRefused(storeOff), 'the premise: the tight limits refuse both documents').toHaveLength(2);

    const tight = await populateUnder(TIGHT, { store, treeHash: 'tree' });

    expect(limitRefused(tight)).toEqual(limitRefused(storeOff));
    expect(tight.projection, 'row for row, in order').toEqual(storeOff.projection);
  });

  it('answers as store-off does on an extent miss, where the blob tier would serve the unchanged key', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    await populateUnder(undefined, { store, treeHash: 'tree' });
    await writeFile(safePath.join(root, 'docs/two.md'), `${NESTED}# Two\n\nEdited.\n`);
    const storeOff = await populateUnder(TIGHT, undefined);

    const tight = await populateUnder(TIGHT, { store, treeHash: 'tree-edited' });

    expect(limitRefused(tight)).toEqual(limitRefused(storeOff));
    expect(tight.projection, 'row for row, in order').toEqual(storeOff.projection);
  });

  it('reads and writes nothing, and says it ran store-off', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    await populateUnder(undefined, { store, treeHash: 'tree' });
    const before = { ...store };

    const tight = await populateUnder(TIGHT, { store, treeHash: 'tree-edited' });

    expect(tight.outcome).toEqual({ population: 'derived', stored: 'no-store' });
    expect(store.readExtentCalls - before.readExtentCalls).toBe(0);
    expect(store.readBlobFactsCalls - before.readBlobFactsCalls).toBe(0);
    expect(store.writeBlobFactsCalls - before.writeBlobFactsCalls).toBe(0);
    expect(store.writeExtentCalls - before.writeExtentCalls).toBe(0);
  });

  it('reads no stored membership: the membership lane runs store-off too', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    const primed = await membershipUnder(undefined, { store, treeHash: 'tree' });
    expect(primed.outcome.stored, 'the premise: the prime filed the membership extent').toBe('written');
    const storeOff = await membershipUnder(TIGHT, undefined);
    const before = { ...store };

    const tight = await membershipUnder(TIGHT, { store, treeHash: 'tree' });

    expect(store.readExtentCalls - before.readExtentCalls, 'stored membership reads').toBe(0);
    expect(tight.outcome).toEqual(storeOff.outcome);
    expect(tight.conditions).toEqual(storeOff.conditions);
    expect(tight.paths).toEqual(storeOff.paths);
    // A store-off derive admits by computing: no admission rows, from the store or from the projection.
    expect(tight.stored).toBeNull();
  });
});
