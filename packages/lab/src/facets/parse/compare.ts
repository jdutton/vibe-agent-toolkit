/**
 * Comparing two `parse` reports.
 *
 * Two gates run before any number is subtracted, and both can refuse:
 *
 * 1. **Schema** — same facet, same body version, and the version this build
 *    reads. Differences across a schema change belong to the schema, not to the
 *    subject.
 * 2. **Coordinate** — at most one axis moved. A delta across two simultaneous
 *    changes cannot be attributed to either of them.
 *
 * ## What this comparator is for, and what it deliberately leaves to `perf`
 *
 * "Did the command get slower?" is `perf`'s question and `perf` answers it with
 * three significance gates over a median-of-N wall clock. Asking it a second
 * time here — over durations summed across processes, from one representative
 * repeat — would produce a second, weaker answer to the same question, and two
 * gates that can disagree about whether a regression happened is worse than one.
 *
 * This comparator answers the question `perf` cannot: **where did the time go,
 * and did the shape of the parse change?** So the interesting rows are the
 * per-pass movements and the unattributed remainder, and the significance rule
 * is deliberately simple — a relative gate and an absolute floor, no spread
 * term, because the spread that exists (`totalMsSamples`) describes the total
 * rather than any individual pass.
 *
 * ## What must not be subtracted
 *
 * A row whose `attribution` is not `measured` has no breakdown to compare: nine
 * zeroes from a warm cache subtracted from a real measurement is a fabricated
 * "everything got faster", and it is the single most convincing wrong finding
 * this facet could produce. Those pairs are `unmeasurable`, named by which state
 * each side was in.
 *
 * Two sides that parsed **different numbers of documents** are still compared —
 * a corpus that grew is exactly what a reader may be trying to see — but the
 * movement carries a caveat saying so, because a pass that got slower per run
 * may be unchanged per document.
 *
 * The same is true of two sides measured at different **thread widths**: the
 * milliseconds are summed across every thread that reported, so an arm running N
 * parse workers sums N threads' concurrent wall time into one figure. That pair
 * is the pool-on/pool-off A/B this facet exists to serve, so it is compared and
 * caveated rather than refused.
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

import {
  PARSE_FACET,
  type ParseAttribution,
  ParseBodySchema,
  type ParseCommandStats,
} from './types.js';

/** This facet's body contract, as the shared comparison gates need it. */
const PARSE_CONTRACT = {
  facet: PARSE_FACET,
  schema: ParseBodySchema,
} as const;

/** A before/after pair of counts. Named here so a consumer needs one import. */
export type ParseCountDelta = RowMovement['calls'];

/** A before/after pair of durations, with its significance verdict. */
export type ParseMsDelta = RowMovement['elapsedMs'];

/** Whether a pass is new, gone, or present on both sides. */
export type ParsePassMovementKind = RowMovement['kind'];

/**
 * What happened to one pass between two reports.
 *
 * The label is `<kind>/<pass>` — see {@link qualifiedPasses} for why the bare
 * pass name is not enough.
 */
export type ParsePassMovement = RowMovement;

/** Everything that moved for one command, whatever verdict was drawn from it. */
export interface ParseMovement {
  readonly documents: ParseCountDelta;
  readonly cacheHits: ParseCountDelta;
  readonly cacheMisses: ParseCountDelta;
  readonly total: ParseMsDelta;
  /**
   * Movement in the time nothing accounted for.
   *
   * Reported beside the passes rather than derived from them: a change that
   * lands entirely here means the attribution got better or worse, which is a
   * fact about the instrument rather than about vat, and a reader must be able
   * to see which of the two they are looking at.
   */
  readonly unattributedMs: ParseMsDelta;
  /** Every pass, whether or not it moved — the shape of the parse is the point. */
  readonly passes: readonly ParsePassMovement[];
  /**
   * Every charged tier pass, as a total and as a main-thread share.
   *
   * Its own list rather than more entries in {@link ParseMovement.passes},
   * because these rows are not parser passes and the verdict logic treats the
   * two differently: a parser pass moving is a change to how vat parses, while a
   * tier row moving is a change to where the cost of parsing is PAID. See
   * {@link tierRows}.
   */
  readonly tier: readonly ParsePassMovement[];
  /** What qualifies these numbers, or `null` when nothing does. */
  readonly caveat: string | null;
}

/** What happened to one command between two reports. */
export type ParseCommandVerdict =
  | { readonly kind: 'changed'; readonly movement: ParseMovement }
  | { readonly kind: 'unchanged'; readonly movement: ParseMovement }
  | {
      /**
       * One or both sides has no breakdown to compare — it failed, it ran in a
       * different cache mode, or it parsed nothing at all.
       *
       * Kept as its own verdict rather than folded into `unchanged`: "we could
       * not measure this" and "this did not move" are different facts, and a
       * report that renders them identically hides a warm-cache run behind a
       * reassuring green.
       */
      readonly kind: 'unmeasurable';
      readonly reason: string;
    }
  | { readonly kind: 'added' }
  | { readonly kind: 'removed' };

/** One command's row in a comparison. */
export interface ParseCommandDiff {
  readonly name: string;
  readonly verdict: ParseCommandVerdict;
  /** The baseline row, absent when the command is new. */
  readonly before: ParseCommandStats | null;
  /** The compared row, absent when the command was dropped. */
  readonly after: ParseCommandStats | null;
  /**
   * The same caveat the verdict's movement carries, where a reader that does not
   * know this facet's verdict shape can still find it. See
   * {@link CommandDiff.caveat}.
   */
  readonly caveat: string | null;
}

/** A refusal to compare at all. */
export interface ParseComparisonRefused {
  readonly ok: false;
  /** Human-facing refusal, prefixed `REFUSED:`. */
  readonly refusal: string;
}

/** A completed comparison. */
export interface ParseComparisonResult {
  readonly ok: true;
  /** Which axis varies, or `null` when the two reports share a coordinate. */
  readonly axis: Axis | null;
  readonly commands: readonly ParseCommandDiff[];
  /** True when either side was measured on a contaminated machine. */
  readonly contaminated: boolean;
}

/** The outcome of comparing two parse reports. */
export type ParseComparison = ParseComparisonResult | ParseComparisonRefused;

/**
 * Options for {@link compareParse}.
 *
 * The significance thresholds are the shared ones, so this facet cannot answer
 * "did it move?" by a different rule from its siblings.
 */
export interface CompareParseOptions extends DecideComparisonOptions, DeltaThresholds {}

/** How each non-measured state is named in a refusal reason. */
const ATTRIBUTION_REASONS: Readonly<Record<ParseAttribution, string | null>> = {
  measured: null,
  'all-cache-hits': 'every document was served from the parse cache, so no pass ran',
  'uninstrumented-only':
    'the cache missed but no instrumented parser reported a document, so the work went somewhere this build cannot attribute',
  'nothing-parsed': 'the command never reached the parse path at all',
  'not-measured': 'there is no reading',
};

/**
 * Why two rows cannot be compared, or `null` when they can.
 *
 * The cascade is shared so every facet refuses for the same reasons in the same
 * order; only the vocabulary of the empty states is this facet's own.
 */
const unmeasurableReason = unmeasurableReasonFor(ATTRIBUTION_REASONS);

/**
 * Every pass of every kind, under a name that says which kind it belongs to.
 *
 * Passes are only unique WITHIN a kind — two parsers legitimately run an
 * operation of the same name — so a comparator that keyed on the bare pass name
 * would silently add two unrelated parsers' rows together and report the sum as
 * one pass's movement.
 *
 * @param row - The command's statistics
 * @returns One labelled row per pass, in kind-then-pipeline order
 */
function passRows(row: ParseCommandStats): readonly LabelledRow[] {
  return row.kinds.flatMap((kind) =>
    kind.passes.map((pass) => ({
      label: `${kind.kind}/${pass.pass}`,
      calls: pass.calls,
      elapsedMs: pass.elapsedMs,
    })),
  );
}

/**
 * Every tier pass, twice: once for what it cost, once for what it cost the MAIN
 * thread.
 *
 * Both rows, deliberately, because a change to the parse tier routinely moves
 * one without the other and the pair is the finding. Switching the transport
 * moves the same serialization from the parent to eight workers: the total
 * barely moves (it may even rise, since eight threads serializing at once take
 * longer in aggregate) while the main-thread share collapses. A comparator that
 * published only the total would call that "unchanged"; one that published only
 * the main share would hide the aggregate cost being paid somewhere.
 *
 * Labels say which is which rather than leaving it to a convention, and both are
 * prefixed `tier/` so no reader can confuse one with a parser pass — the pass
 * namespaces are disjoint by construction, but the labels appear side by side in
 * one list.
 *
 * Rows that never ran on either side are dropped. A tier the measured build does
 * not have would otherwise contribute eight `0 -> 0` rows to every comparison.
 *
 * @param row - The command's statistics
 * @returns Two labelled rows per charged tier pass
 */
function tierRows(row: ParseCommandStats): readonly LabelledRow[] {
  return row.tier
    .filter((pass) => pass.calls > 0)
    .flatMap((pass) => [
      { label: `tier/${pass.pass}`, calls: pass.calls, elapsedMs: pass.elapsedMs },
      {
        label: `tier/${pass.pass} on main`,
        calls: pass.mainCalls,
        elapsedMs: pass.mainElapsedMs,
      },
    ]);
}

/**
 * Say what qualifies a movement on the corpus side, or `null`.
 *
 * @param documents - The document-count movement
 * @returns The caveat, or `null`
 */
function corpusCaveat(documents: ParseCountDelta): string | null {
  if (documents.delta === 0) return null;
  return (
    `the two sides parsed different numbers of documents ` +
    `(${String(documents.before)} vs ${String(documents.after)}), so a pass that moved may have ` +
    'moved because the corpus did — read the per-document figures before the totals'
  );
}

/**
 * Say when the two sides were measured at different THREAD widths, or `null`.
 *
 * Every millisecond on a row is summed across the threads that reported it. So
 * an arm running N parse workers sums N threads' CONCURRENT wall time into the
 * same figure while an arm running none sums one thread's — and the two totals
 * are not a like-for-like duration, in the direction that makes the threaded arm
 * look catastrophically slower.
 *
 * That is not hypothetical: the pool-on/pool-off A/B this facet was pointed at
 * is exactly this pair, and reading its summed figures as durations is how the
 * pool came to ship disabled. A caveat rather than a refusal, because the
 * per-pass shape and the per-document figures are precisely what a reader wants
 * from such a pair — it is the totals that need the warning.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns The caveat, or `null`
 */
function threadWidthCaveat(before: ParseCommandStats, after: ParseCommandStats): string | null {
  if (before.workerThreads === after.workerThreads) return null;
  return (
    `the two sides ran a different number of parse worker THREADS ` +
    `(${String(before.workerThreads)} vs ${String(after.workerThreads)}) — every millisecond ` +
    'here is summed across them, so the wider side sums more concurrent threads into the same ' +
    'figure and the totals are not a like-for-like duration'
  );
}

/**
 * Say what qualifies a movement, or `null` when nothing does.
 *
 * @param documents - The document-count movement
 * @param before - The baseline row
 * @param after - The compared row
 * @returns Every caveat that applies, joined, or `null`
 */
function movementCaveat(
  documents: ParseCountDelta,
  before: ParseCommandStats,
  after: ParseCommandStats,
): string | null {
  const caveats = [corpusCaveat(documents), threadWidthCaveat(before, after)].filter(
    (caveat): caveat is string => caveat !== null,
  );
  return caveats.length === 0 ? null : caveats.join('; and ');
}

/**
 * Everything that moved between two rows of one command.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @param options - Thresholds; see {@link CompareParseOptions}
 * @returns The movement
 */
function buildMovement(
  before: ParseCommandStats,
  after: ParseCommandStats,
  options: CompareParseOptions,
): ParseMovement {
  const documents = countDelta(before.documents, after.documents);
  return {
    documents,
    cacheHits: countDelta(before.cacheHits, after.cacheHits),
    cacheMisses: countDelta(before.cacheMisses, after.cacheMisses),
    total: msDelta(before.totalMs, after.totalMs, options),
    unattributedMs: msDelta(before.unattributedMs, after.unattributedMs, options),
    passes: labelledMovements(passRows(before), passRows(after), options),
    tier: labelledMovements(tierRows(before), tierRows(after), options),
    caveat: movementCaveat(documents, before, after),
  };
}

/**
 * Did anything real move?
 *
 * A pass movement counts even when the total did not: work migrating from one
 * pass to another leaves the total untouched, and a comparator that only
 * subtracted the total would call a rewritten pipeline unchanged. A pass
 * appearing or disappearing counts too — the instrument's shape moved, which the
 * reader has to know before they read any share.
 *
 * ⚠️ REVIEW FINDING 2026-08-14 — THIS VERDICT FALSE-POSITIVES AT SCALE, measured.
 * The first real `parse ab --control` (6 pairs, cold, primary adopter, the SAME
 * binary as both arms) returned `changed` on **2 of 6 pairs**. Comparing a
 * disagreeing pair by hand shows exactly one row responsible:
 *
 *     ~ html/parse5-parse        16.0ms ->   25.6ms   (+9.5ms), calls 22 -> 22
 *       markdown/remark-parse  8084.7ms -> 8309.0ms (+224.3ms)   (within noise)
 *
 * A 9.5ms wobble on a 22-document pass worth 0.17% of the parse budget flipped
 * the whole command, while `remark-parse` — 83% of the measurement — moved 23x
 * more in absolute terms and correctly stayed quiet.
 *
 * Cause: `msDelta`'s two gates are both scaled to THE PASS, never to the
 * measurement (`|Δ| > 0.1 * min(before, after)` and `|Δ| > 2ms`), so a 16ms pass
 * clears them by moving 2ms while an 8,085ms pass needs 808ms. This function
 * then ORs across all 14 rows, giving every row an independent chance to flip
 * the verdict. **The consequence is backwards: each new parser kind or split
 * pass makes the verdict LESS reliable, and the least important passes are the
 * likeliest to fire.**
 *
 * Note `DEFAULT_MIN_ABSOLUTE_MS`'s stated justification is bracket-accumulation
 * noise; what actually bites is run-to-run variance of a small pass, which is a
 * different and much larger quantity.
 *
 * ⛔ DELIBERATELY LEFT AS IS — reviewed and decided 2026-08-14, not an oversight.
 * The failure direction is SAFE: this over-reports `changed`, which inside `ab`
 * surfaces as PAIRS DISAGREE, i.e. the tool refusing to answer. It never reports
 * `unchanged` over a real movement, and nothing currently gates on the verdict.
 * The only genuine bite is a single-shot `parse compare` printing CHANGED, which
 * the standing "one A/B pair settles nothing" rule already covers.
 *
 * Revisit ONLY if something needs to gate on a parse verdict. The remedy is then
 * a policy choice: scale the absolute floor to the command total, require a
 * significant row to also be a non-trivial share of the total, or bar sub-1%
 * passes from flipping the command verdict.
 *
 * (The 2-of-6 control rate above is a point estimate with a wide interval —
 * roughly 5-75% — so read it as "a control failed to reach consensus", not as a
 * measured rate.)
 *
 * The MAGNITUDE side is sound and measured 6x tighter than perf's: use
 * `--noise-floor 16.146` for `parse ab` on this machine.
 *
 * @param movement - The movement for one command
 * @returns `true` when any duration cleared its gates, or any pass came or went
 */
function movedAtAll(movement: ParseMovement): boolean {
  return (
    movement.total.significant ||
    movement.unattributedMs.significant ||
    movement.passes.some((pass) => pass.kind !== 'changed' || pass.elapsedMs.significant)
  );
}

/**
 * Diff one command that appears on both sides.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @param options - Thresholds; see {@link CompareParseOptions}
 * @returns The verdict for this command
 */
function verdictFor(
  before: ParseCommandStats,
  after: ParseCommandStats,
  options: CompareParseOptions,
): ParseCommandVerdict {
  const unmeasurable = unmeasurableReason(before, after);
  if (unmeasurable !== null) return { kind: 'unmeasurable', reason: unmeasurable };

  const movement = buildMovement(before, after, options);
  return movedAtAll(movement) ? { kind: 'changed', movement } : { kind: 'unchanged', movement };
}

/**
 * Compare two `parse` reports.
 *
 * @param before - The baseline report
 * @param after - The report being compared against it
 * @param options - Axis and significance options
 * @returns A comparison, or a refusal explaining why the two cannot be compared
 */
export function compareParse(
  before: ReportEnvelope<unknown>,
  after: ReportEnvelope<unknown>,
  options: CompareParseOptions = {},
): ParseComparison {
  return compareCommandRows<ParseCommandStats, ParseCommandVerdict>(
    before,
    after,
    PARSE_CONTRACT,
    options,
    (left, right) => verdictFor(left, right, options),
    // Hoisted out of the movement so a facet-agnostic consumer can read it. An
    // `unmeasurable` verdict has no movement and nothing to qualify: its reason
    // already says why there are no numbers.
    (verdict) => ('movement' in verdict ? verdict.movement.caveat : null),
  );
}
