/**
 * The whole-tree always-loaded budget: one answer per working location, computed
 * from a handful of queries rather than one query per directory.
 *
 * ## The measurement that shapes this
 *
 * ⚠️ **The original argument's premise is GONE, and the conclusion survived it.**
 * Measured on VAT's own tree 2026-08-23: a `whatLoadsAt` query cost ~**11.7 ms**,
 * so querying all 589 directories would have spent ~9.6 s of pure repetition to
 * compute **9** distinct answers. That 11.7 ms was itself a defect — the query
 * rebuilt the whole projection's indexes on every call, making per-query cost
 * proportional to the TREE rather than to the answer. Fixed 2026-08-24
 * (`claude-context-query.ts`), and re-measured on the same tree a query is now
 * ~**0.24 ms**: a 47× drop.
 *
 * So the saving this module was built for is now ~**0.14 s**, not ~9.6 s.
 *
 * ⛔ It does NOT follow that the collapse now saves output. {@link BudgetSweep}
 * still reports one {@link LocationBudget} per working location — all 589 of
 * them — because the question "is THIS directory over budget" is asked of a
 * directory. The collapse has only ever saved QUERIES.
 *
 * It is kept for three reasons, none of which is the original 9.6 s: it is
 * strictly less work than the naive sweep however cheap a query becomes; the
 * model is now SHARED with `claude-context-cost-map.ts`, whose output genuinely
 * is one row per region, so deleting it here would fork a model two lanes read;
 * and the differential oracle that guards it is the reason either lane is
 * allowed to trust a representative's answer at all. Nobody should re-derive a
 * performance claim from this paragraph.
 *
 * ⚠️ **The directory count moved, the collapse did not.** Re-measured on the
 * same tree after the context population began declining the gitignored half:
 * **589 working locations, still 9 distinct chains**, the largest group 366
 * directories paying `['CLAUDE.md']` alone and the smallest two paying a chain
 * apiece. Before declining it was **817 locations / 9 chains / largest group
 * 552**. What the decline removed is repetition, never an answer — which is the
 * property to re-check when either number is next restated.
 *
 * ## The collapse, and why it is sound
 *
 * A directory's always-loaded set is every `claude-md`-tagged file in its
 * ancestors (inclusive) plus those files' one-hop `@` imports. So **a directory
 * containing no `claude-md` file of its own pays exactly what its nearest
 * instructed ancestor pays**, falling back to the corpus root. Query one
 * REPRESENTATIVE per group; reuse its answer for the whole group. Nine queries
 * instead of 589.
 *
 * Three things that look like they should break it, and do not:
 *
 * - **Rules files.** ⚠️ The premise here USED to be that `alwaysLoadedBudget`
 *   excludes every rule admission from the sum. It does not, and never should
 *   have: a `root-rule` is `always` to the query lane, so the budget charges it
 *   ({@link alwaysLoadedBudget}'s `qualifies`), and a version that excluded it
 *   made the two lanes disagree about the same directory. The CONCLUSION is
 *   unchanged, and it never rested on the exclusion. Charged or not, a
 *   `root-rule` is selected for every query directory alike
 *   (`claude-context-rules.ts`: `scope === 'root'` admits unconditionally), so it
 *   is a CONSTANT across the whole tree — as is whatever its own import closure
 *   pulls in — and a constant cannot separate two groups. The rule kinds that
 *   DO vary by location are the path-scoped ones, and those are precisely the
 *   ones the budget still excludes, so the file-versus-directory precision that
 *   makes `paths:` globs exact cannot move this number either.
 * - **The root's second project location.** `claudeAncestry` admits
 *   `.claude/CLAUDE.md` for every directory, not just for `.claude`. Constant
 *   again, and constants cannot separate two groups.
 * - **A gitignored `CLAUDE.md`.** There is no longer such a row to reason about
 *   — the context population declines the ignored half outright (see
 *   `claude-context-population.ts`) — so the representative and the reported
 *   location set are derived from the same rows and cannot disagree.
 *
 * ⚠️ This is nonetheless a SECOND model of "which directories matter", sitting
 * beside `whatLoadsAt`'s. If the two drift, budgets go silently stale, which is
 * the expensive failure: a wrong number costs more than no number. The
 * differential oracle in `projection-claude-context-budget-sweep.test.ts`
 * recomputes every location the naive way and demands agreement — it is the
 * reason this collapse is allowed to exist, and it must not be weakened.
 *
 * ## Why gitignored realizations are still filtered here
 *
 * They cannot arrive any more: `buildClaudeContextPopulation` passes
 * `DECLINE_IGNORED`, so no row it produces is `gitignored: true`. On VAT's own
 * tree that is the difference between **817 and 589 working locations** (and
 * **6,271 against 2,820 realizations**) — the 228 excluded being `dist/`,
 * `coverage/`, `jscpd-report/`, `.vat-lab/` and their like, which are not places
 * a person or an agent works, and reporting a context budget for build output is
 * noise that teaches people to stop reading the check.
 *
 * ⛔ That filter is nonetheless kept, unconditionally and with no opt-out, for
 * the reason `buildResourcePopulation` keeps the same line: it is the one place
 * this lane's admitted set is STATED rather than inferred from a parameter two
 * files away, and it is the backstop if the decline predicate and
 * `collectRealization`'s `gitignored` column ever drift. It used to be an
 * `includeIgnored` option; that option became a switch that could not change any
 * answer, which is worse than no switch at all.
 *
 * ## The collapse itself lives in `claude-context-regions.ts`
 *
 * ⚠️ It used to live HERE, privately, and `vat claude context --all`'s cost map
 * needed the same grouping. Two copies of a model whose whole value is that it
 * agrees with `whatLoadsAt` is the drift this module's own docstring warns
 * about, one level up. So the location walk, the representative walk and the
 * `claude-md` vocabulary are now ONE implementation that both callers read, and
 * what remains here is the part that is genuinely this lane's: applying a
 * THRESHOLD, which the cost map deliberately has no notion of.
 *
 * The differential oracle named above still guards it, and now guards it for
 * both callers.
 */

import { account } from './claude-context-accounting.js';
import { alwaysLoadedBudget, type AlwaysLoadedBudget } from './claude-context-budget.js';
import { whatLoadsAt } from './claude-context-query.js';
import { claudeMdIdentities, comparePaths, contextRegions } from './claude-context-regions.js';
import type { Projection } from './projection.js';

/** One working location's budget, and the query that produced it. */
export interface LocationBudget {
  /** The working location this budget is reported for. `''` is the corpus root. */
  readonly directory: string;
  /** The representative whose query produced it — equal to `directory` for a representative. */
  readonly representative: string;
  /**
   * The representative's answer.
   *
   * 🔑 `budget.directory` is the REPRESENTATIVE, not {@link directory} — it is
   * the directory the numbers were measured for, and echoing the borrowing
   * location there would forge a measurement nobody took.
   */
  readonly budget: AlwaysLoadedBudget;
}

/** Every working location's budget, plus what the collapse saved. */
export interface BudgetSweep {
  /** One entry per working location, sorted by `directory` (code-point order). */
  readonly locations: readonly LocationBudget[];
  /**
   * `whatLoadsAt` calls actually issued. The saving, made observable.
   *
   * ⛔ A COUNTER incremented at the call, never `memo.size`. The two agree while
   * the memo works and diverge the moment it stops — and it is exactly the
   * stopped case this number exists to reveal. A sweep that queried every
   * location and filed each answer under its representative would still report a
   * small `memo.size`, so `memo.size` cannot witness its own mechanism.
   */
  readonly queriedDirectories: number;
  /** Working locations considered — including any {@link skippedUnknownLocations}. */
  readonly evaluatedDirectories: number;
  /**
   * Locations omitted from {@link locations} because their representative was a
   * path the projection never realized, so `whatLoadsAt` answered `unknown`.
   *
   * ⛔ Counted rather than reported as zero. A confident zero is
   * indistinguishable from a measured one, and `evaluatedDirectories -
   * locations.length` would leave a reader guessing why the two disagree.
   */
  readonly skippedUnknownLocations: number;
}

/**
 * Every working location's always-loaded budget, from one query per distinct
 * instruction chain.
 *
 * @param projection - A populated projection from `buildClaudeContextPopulation`
 * @param threshold - The always-loaded token budget, in tokens. Passed straight
 *   through to `alwaysLoadedBudget`, which refuses a non-positive-integer loudly
 * @returns Every location's budget, and the two counters that show the collapse
 * @throws {TypeError} When `threshold` is not a positive integer — raised by
 *   `alwaysLoadedBudget` on the first representative, deliberately not
 *   pre-validated here: one owner for that rule, not two
 */
export function sweepAlwaysLoadedBudgets(
  projection: Projection,
  threshold: number,
): BudgetSweep {
  const claudeMdIds = claudeMdIdentities(projection);
  const regions = contextRegions(projection);

  const state: SweepState = { projection, threshold, claudeMdIds, answers: new Map(), queries: 0 };
  const results: LocationBudget[] = [];
  let evaluated = 0;
  let skipped = 0;

  // Region-major, then sorted back to directory order below. Iterating the
  // collapse directly is what makes "one query per distinct chain" structural
  // rather than a property of a memo: there is no longer a per-directory call
  // site for a future edit to reintroduce.
  for (const region of regions) {
    evaluated += region.locations.length;
    const budget = budgetOnce(state, region.representative);
    if (budget === null) {
      skipped += region.locations.length;
      continue;
    }
    for (const directory of region.locations) {
      results.push({ directory, representative: region.representative, budget });
    }
  }

  return {
    // ⛔ Sorted HERE rather than inherited from the iteration order. The field is
    // documented as directory-ordered and consumers diff it across runs; region
    // order is representative-major, which interleaves directories from
    // different regions and would report churn nobody caused.
    locations: results.toSorted((left, right) => comparePaths(left.directory, right.directory)),
    queriedDirectories: state.queries,
    evaluatedDirectories: evaluated,
    skippedUnknownLocations: skipped,
  };
}

/**
 * The invariants of one sweep, plus the two things that change as it runs.
 *
 * Bundled rather than threaded as five parameters, which is what
 * {@link budgetOnce} needed and what the lint gate's parameter ceiling refuses.
 */
interface SweepState {
  readonly projection: Projection;
  readonly threshold: number;
  readonly claudeMdIds: ReadonlySet<string>;
  /**
   * Representative → its budget.
   *
   * `null` is a REMEMBERED refusal, not an absent entry: an `unknown`
   * representative shared by fifty locations must still be queried exactly once.
   */
  readonly answers: Map<string, AlwaysLoadedBudget | null>;
  /** `whatLoadsAt` calls issued so far — see {@link BudgetSweep.queriedDirectories}. */
  queries: number;
}

/**
 * One representative's budget, querying at most once per representative.
 *
 * ⚠️ The memo is consulted with `has` and not with a truthiness test on `get`:
 * a remembered `null` is an answer, and re-deriving it would re-issue the query
 * this whole module exists to issue once.
 *
 * @param state - The sweep's state, mutated in place
 * @param representative - The directory to query
 * @returns The budget, or null when the query answered `unknown`
 */
function budgetOnce(state: SweepState, representative: string): AlwaysLoadedBudget | null {
  if (state.answers.has(representative)) return state.answers.get(representative) ?? null;

  state.queries += 1;
  const answer = whatLoadsAt(state.projection, representative);
  const budget =
    answer.kind === 'unknown'
      ? null
      : alwaysLoadedBudget(
          representative,
          account(answer, state.claudeMdIds).rows,
          state.threshold,
        );
  state.answers.set(representative, budget);
  return budget;
}
