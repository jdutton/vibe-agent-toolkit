/**
 * The cost map: where the context cost of editing different parts of a repo is.
 *
 * ## Two halves, and only ONE of them collapses
 *
 * The always-loaded half collapses hard — a directory with no `CLAUDE.md` of its
 * own pays exactly what its nearest instructed ancestor pays, so one query per
 * REGION answers for every location in it. The on-demand half does not collapse
 * at all: a path-scoped rule is admitted to a directory query iff some realized
 * file under that directory matches its `paths:` globs, so two siblings sharing
 * one instruction chain routinely owe different on-demand totals.
 *
 * The two cases that carry this file are therefore a matched pair:
 *
 * - **{@link expectAlwaysOracle}** recomputes every location's always-loaded
 *   total the naive way — that location's OWN query, no representative, no
 *   memo — and demands the region's number agrees. It is what licenses the
 *   collapse to exist, and it must never be loosened.
 * - **the on-demand divergence case** builds two directories in ONE region whose
 *   on-demand totals differ, and demands they stay different. It is the case that
 *   goes red the moment somebody "optimizes" on-demand onto the representative
 *   the way the always half legitimately is. It is the most important test here.
 *
 * ## ⚠️ `queriedDirectories` is NOT smaller than `evaluatedDirectories`, and must not be
 *
 * `sweepAlwaysLoadedBudgets` saves queries because it needs the always half
 * ONLY. This module needs an on-demand number per directory, so it issues one
 * query per working location whatever the regions do — and the region collapse
 * buys OUTPUT size (one always-row list per chain instead of per directory),
 * not call count. So the honest counter assertion is EQUALITY: it fails high if
 * the memo stops working and a representative gets queried twice, and it fails
 * low if the per-directory on-demand pass quietly disappears. `regions.length`
 * is what witnesses the collapse, and it is already in the output.
 */

import { describe, expect, it } from 'vitest';

import { account } from '../src/projection/claude-context-accounting.js';
import {
  buildContextCostMap,
  type ContextCostMap,
  type DirectoryCost,
  type RegionCost,
} from '../src/projection/claude-context-cost-map.js';
import { whatLoadsAt } from '../src/projection/claude-context-query.js';
import type { Projection } from '../src/projection/projection.js';

import { claudeContextFixture } from './helpers/claude-context-fixture.js';
import { claudeMdIdsOf } from './helpers/claude-md-ids.js';

/** The corpus root, as both a location and a representative. */
const ROOT = '';

/** The one directory below the root that carries a `CLAUDE.md` of its own. */
const APP = 'packages/app';

/** The instructed file that makes {@link APP} a region of its own. */
const APP_CLAUDE_MD = `${APP}/CLAUDE.md`;

/** `APP`'s subdirectory the path-scoped rule DOES reach. */
const HOT = `${APP}/hot`;

/** `APP`'s subdirectory the same rule does NOT reach — its sibling in one region. */
const COLD = `${APP}/cold`;

/**
 * The package whose NAME starts with `APP`'s and which belongs to the ROOT
 * region.
 *
 * ⭐ It is here for the ORACLE's sake, not for a case of its own. A first draft
 * of this fixture had no prefix sibling, and rewriting `representativeFor` as
 * `startsWith` then left every case in this file green — the oracle can only
 * catch a mis-assigned location if the tree contains one to mis-assign. Its
 * always-loaded total genuinely differs from `APP`'s, so borrowing the wrong
 * region's number is visible rather than merely wrong.
 */
const APP_X = 'packages/app-x';

/** The path-scoped rule whose `paths:` glob separates {@link HOT} from {@link COLD}. */
const SCOPED_RULE = '.claude/rules/hot.md';

/** The rule's `paths:` entry, spelled once so the fixture and the reasoning cannot drift. */
const SCOPED_RULE_PATTERN = `${HOT}/**/*.ts`;

/**
 * A tree with two instruction chains and one path-scoped rule that reaches into
 * exactly one subdirectory of the deeper chain.
 *
 * ⚠️ The rule carries `paths:`, so `ClaudeRulesScopeContributor` scopes it
 * `path-scoped` and `baseLoadClass` classes it **on demand** in both query
 * shapes. That is what makes it able to separate {@link HOT} from {@link COLD}
 * without moving either one's always-loaded total by a single token — the exact
 * shape a representative-collapsed on-demand number would erase.
 */
const COST_TREE: Record<string, string> = {
  'CLAUDE.md': 'Root instructions for the whole corpus.\n',
  [SCOPED_RULE]: `---\npaths: ['${SCOPED_RULE_PATTERN}']\n---\n\nHow to write the hot path. ${'Rule prose. '.repeat(20)}\n`,
  'docs/guide.md': 'A guide nothing imports.\n',
  [APP_CLAUDE_MD]: `App instructions. ${'More app instructions. '.repeat(40)}\n`,
  [`${HOT}/main.ts`]: 'the hot source file\n',
  [`${COLD}/notes.md`]: 'cold notes\n',
  [`${APP_X}/README.md`]: 'A sibling package that shares a name prefix.\n',
};

/** Every working location `COST_TREE` produces, in code-point order. */
const COST_TREE_LOCATIONS = [
  ROOT,
  '.claude',
  '.claude/rules',
  'docs',
  'packages',
  APP,
  APP_X,
  COLD,
  HOT,
];

/** The directories `SCOPED_RULE`'s glob can fire under — the on-demand payers. */
const RULE_PAYERS = [ROOT, 'packages', APP, HOT];

/**
 * Every working location, ranked the way the map ranks them: by TOTAL cost.
 *
 * ⭐ This list is not a re-spelling of {@link RULE_PAYERS} followed by the rest,
 * and that is the whole reason the fixture is shaped as it is. `APP`'s chain is
 * ~30× the root chain, so `COLD` — which pays NO on-demand cost at all — outranks
 * every location in the root region, and `APP_CLAUDE_MD`'s weight lifts `APP` and
 * `HOT` above the root-region payers. A fixture whose two orderings agreed could
 * not tell a map sorted by `totalTokens` from one still sorted by
 * `onDemandTokens`, which is exactly what these cases exist to distinguish.
 *
 * Three tie groups ride along, each resolved by code point on the directory:
 * `APP`/`HOT` (equal chain, equal rule), `ROOT`/`packages` (likewise), and the
 * four locations that pay the root chain and nothing else.
 */
const COST_TREE_BY_TOTAL = [
  APP,
  HOT,
  COLD,
  ROOT,
  'packages',
  '.claude',
  '.claude/rules',
  'docs',
  APP_X,
];

/**
 * The INDEPENDENT always-loaded total for one location — that location's own
 * query, no region, no representative, no memo.
 *
 * This is the oracle's whole apparatus: the naive per-directory answer the
 * shipped cost map borrows from a representative instead, written out so the
 * borrowing can be checked rather than trusted.
 *
 * @param projection - The populated projection
 * @param directory - The working location
 * @returns The always-loaded token total, or null when the query answers `unknown`
 */
function alwaysTheLongWay(projection: Projection, directory: string): number | null {
  const answer = whatLoadsAt(projection, directory);
  if (answer.kind === 'unknown') return null;
  return account(answer, claudeMdIdsOf(projection)).totals.alwaysTokens;
}

/**
 * The oracle: every directory the map reported, recomputed the naive way, and
 * the borrowed region total demanded to agree with it.
 *
 * ⛔ ONE function every fixture is run through, never copied per fixture — a
 * copied oracle is one somebody can weaken in one place while the other keeps
 * reading as covered.
 *
 * @param projection - The populated projection the map ran over
 * @param map - The cost map's answer
 */
function expectAlwaysOracle(projection: Projection, map: ContextCostMap): void {
  for (const entry of map.directories) {
    const oracle = alwaysTheLongWay(projection, entry.directory);
    expect(oracle, `oracle refused ${JSON.stringify(entry.directory)}`).not.toBeNull();
    expect({ directory: entry.directory, alwaysTokens: entry.alwaysTokens }).toEqual({
      directory: entry.directory,
      alwaysTokens: oracle,
    });
  }
}

/** One directory's entry, asserted to exist before it is read. */
function directoryAt(map: ContextCostMap, directory: string): DirectoryCost {
  const entry = map.directories.find((candidate) => candidate.directory === directory);
  expect(entry, `no directory entry for ${JSON.stringify(directory)}`).toBeDefined();
  if (entry === undefined) throw new Error('unreachable — asserted above');
  return entry;
}

/** One region's entry, asserted to exist before it is read. */
function regionAt(map: ContextCostMap, representative: string): RegionCost {
  const entry = map.regions.find((candidate) => candidate.representative === representative);
  expect(entry, `no region entry for ${JSON.stringify(representative)}`).toBeDefined();
  if (entry === undefined) throw new Error('unreachable — asserted above');
  return entry;
}

/**
 * Drop every realization at one path.
 *
 * That is what makes a query answer `unknown`: `whatLoadsAt` refuses a path the
 * projection never realized, while the directory remains a working location
 * because the files inside it still name it as their `dir`.
 *
 * @param projection - The fixture projection
 * @param path - The realization path to remove
 * @returns A projection identical but for those rows
 */
function withoutRealization(projection: Projection, path: string): Projection {
  return {
    ...projection,
    resourceRealizations: projection.resourceRealizations.filter((row) => row.path !== path),
  };
}

describe('buildContextCostMap', () => {
  describe('the differential oracle', () => {
    it('agrees with a per-directory query on every location`s always-loaded total', async () => {
      const projection = await claudeContextFixture(COST_TREE);
      const map = buildContextCostMap(projection);

      expect(map.directories).toHaveLength(COST_TREE_LOCATIONS.length);
      expectAlwaysOracle(projection, map);

      // The mis-assignment the oracle is here to catch: a `startsWith` walk puts
      // this sibling in the APP region and hands it APP's launch-time total.
      expect(directoryAt(map, APP_X).representative).toBe(ROOT);
      expect(directoryAt(map, APP_X).alwaysTokens).not.toBe(directoryAt(map, APP).alwaysTokens);

      // A map that reported one region per directory would still pass the oracle.
      // This is the assertion that would not.
      expect(map.regions).toHaveLength(2);
      expect(map.regions.length).toBeLessThan(map.evaluatedDirectories);
    });

    it('still agrees when an ignored CLAUDE.md is what sets the chain', async () => {
      const built = await claudeContextFixture(COST_TREE);
      const projection: Projection = {
        ...built,
        resourceRealizations: built.resourceRealizations.map((row) =>
          (row.path === APP_CLAUDE_MD ? { ...row, gitignored: true } : row)),
      };
      const map = buildContextCostMap(projection);

      expect(directoryAt(map, HOT).representative).toBe(APP);
      expectAlwaysOracle(projection, map);
    });
  });

  describe('the on-demand half, which does NOT collapse', () => {
    it('gives two directories in ONE region different on-demand totals', async () => {
      const map = buildContextCostMap(await claudeContextFixture(COST_TREE));
      const hot = directoryAt(map, HOT);
      const cold = directoryAt(map, COLD);

      // The premise: they really are one region, so a representative-collapsed
      // on-demand number would give them the same total.
      expect(hot.representative).toBe(APP);
      expect(cold.representative).toBe(APP);
      expect(hot.alwaysTokens).toBe(cold.alwaysTokens);

      // ⛔ And the number that must NOT be borrowed from the representative.
      expect(hot.onDemandTokens).toBeGreaterThan(0);
      expect(cold.onDemandTokens).toBe(0);
      expect(hot.onDemandTokens).not.toBe(cold.onDemandTokens);
    });

    it('charges the rule to exactly the directories its glob can fire under', async () => {
      const map = buildContextCostMap(await claudeContextFixture(COST_TREE));
      const paying = map.directories
        .filter((entry) => entry.onDemandTokens > 0)
        .map((entry) => entry.directory);

      // Membership as SETS — the ordering claim belongs to the ordering cases,
      // and a bare `.sort()` here would be `localeCompare` in disguise.
      expect(new Set(paying)).toEqual(new Set(RULE_PAYERS));
    });

    it('never lets the on-demand rule leak into an always-loaded total', async () => {
      // The control for the pair above: if the path-scoped rule were classed
      // `always`, HOT and COLD would differ in the ALWAYS column too and the
      // region's single number would already be a lie.
      const map = buildContextCostMap(await claudeContextFixture(COST_TREE));
      const alwaysPaths = regionAt(map, APP).alwaysRows.map((row) => row.path);

      expect(alwaysPaths).toContain(APP_CLAUDE_MD);
      expect(alwaysPaths).not.toContain(SCOPED_RULE);
    });
  });

  describe('the counters', () => {
    it('issues exactly one query per working location, memoizing the representative', async () => {
      const map = buildContextCostMap(await claudeContextFixture(COST_TREE));

      expect(map.evaluatedDirectories).toBe(COST_TREE_LOCATIONS.length);
      // ⚠️ EQUALITY, not less-than — see the module docstring. Greater means the
      // memo stopped working; less means the per-directory on-demand pass did.
      expect(map.queriedDirectories).toBe(map.evaluatedDirectories);
      expect(map.skippedUnknownLocations).toBe(0);
    });

    it('skips every location of an unrealized representative and counts them', async () => {
      const projection = withoutRealization(await claudeContextFixture(COST_TREE), APP);
      const map = buildContextCostMap(projection);

      expect(whatLoadsAt(projection, APP).kind).toBe('unknown');
      expect(map.directories.map((entry) => entry.directory)).not.toContain(HOT);
      expect(map.regions.map((entry) => entry.representative)).toEqual([ROOT]);
      // The three locations of the APP region: APP itself, COLD and HOT.
      expect(map.skippedUnknownLocations).toBe(3);
      // ⚠️ `packages` survives as a working location only because `packages/app-x`
      // is still realized in it — a directory is a location because something is
      // realized IN it, and dropping the last such row drops the parent too. An
      // earlier draft of this fixture had no sibling and lost `packages` here.
      const evaluated = COST_TREE_LOCATIONS.length;
      expect(map.evaluatedDirectories).toBe(evaluated);
      expect(map.directories).toHaveLength(evaluated - 3);
      // Queried once for the refusal, not once per location it represents.
      expect(map.queriedDirectories).toBe(evaluated - 3 + 1);
    });

    it('skips a location whose OWN path is unrealized, keeping its region intact', async () => {
      // The case the budget sweep never had to face: it queried representatives
      // only, so a location that is a `dir` without a realization of its own was
      // never asked anything. This module asks every location.
      const projection = withoutRealization(await claudeContextFixture(COST_TREE), COLD);
      const map = buildContextCostMap(projection);

      expect(map.directories.map((entry) => entry.directory)).not.toContain(COLD);
      expect(map.skippedUnknownLocations).toBe(1);
      // The region still counts it — it IS a location, it just has no answer.
      expect(regionAt(map, APP).locationCount).toBe(3);
    });
  });

  describe('rows whose size is unknown', () => {
    it('counts a blobless always-loaded file rather than summing it as zero', async () => {
      const measured = buildContextCostMap(await claudeContextFixture(COST_TREE));
      const map = buildContextCostMap(
        await claudeContextFixture(COST_TREE, { deferred: [APP_CLAUDE_MD] }),
      );
      const region = regionAt(map, APP);

      // The file is still in the chain — it is still the reason APP is a region.
      expect(region.alwaysRows.map((row) => row.path)).toContain(APP_CLAUDE_MD);
      expect(region.unknownTokenRows).toBe(1);
      // ⛔ And it contributed NOTHING: the region now pays exactly what the root
      // region pays. A `?? 0` coalesce would have produced this same total with
      // `unknownTokenRows: 0`, which is why both halves are asserted.
      expect(region.alwaysTokens).toBe(regionAt(map, ROOT).alwaysTokens);
      // The control: with a blob, that file really does move the total.
      expect(regionAt(measured, APP).alwaysTokens).toBeGreaterThan(region.alwaysTokens);
      expect(regionAt(measured, APP).unknownTokenRows).toBe(0);
    });
  });

  describe('ordering', () => {
    it('sorts regions worst-first by always-loaded tokens', async () => {
      const map = buildContextCostMap(await claudeContextFixture(COST_TREE));

      expect(map.regions.map((region) => region.representative)).toEqual([APP, ROOT]);
      expect(regionAt(map, APP).alwaysTokens).toBeGreaterThan(regionAt(map, ROOT).alwaysTokens);
    });

    it('sorts directories worst-first by TOTAL cost, ties by code point', async () => {
      const map = buildContextCostMap(await claudeContextFixture(COST_TREE));
      const totals = map.directories.map((entry) => entry.totalTokens);

      expect([...totals].sort((left, right) => right - left)).toEqual(totals);
      expect(map.directories.map((entry) => entry.directory)).toEqual(COST_TREE_BY_TOTAL);
    });

    it('produces an order the on-demand ranking does NOT produce', async () => {
      // ⛔ The case that can tell the new key from the old one. Without it every
      // ordering assertion above would keep passing on a map still sorted by
      // `onDemandTokens`, because a fixture where the two agree cannot see the
      // difference between them.
      const map = buildContextCostMap(await claudeContextFixture(COST_TREE));
      const byOnDemand = [...map.directories]
        .toSorted((left, right) =>
          (right.onDemandTokens - left.onDemandTokens)
          || (left.directory < right.directory ? -1 : 1))
        .map((entry) => entry.directory);

      expect(map.directories.map((entry) => entry.directory)).not.toEqual(byOnDemand);
      // And named concretely, so the divergence is legible rather than merely
      // asserted: COLD pays no on-demand cost at all and still outranks every
      // payer in the cheap root region, because its launch floor dwarfs theirs.
      const ranked = map.directories.map((entry) => entry.directory);
      expect(ranked.indexOf(COLD)).toBeLessThan(ranked.indexOf(ROOT));
      expect(directoryAt(map, COLD).onDemandTokens).toBe(0);
      expect(directoryAt(map, ROOT).onDemandTokens).toBeGreaterThan(0);
    });

    it('breaks a tie on the directory path, in code-point order', async () => {
      const map = buildContextCostMap(await claudeContextFixture(COST_TREE));
      const ranked = map.directories.map((entry) => entry.directory);

      // Two directories with equal cost must not swap places between runs —
      // this output gets diffed. Each pair is asserted EQUAL first, so the
      // ordering claim is about a real tie rather than about two numbers that
      // happen to be adjacent.
      // ⚠️ Asserted to be a real number first: `undefined === undefined` is a
      // passing `toBe`, so an absent field would make every claim below vacuous.
      expect(directoryAt(map, APP).totalTokens).toBeGreaterThan(0);
      expect(directoryAt(map, APP).totalTokens).toBe(directoryAt(map, HOT).totalTokens);
      expect(ranked.indexOf(APP)).toBeLessThan(ranked.indexOf(HOT));
      expect(directoryAt(map, ROOT).totalTokens).toBe(directoryAt(map, 'packages').totalTokens);
      expect(ranked.indexOf(ROOT)).toBeLessThan(ranked.indexOf('packages'));
    });
  });

  describe('the total, which is what it costs to work somewhere', () => {
    it('sums the launch floor and the on-demand burden for every directory', async () => {
      const map = buildContextCostMap(await claudeContextFixture(COST_TREE));

      for (const entry of map.directories) {
        expect({ directory: entry.directory, total: entry.totalTokens }).toEqual({
          directory: entry.directory,
          total: entry.alwaysTokens + entry.onDemandTokens,
        });
      }
      // Not vacuous: at least one directory really does owe both halves.
      expect(directoryAt(map, HOT).alwaysTokens).toBeGreaterThan(0);
      expect(directoryAt(map, HOT).onDemandTokens).toBeGreaterThan(0);
    });

    it('never folds an unknown-size row into the total as zero', async () => {
      const measured = buildContextCostMap(await claudeContextFixture(COST_TREE));
      const map = buildContextCostMap(
        await claudeContextFixture(COST_TREE, { deferred: [APP_CLAUDE_MD] }),
      );
      const hot = directoryAt(map, HOT);

      // The file is still in HOT's chain and is still counted — it simply
      // contributed nothing, so the total fell rather than absorbing a 0.
      expect(regionAt(map, APP).unknownTokenRows).toBe(1);
      expect(hot.totalTokens).toBe(hot.alwaysTokens + hot.onDemandTokens);
      expect(hot.totalTokens).toBeLessThan(directoryAt(measured, HOT).totalTokens);
      // ⛔ And the total is exactly the root region's floor plus the rule — the
      // deferred file added neither its size nor a zero standing in for it.
      expect(hot.alwaysTokens).toBe(directoryAt(map, ROOT).alwaysTokens);
    });
  });

  describe('the tree-level roll-up of unmeasured rows', () => {
    it('is all zeros — and still present — when every row was measured', async () => {
      const map = buildContextCostMap(await claudeContextFixture(COST_TREE));

      // ⛔ Zeros, never an absent field. A reader must be able to tell "nothing
      // was unmeasurable" from "nobody counted", and only a printed zero does that.
      expect(map.unmeasuredRows).toEqual({
        unknownTokenRows: 0,
        skippedOversizeRows: 0,
        prunedRows: 0,
      });
    });

    it('counts a region`s unmeasured row ONCE, not once per location inheriting it', async () => {
      const map = buildContextCostMap(
        await claudeContextFixture(COST_TREE, { deferred: [APP_CLAUDE_MD] }),
      );

      // The premise: three locations inherit this one unmeasurable file.
      expect(regionAt(map, APP).unknownTokenRows).toBe(1);
      expect(regionAt(map, APP).locationCount).toBe(3);
      // ⛔ 1, not 3. A roll-up walked over working directories would charge the
      // region's always rows once per location, and one oversize root CLAUDE.md
      // would then read as hundreds of unmeasured rows.
      expect(map.unmeasuredRows).toEqual({
        unknownTokenRows: 1,
        skippedOversizeRows: 0,
        prunedRows: 0,
      });
    });

    it('is the sum of the counters the document already prints', async () => {
      const map = buildContextCostMap(
        await claudeContextFixture(COST_TREE, { deferred: [APP_CLAUDE_MD] }),
      );
      const sum = (values: readonly number[]): number =>
        values.reduce((running, value) => running + value, 0);

      // A reader adding up the printed columns must land on this number: the
      // always counters once per REGION, the on-demand counter once per DIRECTORY.
      expect(map.unmeasuredRows).toEqual({
        unknownTokenRows: sum(map.regions.map((region) => region.unknownTokenRows))
          + sum(map.directories.map((entry) => entry.unknownTokenRows)),
        skippedOversizeRows: sum(map.regions.map((region) => region.skippedOversizeRows)),
        prunedRows: sum(map.regions.map((region) => region.prunedRows)),
      });
    });
  });
});
