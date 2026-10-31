/**
 * `withResourcePopulationSource` — the one seam that puts a command which does
 * NOT go through `loadResourcesWithConfig` onto the projection lane.
 *
 * `vat skills build`, `vat skills validate` and `vat claude plugin build` all
 * build their own registry, so they cannot reach the lane through the resource
 * loader. This helper is the shared answer: same selector, same store, same
 * git-ignore oracle, handed back as a source the caller threads into whichever
 * builder it owns.
 *
 * The assertions here are about the SELECTOR and the SOURCE'S ANSWER, never
 * about the environment being set — an opt-in that reports itself from the env
 * it read rather than from what it did is the exact failure this lane keeps
 * hitting.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RESOURCES_CRAWL_ENV,
  RESOURCES_CRAWL_PROJECTION,
  RESOURCES_CRAWL_WALK,
  withResourcePopulationSource,
  type PopulationObservation,
} from '../../src/utils/resource-loader.js';

/** Observers that ignore what they are told — for the cases about something else. */
const IGNORE = { observeExtentSource: (): void => undefined, observePopulation: (): void => undefined };

/** Observers that record every population observation, so "exactly once" is assertable. */
function recording(): { observed: PopulationObservation[]; observers: typeof IGNORE } {
  const observed: PopulationObservation[] = [];
  return {
    observed,
    observers: {
      observeExtentSource: () => undefined,
      observePopulation: (observation) => {
        observed.push(observation);
      },
    },
  };
}

/** The two fixture members, named once so the writes and the expectation agree. */
const GUIDE_REL = 'docs/guide.md';
const ASSET_REL = 'docs/asset.txt';

let root: string;

beforeEach(() => {
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-population-source-'));
  // Both fixture members sit under one directory, so it is made once here and
  // each write below is a plain `writeFileSync` rather than a local helper.
  mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
});

afterEach(() => {
  delete process.env[RESOURCES_CRAWL_ENV];
  rmSync(root, { recursive: true, force: true });
});

describe('withResourcePopulationSource', () => {
  it('hands back a source when the selector is unset, because the projection lane is the default', async () => {
    const received = await withResourcePopulationSource({ root, ...IGNORE }, async (source) => source);

    expect(received).toBeDefined();
  });

  it('hands back NO source when opted out to the walk', async () => {
    // The escape hatch has to actually reach this seam: an opt-out that still
    // installed a population source would leave the walk unreachable, and the
    // lane label would be the only thing that changed.
    process.env[RESOURCES_CRAWL_ENV] = RESOURCES_CRAWL_WALK;

    try {
      const received = await withResourcePopulationSource({ root, ...IGNORE }, async (source) => source);

      expect(received).toBeUndefined();
    } finally {
      delete process.env[RESOURCES_CRAWL_ENV];
    }
  });

  it('hands back a source that enumerates the tree when the selector chose the projection lane', async () => {
    writeFileSync(safePath.join(root, GUIDE_REL), '# guide\n', 'utf-8');
    writeFileSync(safePath.join(root, ASSET_REL), 'asset', 'utf-8');
    process.env[RESOURCES_CRAWL_ENV] = RESOURCES_CRAWL_PROJECTION;

    const paths = await withResourcePopulationSource({ root, ...IGNORE }, async (source) => {
      expect(source).toBeDefined();
      // The root it declares is the root it may be asked about — the registry's
      // guard compares exactly this, so a seam that handed back the wrong one
      // would silently put every crawl back on the walk.
      expect(source?.root).toBe(safePath.resolve(root));
      return [...((await source?.enumerate(root, []))?.paths ?? [])];
    });

    // The source enumerates; it does NOT narrow. Narrowing to the caller's own
    // globs is `ResourceRegistry.crawl`'s job, and asserting the unnarrowed
    // answer here is what keeps the two responsibilities distinguishable.
    expect(
      paths.map((p) => safePath.relative(root, p)).sort((left, right) => left.localeCompare(right)),
    ).toEqual([ASSET_REL, GUIDE_REL]);
  });

  it('reports the enumerator that actually ran', async () => {
    writeFileSync(safePath.join(root, GUIDE_REL), '# guide\n', 'utf-8');
    process.env[RESOURCES_CRAWL_ENV] = RESOURCES_CRAWL_PROJECTION;

    const seen: string[] = [];
    await withResourcePopulationSource(
      { root, observeExtentSource: (kind) => seen.push(kind), observePopulation: () => undefined },
      async (source) => source?.enumerate(root, []),
    );

    expect(seen).toEqual(['filesystem']);
  });

  describe('observes the population exactly once per call', () => {
    it('says the walk answered when the lane is not selected', async () => {
      process.env[RESOURCES_CRAWL_ENV] = RESOURCES_CRAWL_WALK;
      const { observed, observers } = recording();

      await withResourcePopulationSource({ root, ...observers }, async () => undefined);

      expect(observed).toEqual([{ lane: 'walk' }]);
    });

    it('says the walk answered when a crawl declined the source', async () => {
      const { observed, observers } = recording();

      await withResourcePopulationSource({ root, ...observers }, async (source) => {
        source?.decline(safePath.join(root, 'elsewhere'));
      });

      expect(observed).toEqual([{ lane: 'walk' }]);
    });

    it('publishes a null outcome when the projection lane enumerated no root', async () => {
      const { observed, observers } = recording();

      await withResourcePopulationSource({ root, ...observers }, async () => undefined);

      expect(observed).toEqual([{ lane: 'projection', outcome: null }]);
    });

    it('publishes the one root\'s outcome', async () => {
      writeFileSync(safePath.join(root, GUIDE_REL), '# guide\n', 'utf-8');
      const { observed, observers } = recording();

      await withResourcePopulationSource({ root, ...observers }, async (source) => source?.enumerate(root, []));

      // A temp tree outside any repository has no store, so the run derived.
      expect(observed).toEqual([{ lane: 'projection', outcome: { population: 'derived', stored: 'no-store' } }]);
    });

    it('combines two enumerations into ONE observation', async () => {
      writeFileSync(safePath.join(root, GUIDE_REL), '# guide\n', 'utf-8');
      const { observed, observers } = recording();

      await withResourcePopulationSource({ root, ...observers }, async (source) => {
        await source?.enumerate(root, []);
        await source?.enumerate(root, []);
      });

      expect(observed).toEqual([{ lane: 'projection', outcome: { population: 'derived', stored: 'no-store' } }]);
    });
  });
});
