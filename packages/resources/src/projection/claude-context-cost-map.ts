/**
 * Where the context cost of editing different parts of a repo IS — a whole-tree
 * map, small enough to read.
 *
 * ## The measurement that shapes this
 *
 * `vat claude context --all` answers for every realized PATH: on a large adopter
 * monorepo that is **10,438 answers, 205,918 lines, ~491 s**, which is not a
 * report anybody reads. Two measured facts make a far smaller answer possible,
 * and the whole design is them:
 *
 * 1. **A file's answer is a SUBSET of its directory's.** A directory query admits
 *    a path-scoped rule if ANY file under it matches; a file query only if THAT
 *    file matches (`claude-context-rules.ts`). Verified over a real dump: 0
 *    superset violations across 2,217 file/directory pairs. So the directory
 *    answer is a sound upper bound and per-FILE answers are not needed for a cost
 *    map at all — 10,438 answers become ~2,829, then 589 working locations.
 * 2. **The always-loaded set collapses; the on-demand set does not.** 589
 *    locations carry **9** distinct instruction chains, so the always half is
 *    reported once per chain ({@link ContextCostMap.regions}). Path-scoped rules
 *    genuinely vary per directory, so the on-demand half is reported once per
 *    directory ({@link ContextCostMap.directories}) and is NEVER borrowed from a
 *    region-mate.
 *
 * ⛔ The saving here is in OUTPUT SIZE and in asking about directories rather
 * than paths — it is NOT a saving in query count. Because the on-demand half
 * needs an answer per directory, this module issues one `whatLoadsAt` per working
 * location whatever the regions do, so {@link ContextCostMap.queriedDirectories}
 * EQUALS {@link ContextCostMap.evaluatedDirectories} on a healthy tree. That is
 * the opposite of `sweepAlwaysLoadedBudgets`, which needs the always half only
 * and so really does query nine times instead of 589. Anyone reading a collapse
 * into the counter here would be reading one that is not there.
 *
 * ## No threshold, no verdict, no severity — deliberately
 *
 * `vat claude context` has no gate and is not going to have one; comparing a
 * total against a number is `vat claude budget`'s job, and the two are separate
 * verbs on purpose. So nothing here imports `claude-context-budget.ts`, nothing
 * grades, and nothing sorts by anything but cost. A map that also judged would
 * make every future threshold argument a change to the map.
 *
 * ## Nothing here is a floor, and nothing here is a ceiling
 *
 * ⛔ A row whose size is unknown is COUNTED, never summed as zero — the rule
 * `claude-context-accounting.ts` states and this module inherits at every level:
 * per region for the always rows, per directory for the on-demand ones. A sum
 * that silently absorbed them would read as complete, and a confident wrong
 * number costs more than a missing one.
 */

import { account, type AccountedContext, type AccountedRow } from './claude-context-accounting.js';
import { whatLoadsAt } from './claude-context-query.js';
import {
  claudeMdIdentities,
  comparePaths,
  contextRegions,
  type ContextRegion,
} from './claude-context-regions.js';
import type { Projection } from './projection.js';

/** One instruction chain's launch-time cost, and everything that pays it. */
export interface RegionCost {
  /** The instructed directory whose chain this is. `''` is the corpus root. */
  readonly representative: string;
  /** How many working locations inherit it — including any with no answer of their own. */
  readonly locationCount: number;
  /**
   * Tokens loaded at session start anywhere in this region. EXACT for the whole
   * region, not an average: every location in it loads the same chain, which is
   * the claim the differential oracle in
   * `projection-claude-context-cost-map.test.ts` re-derives location by location.
   */
  readonly alwaysTokens: number;
  /** Always-loaded rows whose size is unknown — counted, NEVER summed as zero. */
  readonly unknownTokenRows: number;
  /** Always-loaded rows the 4 MiB `CLAUDE.md` cliff skipped. */
  readonly skippedOversizeRows: number;
  /** Always-loaded rows unreachable because an oversize file was skipped above them. */
  readonly prunedRows: number;
  /**
   * The always-loaded files themselves, so a reader sees WHAT they are paying
   * for rather than only how much. Every always-classed row, whatever its charge:
   * an oversize-skipped `CLAUDE.md` costs nothing and is the most interesting row
   * in the list.
   */
  readonly alwaysRows: readonly AccountedRow[];
}

/** One working directory's cost — the always half borrowed, the on-demand half its own. */
export interface DirectoryCost {
  /** The working location. `''` is the corpus root. */
  readonly directory: string;
  /** The region it belongs to — the directory whose chain supplied {@link alwaysTokens}. */
  readonly representative: string;
  /** The region's launch-time total, echoed so one row answers "what does editing here cost". */
  readonly alwaysTokens: number;
  /**
   * On-demand tokens for THIS directory, from THIS directory's own query.
   *
   * ⛔ Never inherited from the representative. A path-scoped rule is admitted
   * iff some realized file under this directory matches its `paths:` globs, so
   * two siblings in one region routinely differ here — that divergence is the
   * signal, and borrowing would erase exactly it.
   */
  readonly onDemandTokens: number;
  /**
   * What it costs to work here: the launch-time floor plus the on-demand burden.
   *
   * 🔑 **This is the RANKING key**, because it is the question the map answers.
   * "Where is the context cost of editing this repo" is not "where does a
   * path-scoped rule fire" — a directory under a 30,000-token instruction chain
   * that admits no rule at all is a more expensive place to work than one under
   * a tiny chain that admits a 400-token rule, and a map ranked on
   * {@link onDemandTokens} would put the second above the first. Both halves are
   * kept beside it because the two are acted on differently: the floor is fixed
   * by moving instructions, the burden by scoping rules.
   *
   * ⛔ It sums only CHARGED rows — exactly `alwaysTokens + onDemandTokens`, both
   * of which are already charged-only sums. {@link unknownTokenRows} is counted
   * BESIDE it and never folded in, because a confident zero is indistinguishable
   * from a measured one. A row VAT could not size makes this number an
   * under-report, and the counter is the only thing that says so.
   */
  readonly totalTokens: number;
  /** On-demand rows at this directory whose size is unknown — counted, never summed as zero. */
  readonly unknownTokenRows: number;
}

/**
 * How many rows the map could not measure, across the whole tree.
 *
 * ⛔ Every field is a COUNT OF ROWS and none of them is ever a token figure.
 * Adding one of these to a token total would be the exact `?? 0` this lane
 * refuses at every level: a row VAT could not size contributes nothing to any sum
 * and is reported here instead.
 *
 * ⛔ **A zero is not a licence to read the map as complete.** The stated limits
 * in `claude-context-limits.ts` are signed `over-report`/`under-report` and apply
 * whether or not these are zero — they bound the METHOD, not this tree. What an
 * all-zero roll-up says is only that nothing was left unsized, which is a much
 * smaller claim than "this is the whole cost".
 */
export interface UnmeasuredRowCounts {
  /** Rows with no measured blob — their size is unknown, so they were summed nowhere. */
  readonly unknownTokenRows: number;
  /** Rows the 4 MiB `CLAUDE.md` cliff skipped — nothing of them loads. */
  readonly skippedOversizeRows: number;
  /** Rows unreachable because every import route into them passes a skipped file. */
  readonly prunedRows: number;
}

/** The whole-tree cost map. */
export interface ContextCostMap {
  /** One entry per distinct instruction chain, sorted by `alwaysTokens` DESCENDING (worst first). */
  readonly regions: readonly RegionCost[];
  /**
   * Per-DIRECTORY cost, sorted by {@link DirectoryCost.totalTokens} DESCENDING —
   * the launch floor plus the on-demand burden, which is what working here costs.
   *
   * ⚠️ Ties break on `directory`, ascending, in CODE-POINT order
   * ({@link comparePaths}). Not decoration: on a real tree most directories share
   * a region and admit the same rules, so equal totals are the common case rather
   * than the exception, and without a total order two runs over the SAME tree
   * could emit the rows in different orders. This output gets diffed.
   */
  readonly directories: readonly DirectoryCost[];
  /**
   * How many rows this whole map rests on but could not measure.
   *
   * 🔑 It is the sum of the counters the map ALREADY reports, each counted once
   * where the map reports it: the always-loaded counters once per entry of
   * {@link regions}, the on-demand counter once per entry of
   * {@link directories}. A reader adding up the printed columns lands on exactly
   * this number, which is the property that makes it checkable rather than
   * merely plausible.
   *
   * ⛔ **NOT rolled up over working directories**, and the difference is large. A
   * region's always rows are its chain's, shared by every location inheriting it,
   * so charging them per location would render one oversize root `CLAUDE.md` as
   * hundreds of skipped rows — a number about the tree's SHAPE dressed up as a
   * number about its files.
   *
   * ⚠️ It is equally NOT a count of distinct FILES. One unsizable path-scoped
   * rule admitted at four directories is four rows here, because the map reports
   * it at four directories; the question this answers is how much of the document
   * in front of you rests on nothing, not how many files are unreadable.
   */
  readonly unmeasuredRows: UnmeasuredRowCounts;
  /**
   * `whatLoadsAt` calls actually issued.
   *
   * ⛔ A COUNTER incremented at the call, never `memo.size`. The two agree while
   * the memo works and diverge the moment it stops — and it is exactly the
   * stopped case this number exists to reveal, since a map that queried a
   * representative once per location it represents would still report a small
   * `memo.size`.
   *
   * ⚠️ Expect this to EQUAL {@link evaluatedDirectories}, not to beat it — see the
   * module docstring. The always half collapses onto {@link regions}; the query
   * count cannot, because the on-demand half is per directory.
   */
  readonly queriedDirectories: number;
  /** Working locations considered, including any skipped. */
  readonly evaluatedDirectories: number;
  /**
   * Locations left out of {@link directories} because a query they need answered
   * `unknown` — their representative's, or their own. Both happen: a directory
   * can be a `dir` value on some file's realization while nothing realizes the
   * directory path itself.
   *
   * ⛔ Counted rather than reported as zero. A confident zero is
   * indistinguishable from a measured one, and `evaluatedDirectories -
   * directories.length` would leave a reader guessing why the two disagree.
   */
  readonly skippedUnknownLocations: number;
}

/**
 * Build the whole-tree cost map.
 *
 * @param projection - A populated projection from `buildClaudeContextPopulation`
 * @returns The regions worst-first by launch-time cost, the directories
 *   worst-first by TOTAL cost, the tree-level roll-up of what could not be
 *   measured, and the three counters that make the shape of the answer auditable
 */
export function buildContextCostMap(projection: Projection): ContextCostMap {
  const state: MapState = {
    projection,
    claudeMdIds: claudeMdIdentities(projection),
    answers: new Map(),
    queries: 0,
  };

  const regions: RegionCost[] = [];
  const directories: DirectoryCost[] = [];
  let evaluated = 0;
  let skipped = 0;

  for (const region of contextRegions(projection)) {
    evaluated += region.locations.length;
    // ONE query for the whole region's always half — the collapse, and the only
    // place it applies.
    const chain = accountOnce(state, region.representative);
    if (chain === null) {
      skipped += region.locations.length;
      continue;
    }
    const cost = regionCostOf(region, chain);
    regions.push(cost);
    skipped += collectDirectories(state, region, cost, directories);
  }

  return {
    regions: orderByCost(regions, (row) => row.alwaysTokens, (row) => row.representative),
    directories: orderByCost(directories, (row) => row.totalTokens, (row) => row.directory),
    unmeasuredRows: rollUpUnmeasured(regions, directories),
    queriedDirectories: state.queries,
    evaluatedDirectories: evaluated,
    skippedUnknownLocations: skipped,
  };
}

/**
 * The invariants of one build, plus the two things that change as it runs.
 *
 * Bundled rather than threaded as four parameters, which is what the lint gate's
 * parameter ceiling refuses and what a reader of {@link accountOnce} would have
 * to re-establish at every call site.
 */
interface MapState {
  readonly projection: Projection;
  readonly claudeMdIds: ReadonlySet<string>;
  /**
   * Directory → its accounted answer.
   *
   * `null` is a REMEMBERED refusal, not an absent entry: a representative the
   * projection never realized must still be queried exactly once however many
   * locations share it.
   */
  readonly answers: Map<string, AccountedContext | null>;
  /** `whatLoadsAt` calls issued so far — see {@link ContextCostMap.queriedDirectories}. */
  queries: number;
}

/**
 * One directory's accounted answer, querying at most once per directory.
 *
 * ⚠️ The memo is consulted with `has` and not with a truthiness test on `get`: a
 * remembered `null` is an answer, and re-deriving it would re-issue the query the
 * memo exists to issue once. The representative's own entry is what makes its
 * region query and its per-directory on-demand query ONE call rather than two.
 *
 * @param state - The build's state, mutated in place
 * @param directory - The directory to query
 * @returns The accounted answer, or null when the query answered `unknown`
 */
function accountOnce(state: MapState, directory: string): AccountedContext | null {
  if (state.answers.has(directory)) return state.answers.get(directory) ?? null;

  state.queries += 1;
  const answer = whatLoadsAt(state.projection, directory);
  const accounted = answer.kind === 'unknown' ? null : account(answer, state.claudeMdIds);
  state.answers.set(directory, accounted);
  return accounted;
}

/**
 * Append one region's per-directory costs, querying EVERY location for its own
 * on-demand half.
 *
 * ⛔ The loop is the point of the module. Collapsing it onto `region.
 * representative` would be sound for the always half and wrong for this one — see
 * {@link DirectoryCost.onDemandTokens}.
 *
 * @param state - The build's state, mutated in place
 * @param region - The region being walked
 * @param cost - That region's already-computed always half
 * @param directories - The output array, appended in place
 * @returns How many of the region's locations had no answer of their own
 */
function collectDirectories(
  state: MapState,
  region: ContextRegion,
  cost: RegionCost,
  directories: DirectoryCost[],
): number {
  let skipped = 0;
  for (const directory of region.locations) {
    const local = accountOnce(state, directory);
    if (local === null) {
      skipped += 1;
      continue;
    }
    directories.push({
      directory,
      representative: region.representative,
      alwaysTokens: cost.alwaysTokens,
      onDemandTokens: local.totals.onDemandTokens,
      // ⛔ The sum happens HERE, where both halves are charged-only totals, and
      // never in a consumer. A renderer adding these two would be a second,
      // unowned model of what "cost" means, free to disagree with the key this
      // module then sorts on — and a ranked table whose numbers descend
      // non-monotonically reads as a bug in the measurement.
      totalTokens: cost.alwaysTokens + local.totals.onDemandTokens,
      unknownTokenRows: countCharge(rowsOfClass(local, 'on-demand'), 'unknown-size'),
    });
  }
  return skipped;
}

/**
 * The tree-level roll-up of rows nothing could be measured for.
 *
 * ⛔ It walks REGIONS for the always half and DIRECTORIES for the on-demand half
 * — the same two granularities the map itself reports at, which is what makes the
 * result equal to adding up the printed columns. Walking directories for both
 * would multiply every region's rows by its location count; see
 * {@link ContextCostMap.unmeasuredRows}.
 *
 * @param regions - The region costs, before ordering
 * @param directories - The directory costs, before ordering
 * @returns The three counts, over the whole map
 */
function rollUpUnmeasured(
  regions: readonly RegionCost[],
  directories: readonly DirectoryCost[],
): UnmeasuredRowCounts {
  let unknownTokenRows = 0;
  let skippedOversizeRows = 0;
  let prunedRows = 0;
  for (const region of regions) {
    unknownTokenRows += region.unknownTokenRows;
    skippedOversizeRows += region.skippedOversizeRows;
    prunedRows += region.prunedRows;
  }
  // The on-demand half. Disjoint from the loop above by LOAD CLASS — a row is
  // `always` or `on-demand`, never both — so no row is counted twice here.
  for (const directory of directories) {
    unknownTokenRows += directory.unknownTokenRows;
  }
  return { unknownTokenRows, skippedOversizeRows, prunedRows };
}

/**
 * One region's always half, from its representative's accounted answer.
 *
 * 🔑 `alwaysTokens` is taken from `totals`, which by construction sums exactly
 * the CHARGED always rows — an unknown, oversize or pruned row never reaches that
 * branch. The three counters beside it are computed over the always rows alone,
 * because `totals` counts them across both load classes and a region's record is
 * a statement about launch time only.
 *
 * @param region - The region, for its identity and size
 * @param chain - The representative's accounted answer
 * @returns The region's cost record
 */
function regionCostOf(region: ContextRegion, chain: AccountedContext): RegionCost {
  const alwaysRows = rowsOfClass(chain, 'always');
  return {
    representative: region.representative,
    locationCount: region.locations.length,
    alwaysTokens: chain.totals.alwaysTokens,
    unknownTokenRows: countCharge(alwaysRows, 'unknown-size'),
    skippedOversizeRows: countCharge(alwaysRows, 'oversize-skipped'),
    prunedRows: countCharge(alwaysRows, 'pruned-by-oversize'),
    alwaysRows,
  };
}

/**
 * The rows of one load class, in the order the query returned them.
 *
 * @param accounted - An accounted answer
 * @param loadClass - `always` or `on-demand`
 * @returns The matching rows
 */
function rowsOfClass(
  accounted: AccountedContext,
  loadClass: AccountedRow['loadClass'],
): readonly AccountedRow[] {
  return accounted.rows.filter((row) => row.loadClass === loadClass);
}

/**
 * How many rows carry one charge state.
 *
 * @param rows - The rows to count over
 * @param charge - The charge state to count
 * @returns The count
 */
function countCharge(rows: readonly AccountedRow[], charge: AccountedRow['charge']): number {
  return rows.filter((row) => row.charge === charge).length;
}

/**
 * Order rows worst-first by a cost, breaking ties on a path.
 *
 * ⚠️ The tie-break is not decoration: on a real tree whole regions of
 * directories share one chain and admit the same rules, so equal costs are the
 * common case rather than the exception. Without it the order among them would be
 * whatever the region walk happened to produce, and two runs over the same tree
 * could diff against each other. {@link comparePaths} rather than
 * `localeCompare`, for the reason that function states.
 *
 * @param rows - The rows to order; a copy is returned, the input is not mutated
 * @param costOf - The descending key
 * @param pathOf - The ascending tie-break key
 * @returns The ordered rows
 */
function orderByCost<T>(
  rows: readonly T[],
  costOf: (row: T) => number,
  pathOf: (row: T) => string,
): readonly T[] {
  return [...rows].sort((left, right) => {
    const byCost = costOf(right) - costOf(left);
    return byCost === 0 ? comparePaths(pathOf(left), pathOf(right)) : byCost;
  });
}
