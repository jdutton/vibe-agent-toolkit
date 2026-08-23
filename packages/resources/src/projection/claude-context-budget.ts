/**
 * The always-loaded context budget — a predicate over the accounted row model.
 *
 * Pure: no I/O, no config, no issues emitted, no knowledge of the CLI. It takes
 * the rows {@link account} produced for one directory and answers "how much of
 * this is paid at launch, and is that more than the adopter said they wanted".
 *
 * ## Why 12,000 and not 10,000
 *
 * **The calibration (at threshold selection).** Measured across four corpora —
 * 2,027 / 7,912 / 294 / 6,928 files walked. 12,000 sits at **p71** on VAT itself,
 * **p82** on a large adopter monorepo, and **p100** on both knowledge-base
 * corpora, and flags **320 of 3,256** pooled directories (10%). None of that is
 * VAT-specific and none of it has been re-run; it is the reason for the number.
 *
 * **The argument.** A rule the authoring repo fails everywhere earns a blanket
 * suppression, not a fix — so a threshold VAT itself cannot pass is not a
 * threshold, it is a future `// eslint-disable` for the whole repo. *As measured
 * when the threshold was chosen*, 10,000 flagged **100% of VAT's own 452
 * directories**, against a root `CLAUDE.md` of **10,728 tokens**. The reasoning
 * stands; that figure is a historical measurement and must never be written in
 * the present tense.
 *
 * **The re-measurement (2026-08-23, this worktree).** `vat claude context --all
 * --format json` over this repo — 6,234 answers, 80.7 s, exit 0 — with this
 * module's inclusion rule applied offline gives **819 directories; median 8,184;
 * p90 9,255; max 14,195**. At 10,000: **39 of 819** flagged (5%). At 12,000:
 * **1 of 819** (0%) — `docs/architecture`, at 14,195. At 15,000: none. The root
 * `CLAUDE.md` shrank from 10,728 to **8,184** tokens in between, which is what
 * moved 100% to 5%. 12,000 is still the shipped number, now because it is the
 * one the four-corpus calibration produced and not because 10,000 is unusable
 * here.
 *
 * ⚠️ **Every exclusion branch below is unreachable from VAT's own corpus.**
 * Across all 819 directories, this budget equals the shipped `totals.alwaysTokens`
 * exactly — zero divergence. There are no rules-only `always` rows, no imports
 * past one hop, and no unattributed imports anywhere in this tree. So
 * `excludedRuleRows`, `excludedDeepImportRows` and `unattributedImportRows` fire
 * for adopters and never for us, and the unit suite is the ONLY thing that will
 * ever cover them. ⛔ Do not "simplify away" a branch on the evidence that it
 * never fires here — this repo is not the population.
 *
 * Independently corroborated. A large adopter's own `tools/check-claude-md-budget.ts`
 * uses a chain budget of 40 KiB ≈ 10,240 tokens, and their code validates the
 * estimator at 3.9–4.1 bytes/token — the same order, arrived at without us. Their
 * chain check is deliberately warn-only, which is the precedent for shipping ours
 * at `info`.
 *
 * ⛔ The adopter is NOT named anywhere in this repository, which is public.
 * "a large adopter monorepo" is the only permitted phrasing.
 *
 * ## Why imports stop at one hop
 *
 * The 12,000 was calibrated with `estimateTokens` at ONE import level. The
 * shipped closure walks four hops, and the threshold is **uncalibrated** there:
 * counting all four would flag directories against a number nobody measured.
 * {@link MAX_QUALIFYING_IMPORT_DEPTH} is that calibration boundary, not a
 * traversal limit — the closure still walks its full depth, and the rows past one
 * hop are counted into {@link AlwaysLoadedBudget.excludedDeepImportRows} rather
 * than dropped.
 *
 * ⚠️ `depth` is hops from the DECLARED ROOT, which is itself 0 (`ImportProvenance`
 * in `contributors/closure-extent.ts`). So depth 0 is the `CLAUDE.md` and depth 1
 * is what it imports — "one hop" admits both.
 *
 * ## Why this is TypeScript and not SQL
 *
 * No built-in check may be authored as SQL. SQL is the ADOPTER extension point,
 * and authoring a default-on check in it would make *"indexing and validation
 * never touch the engine"* false the moment it shipped — every adopter would then
 * be paying for a query engine to run a check we wrote.
 *
 * ## Why the total is a LOWER BOUND and never "the total cost"
 *
 * A global `~/.claude/CLAUDE.md` and the enabled skill index are real
 * always-loaded cost that this TREE-ONLY projection cannot see — and that no
 * per-directory budget could act on anyway. So even a budget reporting zero
 * exclusions is a floor on the true launch cost, and the field named
 * {@link AlwaysLoadedBudget.lowerBound} makes the narrower, checkable claim: that
 * rows this function DID see were left out of the sum.
 *
 * 🔑 `excludedRuleRows` does NOT set `lowerBound`, and that is the distinction a
 * future reader will get wrong. Rules files are excluded **by design** — they are
 * `selected`, not `always` — so their absence is a decision, not a gap in what we
 * know. `unknownTokenRows`, `excludedDeepImportRows` and `unattributedImportRows`
 * are exclusions by IGNORANCE: a real always-loaded cost we declined to estimate.
 * Only ignorance makes a sum a lower bound.
 */

import type { AccountedRow } from './claude-context-accounting.js';
import type { Admission } from './claude-context-query.js';

/**
 * The calibrated default, in tokens.
 *
 * ⛔ Not a version constant and not a tunable knob with a history — a MEASURED
 * quantity, and the module doc above carries the four corpora it was measured on.
 * Changing it without re-running that measurement makes the percentile claims in
 * this file false.
 */
export const DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS = 12_000;

/**
 * The deepest import hop the 12,000 threshold was calibrated against.
 *
 * The declared root is depth 0, so `<= 1` admits a `CLAUDE.md` and the files it
 * imports directly, and nothing further.
 */
const MAX_QUALIFYING_IMPORT_DEPTH = 1;

/** One charged file's contribution to the always-loaded total. */
export interface BudgetContributor {
  readonly path: string;
  readonly tokens: number;
}

/** One directory's always-loaded budget answer. */
export interface AlwaysLoadedBudget {
  readonly directory: string;
  readonly tokens: number;
  readonly threshold: number;
  readonly overBudget: boolean;
  /** Every charged contributor, descending by tokens then ascending by path. */
  readonly contributors: readonly BudgetContributor[];
  /** always-class rows that qualified but carry an UNKNOWN size. */
  readonly unknownTokenRows: number;
  /** always-class rows excluded because every admission they carry is a rule admission. */
  readonly excludedRuleRows: number;
  /** always-class rows excluded because every import admission is deeper than one hop. */
  readonly excludedDeepImportRows: number;
  /** always-class rows excluded because their import admissions carry `depth: null`. */
  readonly unattributedImportRows: number;
  /** True when any counter above is non-zero: the total is then a LOWER BOUND. */
  readonly lowerBound: boolean;
}

/** An import admission, narrowed out of the {@link Admission} union. */
type ImportAdmission = Extract<Admission, { kind: 'import' }>;

/** The running sums, mutated across one pass and never escaping this module. */
interface BudgetAccumulator {
  tokens: number;
  unknownTokenRows: number;
  excludedRuleRows: number;
  excludedDeepImportRows: number;
  unattributedImportRows: number;
  readonly contributors: BudgetContributor[];
}

/**
 * What one directory pays at launch, and whether that is over its threshold.
 *
 * `on-demand` rows are ignored SILENTLY — they are not part of this budget and
 * their absence is not an exclusion anybody should count. Every `always` row, by
 * contrast, lands in exactly one place: the sum, or one of the four counters.
 *
 * @param directory - Root-relative directory the rows were queried for. Echoed
 *   into the answer, never interpreted — this function does no path arithmetic
 * @param rows - The accounted rows from `account()` for that directory
 * @param threshold - The always-loaded token budget, in tokens
 * @returns The total, the contributors behind it, and every exclusion counted
 * @throws {TypeError} When `threshold` is not a positive integer. ⛔ Deliberately
 *   loud rather than defaulted: a silently-defaulted threshold is a no-op check
 *   wearing a real one's shape, and it would pass every green-suite reading
 */
export function alwaysLoadedBudget(
  directory: string,
  rows: readonly AccountedRow[],
  threshold: number,
): AlwaysLoadedBudget {
  assertPositiveIntegerThreshold(threshold);

  const accumulator: BudgetAccumulator = {
    tokens: 0,
    unknownTokenRows: 0,
    excludedRuleRows: 0,
    excludedDeepImportRows: 0,
    unattributedImportRows: 0,
    contributors: [],
  };
  for (const row of rows) admit(row, accumulator);

  const { contributors, tokens, ...counters } = accumulator;
  return {
    directory,
    tokens,
    threshold,
    // Strictly greater: a directory that lands exactly ON its budget is inside it.
    overBudget: tokens > threshold,
    contributors: sortContributors(contributors),
    ...counters,
    lowerBound:
      counters.unknownTokenRows > 0
      || counters.excludedDeepImportRows > 0
      || counters.unattributedImportRows > 0,
  };
}

/**
 * Route one row into the sum, into an exclusion counter, or into nothing.
 *
 * @param row - One accounted row
 * @param accumulator - The running sums, mutated in place
 */
function admit(row: AccountedRow, accumulator: BudgetAccumulator): void {
  if (row.loadClass !== 'always') return;
  if (qualifies(row.admissions)) chargeInto(row, accumulator);
  else countExclusion(row.admissions, accumulator);
}

/**
 * Does any admission on this row put it inside the calibrated budget?
 *
 * 🔑 `some`, not `every`, and that is the mutation-sensitive line. A row can
 * carry several admissions — a rules file that is ALSO an ancestry member is
 * ordinary — and ONE qualifying admission is enough, because the harness loads
 * the file at launch for that reason whatever the other reasons are.
 *
 * ⛔ A rule admission NEVER qualifies, at any depth and in any combination.
 * Rules files are `selected` rather than `always`, and the spec excludes them
 * from this budget. Note the test is POSITIVE — only `ancestry` and a shallow
 * `import` admit — so a rule kind added to the union later inherits the
 * exclusion rather than silently earning a charge.
 *
 * @param admissions - Every admission the row carries
 * @returns True when at least one admission qualifies
 */
function qualifies(admissions: readonly Admission[]): boolean {
  return admissions.some(
    (admission) =>
      admission.kind === 'ancestry'
      || (admission.kind === 'import'
        && admission.depth !== null
        && admission.depth <= MAX_QUALIFYING_IMPORT_DEPTH),
  );
}

/**
 * Add a qualifying row's tokens, or count why they could not be added.
 *
 * ⚠️ `row.tokens !== null` rather than `row.tokens ?? 0`. A charged row's tokens
 * are non-null by construction (`chargeOf` returns `unknown-size` first), so this
 * branch is unreachable through `account` — but a coalesced zero would assert a
 * free file, and this counts an unmeasured one instead. Never coalesce a null
 * size to zero in this lane.
 *
 * The two oversize states add nothing AND count nothing: the 4 MiB cliff is a
 * vendor fact already honoured upstream, and a file the harness skipped genuinely
 * is not loaded. That is knowledge, not ignorance, so it is not a lower bound.
 *
 * @param row - A qualifying always-class row
 * @param accumulator - The running sums, mutated in place
 */
function chargeInto(row: AccountedRow, accumulator: BudgetAccumulator): void {
  if (row.charge === 'oversize-skipped' || row.charge === 'pruned-by-oversize') return;
  if (row.charge === 'unknown-size' || row.tokens === null) {
    accumulator.unknownTokenRows += 1;
    return;
  }
  accumulator.tokens += row.tokens;
  accumulator.contributors.push({ path: row.path, tokens: row.tokens });
}

/**
 * File a non-qualifying always-class row under exactly one exclusion counter.
 *
 * The order is a PRIORITY, not a coincidence: a row carrying both an
 * unattributable import and a deep one is reported as unattributed, because
 * "VAT could not say where this came from" is the more urgent thing for a reader
 * to know than "it came from four hops away".
 *
 * @param admissions - Every admission the row carries
 * @param accumulator - The running sums, mutated in place
 */
function countExclusion(
  admissions: readonly Admission[],
  accumulator: BudgetAccumulator,
): void {
  const imports = admissions.filter(
    (admission): admission is ImportAdmission => admission.kind === 'import',
  );
  if (imports.some((admission) => admission.depth === null)) {
    accumulator.unattributedImportRows += 1;
  } else if (
    imports.some(
      (admission) => admission.depth !== null && admission.depth > MAX_QUALIFYING_IMPORT_DEPTH,
    )
  ) {
    accumulator.excludedDeepImportRows += 1;
  } else {
    // Rules-only — and also the admission-less row, which the query emits when
    // nothing reached a member. Neither is ignorance about a cost: one is
    // excluded by design, the other has no route at all.
    accumulator.excludedRuleRows += 1;
  }
}

/**
 * Biggest first, and deterministic among equals.
 *
 * Ties break on path by CODE POINT rather than `localeCompare`, matching every
 * other ordering in this lane: an ICU- and locale-dependent tie-break would make
 * two machines print the same budget in a different order.
 *
 * @param contributors - The charged contributors, in row order
 * @returns The same contributors, sorted
 */
function sortContributors(contributors: BudgetContributor[]): readonly BudgetContributor[] {
  return contributors.sort((left, right) => {
    if (left.tokens !== right.tokens) return right.tokens - left.tokens;
    if (left.path === right.path) return 0;
    return left.path < right.path ? -1 : 1;
  });
}

/**
 * Refuse a threshold that cannot mean what a threshold means.
 *
 * @param threshold - The caller's budget, in tokens
 * @throws {TypeError} When it is not a positive integer, naming what arrived
 */
function assertPositiveIntegerThreshold(threshold: number): void {
  if (Number.isInteger(threshold) && threshold > 0) return;
  throw new TypeError(
    `alwaysLoadedBudget threshold must be a positive integer number of tokens; received ${String(threshold)}.`
    + ` Pass DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS (${String(DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS)}) for the calibrated default.`,
  );
}
