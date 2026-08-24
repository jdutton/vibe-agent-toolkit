/**
 * The whole-tree always-loaded budget: one answer per working location, computed
 * from a handful of queries rather than one query per directory.
 *
 * ## The measurement that shapes this
 *
 * Measured on VAT's own tree, 2026-08-23: `vat claude context .` — population
 * plus ONE query — costs **2.9 s**, and `vat claude context` over all
 * directories costs **12.5 s**, so a `whatLoadsAt` query is ~**11.7 ms**. A
 * sweep that queried every directory would spend ~9.6 s of pure repetition to
 * compute **9** distinct answers, turning the ~1.8 s `vat claude budget` costs
 * into ~13 s. That is the cost this module exists to not pay. (The figure was
 * first argued against `vat resources validate`, which ran this sweep behind a
 * default-on check until 2026-08-23; the check is now its own command and the
 * repetition it would pay is unchanged.)
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
 * - **Rules files.** `alwaysLoadedBudget` excludes every rule admission from the
 *   sum, so the file-versus-directory precision that makes `paths:` globs exact
 *   cannot move this number. The one rule class that is launch-time —
 *   `root-rule`, an unscoped rule in the ROOT `.claude/rules/` — is selected for
 *   every query directory alike (`claude-context-rules.ts`: `scope === 'root'`
 *   admits unconditionally), so it is a constant across the whole tree, and so is
 *   whatever its own import closure pulls in.
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
 * ⛔ The filter in {@link workingLocations} is nonetheless kept, unconditionally
 * and with no opt-out, for the reason `buildResourcePopulation` keeps the same
 * line: it is the one place this lane's admitted set is STATED rather than
 * inferred from a parameter two files away, and it is the backstop if the
 * decline predicate and `collectRealization`'s `gitignored` column ever drift.
 * It used to be an `includeIgnored` option; that option became a switch that
 * could not change any answer, which is worse than no switch at all.
 */

import { CLAUDE_MD_TAG } from './agentic-tags.js';
import { account } from './claude-context-accounting.js';
import { ancestorDirectories } from './claude-context-ancestry.js';
import { alwaysLoadedBudget, type AlwaysLoadedBudget } from './claude-context-budget.js';
import { whatLoadsAt } from './claude-context-query.js';
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
  const instructedDirs = instructedDirectories(projection, claudeMdIds);
  const locations = workingLocations(projection);

  const state: SweepState = { projection, threshold, claudeMdIds, answers: new Map(), queries: 0 };
  const results: LocationBudget[] = [];
  let skipped = 0;

  for (const directory of locations) {
    const representative = representativeFor(directory, instructedDirs);
    const budget = budgetOnce(state, representative);
    if (budget === null) {
      skipped += 1;
      continue;
    }
    results.push({ directory, representative, budget });
  }

  return {
    locations: results,
    queriedDirectories: state.queries,
    evaluatedDirectories: locations.length,
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
 * The `claude-md`-tagged identities.
 *
 * ⛔ Read off `resource_tags` rather than re-derived from basenames. The whole
 * point of the tag is that the 4 MiB cliff, root discovery and this sweep read
 * ONE vocabulary — the shipped `classifyPath`'s — and a second basename rule here
 * would be free to disagree with it the moment either changed.
 *
 * @param projection - The populated projection
 * @returns Every `resourceId` carrying {@link CLAUDE_MD_TAG}
 */
function claudeMdIdentities(projection: Projection): ReadonlySet<string> {
  return new Set(
    projection.resourceTags
      .filter((tag) => tag.tag === CLAUDE_MD_TAG)
      .map((tag) => tag.resourceId),
  );
}

/**
 * Every directory holding at least one `claude-md` file — the candidate
 * representatives.
 *
 * ⚠️ Derived from ALL realizations, deliberately WITHOUT the `gitignored` filter
 * {@link workingLocations} applies. Which locations are REPORTED is a separate
 * question from what the harness loads, and filtering here would give the
 * directories beneath an instructed-but-ignored `CLAUDE.md` their grandparent's
 * numbers. Nothing the context population produces is `gitignored` today, so the
 * two sets agree — the asymmetry is kept because it is the correct one, not
 * because it currently matters.
 *
 * @param projection - The populated projection
 * @param claudeMdIds - The `claude-md`-tagged identities
 * @returns The directories, as `resource_realizations.dir` spells them
 */
function instructedDirectories(
  projection: Projection,
  claudeMdIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const dirs = new Set<string>();
  for (const row of projection.resourceRealizations) {
    if (!row.isDirectory && claudeMdIds.has(row.resourceId)) dirs.add(row.dir);
  }
  return dirs;
}

/**
 * The distinct working locations, sorted by code point.
 *
 * A location is any directory something is realized IN, plus the corpus root,
 * which is a working location whether or not anything sits directly in it.
 *
 * @param projection - The populated projection
 * @returns Root-relative directories, `''` first
 */
function workingLocations(projection: Projection): readonly string[] {
  const dirs = new Set<string>(['']);
  for (const row of projection.resourceRealizations) {
    // Unconditional, and with no opt-out — see the module docstring. The context
    // population declines the ignored half, so this can only fire if that
    // decline and this column ever drift.
    if (row.gitignored) continue;
    dirs.add(row.dir);
  }
  return [...dirs].sort(comparePaths);
}

/**
 * The nearest ancestor of `directory` — itself included — that carries a
 * `claude-md` file, or the corpus root when none does.
 *
 * ⛔ Walks the SEGMENT chain `ancestorDirectories` builds rather than testing
 * string prefixes, and that is the defect this function exists to not have:
 * `'packages/cli-x'.startsWith('packages/cli')` is true, so a prefix test hands
 * a sibling package its neighbour's budget. Reusing the query's own primitive
 * also keeps the two models reading one definition of "ancestor".
 *
 * @param directory - The working location
 * @param instructedDirs - Directories holding a `claude-md` file
 * @returns The representative directory; `''` when nothing above is instructed
 */
function representativeFor(directory: string, instructedDirs: ReadonlySet<string>): string {
  const chain = ancestorDirectories(directory);
  // Deepest-first: the NEAREST instructed ancestor wins, and the walk terminates
  // at index 0, which `ancestorDirectories` guarantees is `''`.
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index];
    if (candidate !== undefined && instructedDirs.has(candidate)) return candidate;
  }
  return '';
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

/**
 * Order two root-relative paths by UTF-16 code point.
 *
 * ⚠️ Deliberately NOT `String.localeCompare`, matching every other ordering in
 * this lane (`claude-context-ancestry.ts`, `claude-import-extent.ts`): ICU
 * collation is locale-dependent, and a sweep is exactly the kind of output that
 * gets diffed between two machines.
 *
 * @param left - One root-relative directory
 * @param right - The other
 * @returns Negative, zero or positive, per the `Array#sort` contract
 */
function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
