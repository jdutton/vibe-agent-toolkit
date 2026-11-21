/**
 * The home population's memo entry reports how it settled, once, through the
 * run's required `onHomeSettled`, under the one spelling of its key.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { afterAll, describe, expect, it } from 'vitest';

import { emptyBlobRows, type FactStore } from '../../src/index.js';
import type { PopulationCache } from '../../src/projection/merge.js';
import { type HomeSettlement, RunPopulation, withRunPopulation } from '../../src/projection/run-population.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A store that holds nothing, so the home population always derives. */
const EMPTY_STORE: FactStore = {
  writeBlobFacts: () => Promise.resolve(),
  readBlobFacts: () => Promise.resolve(emptyBlobRows()),
  writeExtent: () => Promise.resolve(),
  readExtent: () => Promise.resolve(undefined),
  close: () => Promise.resolve(),
};
const CACHE: PopulationCache = { store: EMPTY_STORE, treeHash: 'test-tree-hash', treeUnchanged: () => true };

interface Settled {
  readonly key: string;
  readonly settlement: HomeSettlement;
}

/** A run homed at a one-document tree, with `collectionsFor` and `onHomeSettled` as given. */
function inRun<T>(
  collectionsFor: () => Promise<undefined>,
  onHomeSettled: (key: string, settlement: HomeSettlement) => void,
  work: (population: RunPopulation, home: string) => Promise<T>,
): Promise<T> {
  const home = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-run-population-settle-'));
  roots.push(home);
  writeFileSync(safePath.join(home, 'README.md'), '# Home\n');
  return withRunPopulation(
    { root: home, gitTracker: new GitTracker(home), cacheOf: () => Promise.resolve(CACHE), collectionsFor, onHomeSettled },
    (population) => work(population, home),
  );
}

/** Enumerate the home as a refusing crawl does, which is the memoized population. */
async function enumerateHome(population: RunPopulation, home: string): Promise<unknown> {
  return population.source.enumerate(home, [], 'refuse', { include: ['**/*.md'], exclude: [], ignoredRefusals: 'record' });
}

/** Let the settle callbacks that were queued behind the awaited promise run. */
const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** Run `enumerations` against a home whose collections read is `collectionsFor`; the settlements reported, in order. */
async function settlementsOf(
  collectionsFor: () => Promise<undefined>,
  enumerations: (enumerate: () => Promise<unknown>) => Promise<void>,
): Promise<Settled[]> {
  const calls: Settled[] = [];
  await inRun(
    collectionsFor,
    (key, settlement) => calls.push({ key, settlement }),
    async (population, home) => {
      await enumerations(() => enumerateHome(population, home));
      await flush();
    },
  );
  return calls;
}

describe('onHomeSettled', () => {
  it('calls onHomeSettled once per home key, resolved', async () => {
    const calls = await settlementsOf(() => Promise.resolve(undefined), async (enumerate) => {
      await enumerate();
      await enumerate();
    });
    expect(calls).toHaveLength(1);
    const [only] = calls;
    expect(only?.key).toBe(RunPopulation.homeKey([]));
    expect(only?.settlement.ok).toBe(true);
    if (only?.settlement.ok === true) expect(only.settlement.enumeration.paths.length).toBeGreaterThan(0);
  });

  it('calls it with ok:false on a rejected populate and leaves the memoized rejection for the caller', async () => {
    const failure = new Error('collections unreadable');
    const calls = await settlementsOf(() => Promise.reject(failure), async (enumerate) => {
      await expect(enumerate()).rejects.toBe(failure);
      await expect(enumerate()).rejects.toBe(failure);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe(RunPopulation.homeKey([]));
    expect(calls[0]?.settlement).toEqual({ ok: false, error: failure });
  });
});
