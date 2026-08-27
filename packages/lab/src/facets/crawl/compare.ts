/**
 * Comparing two `crawl` reports.
 *
 * Two gates run before any number is subtracted, and both can refuse:
 *
 * 1. **Schema** — same facet, same body version, and the version this build
 *    reads. Differences across a schema change belong to the schema.
 * 2. **Coordinate** — at most one axis moved. A delta across two simultaneous
 *    changes cannot be attributed to either of them.
 *
 * ## What this comparator answers
 *
 * "Did the command get slower?" is `perf`'s question, answered with three
 * significance gates over a median-of-N wall clock. Asking it again here would
 * give a second, weaker answer to one question, and two gates that can disagree
 * is worse than one.
 *
 * This answers what `perf` cannot: **which layer's work moved.** The rows worth
 * looking at are the per-stratum totals — the incumbent link walker against the
 * projection's closure — and then the individual `(contributorId, stratum, pass)`
 * entries beneath them.
 *
 * ## What must not be subtracted
 *
 * A row whose `attribution` is not `measured` has nothing to compare. Zeros from
 * a command that never reached a crawler subtracted from a real measurement is a
 * fabricated "everything got faster", and it is the most convincing wrong finding
 * this facet could produce. Those pairs are `unmeasurable`, named by which state
 * each side was in.
 */

import type { Axis, DecideComparisonOptions } from '../../envelope/coordinate.js';
import type { ReportEnvelope } from '../../envelope/envelope.js';
import {
  compareCommandRows,
  countDelta,
  type DeltaThresholds,
  type LabelledRow,
  labelledMovements,
  msDelta,
  type RowMovement,
  unmeasurableReasonFor,
} from '../../harness/facet-compare.js';

import { crawlEntryKey } from './dump.js';
import {
  CRAWL_FACET,
  type CrawlAttribution,
  CrawlBodySchema,
  type CrawlCommandStats,
  type CrawlDumpCharges,
} from './types.js';

/** This facet's body contract, as the shared comparison gates need it. */
const CRAWL_CONTRACT = {
  facet: CRAWL_FACET,
  schema: CrawlBodySchema,
} as const;

/** A before/after pair of counts. Named here so a consumer needs one import. */
export type CrawlCountDelta = RowMovement['calls'];

/** A before/after pair of durations, with its significance verdict. */
export type CrawlMsDelta = RowMovement['elapsedMs'];

/** Whether a row is new, gone, or present on both sides. */
export type CrawlRowMovementKind = RowMovement['kind'];

/**
 * What happened to one row between two reports.
 *
 * The label is a stratum name, or `<stratum>|<pass>|<id>` for an entry.
 */
export type CrawlRowMovement = RowMovement;

/** Everything that moved for one command. */
export interface CrawlMovement {
  readonly total: CrawlMsDelta;
  readonly totalCalls: CrawlCountDelta;
  /** Per-stratum movement — the crawler-against-crawler comparison. */
  readonly strata: readonly CrawlRowMovement[];
  /** Every `(contributorId, stratum, pass)` row, whether or not it moved. */
  readonly entries: readonly CrawlRowMovement[];
}

/** What happened to one command between two reports. */
export type CrawlCommandVerdict =
  | { readonly kind: 'changed'; readonly movement: CrawlMovement }
  | { readonly kind: 'unchanged'; readonly movement: CrawlMovement }
  | {
      /**
       * One or both sides has nothing to compare — it failed, or it never
       * reached a crawler.
       *
       * Its own verdict rather than folded into `unchanged`: "we could not
       * measure this" and "this did not move" are different facts.
       */
      readonly kind: 'unmeasurable';
      readonly reason: string;
    }
  | { readonly kind: 'added' }
  | { readonly kind: 'removed' };

/** One command's row in a comparison. */
export interface CrawlCommandDiff {
  readonly name: string;
  readonly verdict: CrawlCommandVerdict;
  /** The baseline row, absent when the command is new. */
  readonly before: CrawlCommandStats | null;
  /** The compared row, absent when the command was dropped. */
  readonly after: CrawlCommandStats | null;
}

/** A refusal to compare at all. */
export interface CrawlComparisonRefused {
  readonly ok: false;
  /** Human-facing refusal, prefixed `REFUSED:`. */
  readonly refusal: string;
}

/** A completed comparison. */
export interface CrawlComparisonResult {
  readonly ok: true;
  /** Which axis varies, or `null` when the two reports share a coordinate. */
  readonly axis: Axis | null;
  readonly commands: readonly CrawlCommandDiff[];
  /** True when either side was measured on a contaminated machine. */
  readonly contaminated: boolean;
}

/** The outcome of comparing two crawl reports. */
export type CrawlComparison = CrawlComparisonResult | CrawlComparisonRefused;

/**
 * Options for {@link compareCrawl}.
 *
 * The significance thresholds are the shared ones, so this facet cannot answer
 * "did it move?" by a different rule from its siblings.
 */
export interface CompareCrawlOptions extends DecideComparisonOptions, DeltaThresholds {}

/** How each non-measured state is named in a refusal reason. */
const ATTRIBUTION_REASONS: Readonly<Record<CrawlAttribution, string | null>> = {
  measured: null,
  'nothing-crawled': 'the command never reached a contributor or a link walk at all',
  'not-measured': 'there is no reading',
};

/**
 * A command's per-stratum rollups as labelled rows.
 *
 * The additive figures, which are the ones the stratum rollup publishes as its
 * own — a stratum's nested time moves with the row that contains it, and is
 * visible as that row's own movement in {@link entryRows} below. Diffing it here
 * as well would report one regression twice, once in a total and once inside it.
 *
 * @param row - The command's statistics
 * @returns One labelled row per stratum
 */
function stratumRows(row: CrawlCommandStats): readonly LabelledRow[] {
  return row.strata.map((stratum) => ({
    label: stratum.stratum,
    calls: stratum.calls,
    elapsedMs: stratum.elapsedMs,
  }));
}

/**
 * A command's entries as labelled rows.
 *
 * The label carries the stratum and the pass as well as the id, because an id is
 * only unique within a `(stratum, pass)` — the seam charges the same contributor
 * once per fixpoint pass, and a comparator keyed on the bare id would add those
 * passes together and report the sum as one row's movement.
 *
 * **Every** entry, nested ones included: a nested row is where a regression is
 * actually diagnosed, and dropping it would leave a stratum that got slower with
 * nothing beneath it saying where.
 *
 * @param row - The command's statistics
 * @returns One labelled row per entry
 */
function entryRows(row: CrawlCommandStats): readonly LabelledRow[] {
  return row.entries.map((entry) => ({
    label: crawlEntryKey(entry),
    calls: entry.calls,
    elapsedMs: entry.elapsedMs,
  }));
}

/**
 * Why two rows cannot be compared, or `null` when they can.
 *
 * The cascade is shared so every facet refuses for the same reasons in the same
 * order; only the vocabulary of the empty states is this facet's own.
 */
const unmeasurableReason = unmeasurableReasonFor(ATTRIBUTION_REASONS);

/**
 * Why two arms measured by DIFFERENT instruments are not two measurements of one
 * thing, or `null` when they carry the same brackets.
 *
 * ## The failure this exists to stop, stated concretely
 *
 * A bracket added to the seam charges work that was previously charged nowhere.
 * No existing row changes, so every row lines up — and the command TOTAL grows,
 * because it sums additive rows across every stratum. An A/B across that boundary
 * therefore reads a widening of the instrument as a regression in the subject,
 * and reads it CONSISTENTLY, so `ab` calls the pairs stable and prints a
 * confident delta instead of refusing. That is not hypothetical: it is what the
 * `shared` stratum did, and what the projection's blob stage would have done
 * next.
 *
 * ⛔ **The dump version cannot catch this and never could.** It is an integer: it
 * says "different", never "different how", and it only fires when a human
 * remembers to bump it — which, for `shared`, nobody did, on an argument that was
 * correct about rows and wrong about totals. This function reads what each build
 * DECLARED it can charge, so a new bracket refuses the comparison it invalidates
 * whether or not anyone remembered anything.
 *
 * Refusing rather than adjusting is deliberate. The missing term's size is
 * knowable only on the arm that HAS the bracket, so "subtract it from the other
 * side" would be an estimate presented as a measurement — the fabricated
 * "everything got faster" `facet-compare.ts` exists to prevent.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns A reason naming what is missing on which side, or `null`
 */
function chargeCaveat(before: CrawlCommandStats, after: CrawlCommandStats): string | null {
  const missing = (from: CrawlDumpCharges, present: CrawlDumpCharges): string[] => [
    ...present.strata.filter((s) => !from.strata.includes(s)).map((s) => `stratum '${s}'`),
    ...present.syntheticIds.filter((id) => !from.syntheticIds.includes(id)).map((id) => `'${id}'`),
  ];
  const missingFromBefore = missing(before.charges, after.charges);
  const missingFromAfter = missing(after.charges, before.charges);
  if (missingFromBefore.length === 0 && missingFromAfter.length === 0) return null;

  const clauses: string[] = [];
  if (missingFromBefore.length > 0) {
    clauses.push(`the baseline build cannot charge ${missingFromBefore.join(', ')}`);
  }
  if (missingFromAfter.length > 0) {
    clauses.push(`the compared build cannot charge ${missingFromAfter.join(', ')}`);
  }
  return (
    `the two arms were measured by different instruments — ${clauses.join('; ')}. ` +
    'A bracket one build lacks is work charged to one total and not the other, so the ' +
    'difference between them is partly the instrument and cannot be attributed to the subject.'
  );
}

/**
 * Did anything real move?
 *
 * A stratum or entry movement counts even when the total did not: work migrating
 * from one crawler to another leaves the total untouched, and a comparator that
 * only subtracted the total would call a swapped crawler unchanged.
 *
 * ⚠️ This has the same scale sensitivity `parse`'s verdict does, and the same
 * mitigation: both gates are scaled to the ROW, so a cheap row clears them by
 * moving 2ms while an expensive one needs a tenth of itself, and this ORs across
 * every row. The failure direction is safe — it over-reports `changed`, which
 * inside `ab` surfaces as PAIRS DISAGREE, i.e. the tool refusing to answer rather
 * than answering wrongly. Do not gate anything on this verdict without first
 * scaling the floor to the command total.
 *
 * @param movement - The movement for one command
 * @returns `true` when any duration cleared its gates, or any row came or went
 */
function movedAtAll(movement: CrawlMovement): boolean {
  const moved = (row: CrawlRowMovement): boolean =>
    row.kind !== 'changed' || row.elapsedMs.significant;
  return (
    movement.total.significant || movement.strata.some(moved) || movement.entries.some(moved)
  );
}

/**
 * Diff one command that appears on both sides.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @param options - Thresholds; see {@link CompareCrawlOptions}
 * @returns The verdict for this command
 */
function verdictFor(
  before: CrawlCommandStats,
  after: CrawlCommandStats,
  options: CompareCrawlOptions,
): CrawlCommandVerdict {
  // Before the attribution cascade, not after: "these are different instruments"
  // is a better answer than "one side crawled nothing", and it is the true one
  // when a build without the bracket produced no row for it.
  const charges = chargeCaveat(before, after);
  if (charges !== null) return { kind: 'unmeasurable', reason: charges };

  const unmeasurable = unmeasurableReason(before, after);
  if (unmeasurable !== null) return { kind: 'unmeasurable', reason: unmeasurable };

  const movement: CrawlMovement = {
    total: msDelta(before.totalMs, after.totalMs, options),
    totalCalls: countDelta(before.totalCalls, after.totalCalls),
    strata: labelledMovements(stratumRows(before), stratumRows(after), options),
    entries: labelledMovements(entryRows(before), entryRows(after), options),
  };
  return movedAtAll(movement) ? { kind: 'changed', movement } : { kind: 'unchanged', movement };
}

/**
 * Compare two `crawl` reports.
 *
 * @param before - The baseline report
 * @param after - The report being compared against it
 * @param options - Axis and significance options
 * @returns A comparison, or a refusal explaining why the two cannot be compared
 */
export function compareCrawl(
  before: ReportEnvelope<unknown>,
  after: ReportEnvelope<unknown>,
  options: CompareCrawlOptions = {},
): CrawlComparison {
  return compareCommandRows<CrawlCommandStats, CrawlCommandVerdict>(
    before,
    after,
    CRAWL_CONTRACT,
    options,
    (left, right) => verdictFor(left, right, options),
  );
}
