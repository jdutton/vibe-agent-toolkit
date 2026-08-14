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
 */

import {
  type Axis,
  type Coordinate,
  decideComparison,
  type DecideComparisonOptions,
} from '../../envelope/coordinate.js';
import { refuseIncomparableSchemas, type ReportEnvelope } from '../../envelope/envelope.js';
import { bothSides, pairByKey, type Pairing } from '../../harness/diff.js';
import { describeIssues } from '../../harness/dumps.js';

import {
  PARSE_FACET,
  PARSE_FACET_VERSION,
  type ParseAttribution,
  type ParseBody,
  ParseBodySchema,
  type ParseCommandStats,
  type ParsePassStats,
} from './types.js';

/** Fraction of the smaller side a duration must move by to count as real. */
const DEFAULT_MIN_RELATIVE = 0.1;

/**
 * Milliseconds a duration must move by to count as real.
 *
 * Lower than `perf`'s floor because these are not spawn-to-exit measurements: a
 * pass is bracketed inside the process with `performance.now()`, so there is no
 * process-startup jitter underneath it. It is not zero, because summing hundreds
 * of sub-millisecond brackets accumulates its own noise.
 */
const DEFAULT_MIN_ABSOLUTE_MS = 2;

/** A before/after pair of counts with the difference already taken. */
export interface ParseCountDelta {
  readonly before: number;
  readonly after: number;
  /** `after - before`. Exact: these are counts. */
  readonly delta: number;
}

/** A before/after pair of durations, with the verdict on whether the move is real. */
export interface ParseMsDelta {
  readonly before: number;
  readonly after: number;
  /** `after - before`, unrounded. */
  readonly delta: number;
  /** `after / before`, or `null` when the baseline is `0` and no ratio exists. */
  readonly ratio: number | null;
  /** True when the move cleared both the relative gate and the absolute floor. */
  readonly significant: boolean;
}

/** Whether a pass is new, gone, or present on both sides. */
export type ParsePassMovementKind = 'added' | 'removed' | 'changed';

/** What happened to one pass between two reports. */
export interface ParsePassMovement {
  readonly pass: string;
  readonly kind: ParsePassMovementKind;
  readonly elapsedMs: ParseMsDelta;
  readonly calls: ParseCountDelta;
}

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

/** Options for {@link compareParse}. */
export interface CompareParseOptions extends DecideComparisonOptions {
  /** Smallest fraction of the smaller side that counts as a real move. Defaults to `0.1`. */
  readonly minRelative?: number;
  /** Smallest millisecond move that counts. See {@link DEFAULT_MIN_ABSOLUTE_MS}. */
  readonly minAbsoluteMs?: number;
}

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
 * Read an envelope's body as a `parse` body.
 *
 * The build's own version is checked as well as the two sides against each
 * other. The envelope's gate asks whether the reports agree, and two reports
 * captured before a schema move agree perfectly while every row in them means
 * what the older build meant.
 *
 * @param envelope - A report whose header already says it is `parse`
 * @param side - Which side of the comparison this is, for the message
 * @returns The validated body, or a refusal string
 */
function readParseBody(
  envelope: ReportEnvelope<unknown>,
  side: string,
): { body: ParseBody } | { refusal: string } {
  if (envelope.facetVersion !== PARSE_FACET_VERSION) {
    return {
      refusal:
        `REFUSED: the ${side} report is a '${PARSE_FACET}' body at facetVersion ` +
        `${String(envelope.facetVersion)}, and this build reads ` +
        `${String(PARSE_FACET_VERSION)}. Re-capture it; reading rows whose meaning has moved ` +
        'would produce numbers nobody can state.',
    };
  }

  const parsed = ParseBodySchema.safeParse(envelope.body);
  if (parsed.success) return { body: parsed.data as ParseBody };
  return {
    refusal:
      `REFUSED: the ${side} report's header claims facet '${PARSE_FACET}', but its body is not a ` +
      `'${PARSE_FACET}' body and re-capturing that side is the only fix — ${describeIssues(parsed.error)}`,
  };
}

/**
 * Take one count difference.
 *
 * @param before - The baseline value
 * @param after - The compared value
 * @returns Both sides and the signed difference
 */
function countDelta(before: number, after: number): ParseCountDelta {
  return { before, after, delta: after - before };
}

/**
 * Take one duration difference and say whether it is real.
 *
 * Both gates are strict inequalities: a move exactly equal to its threshold has
 * not exceeded it. The relative gate is taken against the SMALLER side so that
 * "10% bigger" and "10% smaller" are the same size of claim.
 *
 * @param before - The baseline duration
 * @param after - The compared duration
 * @param options - Thresholds; see {@link CompareParseOptions}
 * @returns The delta, the ratio, and the verdict
 */
function msDelta(before: number, after: number, options: CompareParseOptions): ParseMsDelta {
  const delta = after - before;
  const magnitude = Math.abs(delta);
  const relative = (options.minRelative ?? DEFAULT_MIN_RELATIVE) * Math.min(before, after);
  const absolute = options.minAbsoluteMs ?? DEFAULT_MIN_ABSOLUTE_MS;
  return {
    before,
    after,
    delta,
    // `null` rather than `Infinity`: a formatter printing `Infinityx` has been
    // handed something that was never a number.
    ratio: before === 0 ? null : after / before,
    significant: magnitude > relative && magnitude > absolute,
  };
}

/**
 * What one side's failure costs the comparison, or `null` when it did not fail.
 *
 * @param row - That side's row
 * @param side - How to name it in the reason
 * @returns A clause, or `null`
 */
function failureCaveat(row: ParseCommandStats, side: string): string | null {
  return row.failed ? `the ${side} row failed: ${row.failure ?? 'unknown'}` : null;
}

/**
 * What one side's attribution state costs the comparison, or `null` when it is a
 * real measurement.
 *
 * @param row - That side's row
 * @param side - How to name it in the reason
 * @returns A clause, or `null`
 */
function attributionCaveat(row: ParseCommandStats, side: string): string | null {
  const reason = ATTRIBUTION_REASONS[row.attribution];
  return reason === null ? null : `the ${side} row has no breakdown — ${reason}`;
}

/**
 * Why a pair of rows yields no comparable breakdown, or `null` when it does.
 *
 * The order is the content: a failure outranks an empty measurement, which
 * outranks a cache-mode mismatch the operator can simply re-run.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns A reason naming every side at fault, or `null`
 */
function unmeasurableReason(before: ParseCommandStats, after: ParseCommandStats): string | null {
  const failures = bothSides(before, after, failureCaveat);
  if (failures !== null) return failures;
  const empty = bothSides(before, after, attributionCaveat);
  if (empty !== null) return empty;
  if (before.cache !== after.cache) {
    // A warm run and a cold run are not two measurements of one thing: warm
    // parses nothing at all, so the delta would be the entire measurement.
    return `cache mode differs (${before.cache} vs ${after.cache})`;
  }
  return null;
}

/**
 * Every pass of every kind, under a name that says which kind it belongs to.
 *
 * Passes are only unique WITHIN a kind — two parsers legitimately run an
 * operation of the same name — so a comparator that keyed on the bare pass name
 * would silently add two unrelated parsers' rows together and report the sum as
 * one pass's movement.
 *
 * @param row - The command's statistics
 * @returns One row per pass, keyed `<kind>/<pass>`, in kind-then-pipeline order
 */
function qualifiedPasses(row: ParseCommandStats): readonly ParsePassStats[] {
  return row.kinds.flatMap((kind) =>
    kind.passes.map((pass) => ({ ...pass, pass: `${kind.kind}/${pass.pass}` })),
  );
}

/**
 * Pair the two sides' passes and describe each one.
 *
 * Every pass appears, moved or not: the report's subject is the *shape* of the
 * parse, and a list that dropped the unmoved passes would make a 5% shift in one
 * pass look like the whole story.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @param options - Thresholds; see {@link CompareParseOptions}
 * @returns One movement per pass, in a stable order
 */
function passMovements(
  before: ParseCommandStats,
  after: ParseCommandStats,
  options: CompareParseOptions,
): readonly ParsePassMovement[] {
  const identify = (pass: ParsePassStats): string => pass.pass;
  return pairByKey(qualifiedPasses(before), qualifiedPasses(after), identify).map(
    (pair): ParsePassMovement => {
      let kind: ParsePassMovementKind = 'changed';
      if (pair.before === null) kind = 'added';
      else if (pair.after === null) kind = 'removed';
      return {
        pass: pair.key,
        kind,
        elapsedMs: msDelta(pair.before?.elapsedMs ?? 0, pair.after?.elapsedMs ?? 0, options),
        calls: countDelta(pair.before?.calls ?? 0, pair.after?.calls ?? 0),
      };
    },
  );
}

/**
 * Say what qualifies a movement, or `null` when nothing does.
 *
 * @param documents - The document-count movement
 * @returns The caveat, or `null`
 */
function movementCaveat(documents: ParseCountDelta): string | null {
  if (documents.delta === 0) return null;
  return (
    `the two sides parsed different numbers of documents ` +
    `(${String(documents.before)} vs ${String(documents.after)}), so a pass that moved may have ` +
    'moved because the corpus did — read the per-document figures before the totals'
  );
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
    passes: passMovements(before, after, options),
    caveat: movementCaveat(documents),
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
 * NOT fixed here — the remedy is a policy choice (scale the absolute floor to
 * the command total; require a significant row to also be a non-trivial share of
 * the total; or bar sub-1% passes from flipping the command verdict). The
 * MAGNITUDE side is sound and measured 6x tighter than perf's: use
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
 * Turn one command pairing into its diff row.
 *
 * @param pair - The command as it appears on each side
 * @param options - Thresholds; see {@link CompareParseOptions}
 * @returns The row, including the one-sided cases
 */
function diffCommand(
  pair: Pairing<ParseCommandStats>,
  options: CompareParseOptions,
): ParseCommandDiff {
  const { key, before, after } = pair;
  if (before === null || after === null) {
    // A pairing key came from one of the two sides, so exactly one of these is
    // null here; which one it is names the verdict.
    const kind = before === null ? 'added' : 'removed';
    return { name: key, verdict: { kind }, before, after };
  }
  return { name: key, verdict: verdictFor(before, after, options), before, after };
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
  const schemaRefusal = refuseIncomparableSchemas(before, after);
  if (schemaRefusal !== null) return { ok: false, refusal: schemaRefusal };

  if (before.facet !== PARSE_FACET) {
    return {
      ok: false,
      refusal: `REFUSED: compareParse was given '${before.facet}' reports, not '${PARSE_FACET}'.`,
    };
  }

  const decision = decideComparison(
    before.coordinate satisfies Coordinate,
    after.coordinate,
    options,
  );
  if (!decision.ok) return { ok: false, refusal: decision.refusal };

  const beforeBody = readParseBody(before, 'baseline');
  if ('refusal' in beforeBody) return { ok: false, refusal: beforeBody.refusal };
  const afterBody = readParseBody(after, 'compared');
  if ('refusal' in afterBody) return { ok: false, refusal: afterBody.refusal };

  const named = (command: ParseCommandStats): string => command.name;
  const commands = pairByKey(beforeBody.body.commands, afterBody.body.commands, named).map(
    (pair) => diffCommand(pair, options),
  );
  const contaminated = beforeBody.body.load.contaminated || afterBody.body.load.contaminated;

  return { ok: true, axis: decision.axis, commands, contaminated };
}
