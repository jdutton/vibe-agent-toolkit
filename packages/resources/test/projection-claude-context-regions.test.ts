/**
 * The region model: the collapse `claude-context-budget-sweep.ts` implements
 * privately, promoted to a primitive two callers share.
 *
 * ## What this suite is actually defending
 *
 * A region is "every working location that inherits one instruction chain". The
 * claim is only worth anything if the walk that assigns a location to a region is
 * a SEGMENT walk: `'packages/app-x'.startsWith('packages/app')` is true, so a
 * prefix test hands a sibling package its neighbour's chain — silently, and with
 * a plausible-looking number at the end of it. {@link REGION_TREE} carries such a
 * sibling for exactly that reason, and the case that names it is the one to
 * re-run before believing any change to `representativeFor`.
 *
 * ⚠️ The gitignored ASYMMETRY is load-bearing and is pinned by two cases here.
 * Representatives come from ALL realizations; working locations are filtered.
 * Filtering both would give the directories beneath an instructed-but-ignored
 * `CLAUDE.md` their grandparent's chain — a wrong number, which costs more than
 * no number. Nothing the shipped population emits is `gitignored` today, so only
 * a synthetic projection can reach either case.
 */

import { describe, expect, it } from 'vitest';

import {
  contextRegions,
  type ContextRegion,
} from '../src/projection/claude-context-regions.js';
import type { Projection } from '../src/projection/projection.js';

import { claudeContextFixture } from './helpers/claude-context-fixture.js';

/** The corpus root, as both a location and a representative. */
const ROOT = '';

/** The one directory below the root that carries a `CLAUDE.md` of its own. */
const APP = 'packages/app';

/** `APP`'s child, which inherits from it. */
const APP_SRC = 'packages/app/src';

/**
 * The sibling whose NAME starts with `APP`'s and which must inherit nothing from
 * it — the single most likely defect in the ancestor walk.
 */
const APP_X = 'packages/app-x';

/** `APP_X`'s only file — ignoring both is what removes the directory from the model. */
const APP_X_README = `${APP_X}/README.md`;

/** The instructed file whose `gitignored` flag the asymmetry cases move. */
const APP_CLAUDE_MD = `${APP}/CLAUDE.md`;

/**
 * A tree with two instructed directories and a sibling that merely shares a name
 * prefix with one of them.
 */
const REGION_TREE: Record<string, string> = {
  'CLAUDE.md': 'Root instructions for the whole corpus.\n',
  'docs/guide.md': 'A guide nothing imports.\n',
  [APP_CLAUDE_MD]: 'App instructions.\n',
  [`${APP_SRC}/main.md`]: 'Source notes.\n',
  [APP_X_README]: 'A sibling package that shares a name prefix.\n',
};

/** Every working location `REGION_TREE` produces, in code-point order. */
const REGION_TREE_LOCATIONS = [ROOT, 'docs', 'packages', APP, APP_X, APP_SRC];

/**
 * Two sibling directories that a locale collation and a code-point collation
 * order DIFFERENTLY — `'Docs'.localeCompare('apps')` is positive, `'Docs' <
 * 'apps'` is true. Siblings that agree under both cannot tell the orderings
 * apart, and this output gets diffed across machines.
 */
const CASED_TREE: Record<string, string> = {
  'CLAUDE.md': 'Root.\n',
  'Docs/a.md': 'a\n',
  'apps/b.md': 'b\n',
};

/**
 * Mark realizations at the named paths `gitignored`.
 *
 * A projection is a bag of readonly row arrays, so a variant is one `map` away.
 * Deliberately not a second fixture builder: the tree, its tags and its closures
 * stay exactly what `claudeContextFixture` built, and only the column under test
 * moves.
 *
 * @param projection - The fixture projection
 * @param paths - Root-relative paths to mark ignored
 * @returns A projection identical but for those rows
 */
function ignoring(projection: Projection, ...paths: readonly string[]): Projection {
  const ignored = new Set(paths);
  const rows = projection.resourceRealizations.map((row) =>
    (ignored.has(row.path) ? { ...row, gitignored: true } : row));
  return { ...projection, resourceRealizations: rows };
}

/** The region carrying one representative, asserted to exist before it is read. */
function regionAt(regions: readonly ContextRegion[], representative: string): ContextRegion {
  const region = regions.find((candidate) => candidate.representative === representative);
  expect(region, `no region for ${JSON.stringify(representative)}`).toBeDefined();
  if (region === undefined) throw new Error('unreachable — asserted above');
  return region;
}

/** The representative one working location inherits from. */
function representativeOf(regions: readonly ContextRegion[], directory: string): string | undefined {
  return regions.find((region) => region.locations.includes(directory))?.representative;
}

/** Every location across every region, in region-then-location order. */
function allLocations(regions: readonly ContextRegion[]): string[] {
  return regions.flatMap((region) => [...region.locations]);
}

describe('contextRegions', () => {
  describe('the collapse', () => {
    it('produces one region per instruction chain, not one per directory', async () => {
      const regions = contextRegions(await claudeContextFixture(REGION_TREE));

      expect(regions.map((region) => region.representative)).toEqual([ROOT, APP]);
      expect(regionAt(regions, APP).locations).toEqual([APP, APP_SRC]);
      expect(regionAt(regions, ROOT).locations).toEqual([ROOT, 'docs', 'packages', APP_X]);
    });

    it('partitions the working locations — every one in exactly one region', async () => {
      const regions = contextRegions(await claudeContextFixture(REGION_TREE));
      const located = allLocations(regions);

      // Membership as SETS, not as two sorted arrays: a bare `.sort()` is
      // `localeCompare` in disguise, which this lane refuses everywhere else, and
      // the claim here is about coverage rather than order — order has its own
      // case below.
      expect(new Set(located).size).toBe(located.length);
      expect(new Set(located)).toEqual(new Set(REGION_TREE_LOCATIONS));
    });

    it('puts the whole tree in one region when only the root is instructed', async () => {
      const regions = contextRegions(
        await claudeContextFixture({ 'CLAUDE.md': 'root\n', 'docs/guide.md': 'x\n' }),
      );
      expect(regions).toHaveLength(1);
      expect(regionAt(regions, ROOT).locations).toEqual([ROOT, 'docs']);
    });
  });

  describe('the sibling-prefix trap', () => {
    it('never lets packages/app-x inherit packages/app`s chain', async () => {
      const regions = contextRegions(await claudeContextFixture(REGION_TREE));

      // ⛔ The assertion that fails the moment the segment walk is rewritten as
      // `startsWith`: that spelling puts `packages/app-x` in the `packages/app`
      // region, because the string really does start with it.
      expect(representativeOf(regions, APP_X)).toBe(ROOT);
      expect(regionAt(regions, APP).locations).not.toContain(APP_X);
      // And the sibling is genuinely present, so the assertion above is not
      // passing merely because the location vanished.
      expect(regionAt(regions, ROOT).locations).toContain(APP_X);
    });
  });

  describe('nearest-ancestor selection', () => {
    it('makes a directory with its own CLAUDE.md its own representative', async () => {
      const regions = contextRegions(await claudeContextFixture(REGION_TREE));
      expect(representativeOf(regions, ROOT)).toBe(ROOT);
      expect(representativeOf(regions, APP)).toBe(APP);
    });

    it('inherits the nearest instructed ancestor, not the farthest', async () => {
      const regions = contextRegions(await claudeContextFixture(REGION_TREE));
      expect(representativeOf(regions, APP_SRC)).toBe(APP);
      expect(representativeOf(regions, 'docs')).toBe(ROOT);
      expect(representativeOf(regions, 'packages')).toBe(ROOT);
    });

    it('falls back to the corpus root when no ancestor carries a CLAUDE.md', async () => {
      const regions = contextRegions(
        await claudeContextFixture({ [APP_CLAUDE_MD]: 'app only\n', 'docs/guide.md': 'x\n' }),
      );
      expect(representativeOf(regions, 'docs')).toBe(ROOT);
      expect(representativeOf(regions, APP)).toBe(APP);
    });
  });

  describe('the corpus root', () => {
    it('is a working location even when nothing sits directly in it', async () => {
      const regions = contextRegions(await claudeContextFixture({ 'docs/guide.md': 'x\n' }));
      expect(regionAt(regions, ROOT).locations).toEqual([ROOT, 'docs']);
    });
  });

  describe('the gitignored asymmetry', () => {
    it('still lets an ignored CLAUDE.md set the representative — the harness reads it', async () => {
      const projection = ignoring(await claudeContextFixture(REGION_TREE), APP_CLAUDE_MD);
      const regions = contextRegions(projection);
      expect(representativeOf(regions, APP_SRC)).toBe(APP);
    });

    it('drops a directory whose realizations are all ignored', async () => {
      const projection = ignoring(await claudeContextFixture(REGION_TREE), APP_X, APP_X_README);
      const regions = contextRegions(projection);
      expect(allLocations(regions)).not.toContain(APP_X);
      expect(allLocations(regions)).toHaveLength(REGION_TREE_LOCATIONS.length - 1);
    });
  });

  describe('ordering', () => {
    it('sorts regions by representative and locations by code point', async () => {
      const regions = contextRegions(await claudeContextFixture(REGION_TREE));
      expect(allLocations(regions)).toEqual([ROOT, 'docs', 'packages', APP_X, APP, APP_SRC]);
    });

    it('orders `Docs` before `apps`, which localeCompare would not', async () => {
      const regions = contextRegions(await claudeContextFixture(CASED_TREE));
      expect(regionAt(regions, ROOT).locations).toEqual([ROOT, 'Docs', 'apps']);
      // The premise, pinned: this pair really does separate the two collations.
      expect('Docs'.localeCompare('apps')).toBeGreaterThan(0);
    });
  });
});
