/**
 * Comparing two `perf` reports.
 *
 * Two gates run before any number is subtracted, and both can refuse:
 *
 * 1. **Schema** — same facet, same body version. Differences across a schema
 *    change belong to the schema, not to the subject.
 * 2. **Coordinate** — at most one axis moved. A delta across two simultaneous
 *    changes cannot be attributed to either of them.
 *
 * Only then does it look at timings, and even then a difference is reported as
 * *changed* only when it clears the significance gates. A comparator that calls
 * every difference a change turns a performance gate into noise that people
 * learn to ignore, which is worse than having no gate at all.
 */

import {
  type Axis,
  type Coordinate,
  decideComparison,
  type DecideComparisonOptions,
} from '../../envelope/coordinate.js';
import { refuseIncomparableSchemas, type ReportEnvelope } from '../../envelope/envelope.js';

import { isSignificant, type SignificanceOptions, type SignificanceResult } from './stats.js';
import { PERF_FACET, type PerfBody, PerfBodySchema, type PerfCommandStats } from './types.js';

/** What happened to one command between two reports. */
export type PerfCommandVerdict =
  | { readonly kind: 'changed'; readonly significance: SignificanceResult }
  | { readonly kind: 'unchanged'; readonly significance: SignificanceResult }
  | {
      /**
       * Both medians sit at or below the absolute significance floor, so this
       * command **cannot ever** be reported as changed.
       *
       * Kept apart from `unchanged` because the two are not the same claim. If
       * both sides are under the floor then the delta is under it too, so the
       * verdict is `false` by arithmetic rather than by observation — and a
       * facet pointed at something genuinely this fast would report "nothing
       * moved" forever while looking perfectly healthy. Spawn-based timing
       * simply cannot resolve differences at this scale; say so.
       */
      readonly kind: 'below-resolution';
      readonly floorMs: number;
      readonly significance: SignificanceResult;
    }
  | {
      /**
       * The two rows cannot yield a delta — either a side produced no usable
       * measurement, or both did but of different things (see
       * {@link unmeasurableReason} for the full list, which the `reason` names).
       *
       * Kept as its own verdict rather than folded into `unchanged`: "we could
       * not measure this" and "this did not move" are different facts, and a
       * report that renders them identically hides broken commands behind a
       * reassuring green.
       */
      readonly kind: 'unmeasurable';
      readonly reason: string;
    }
  | { readonly kind: 'added' }
  | { readonly kind: 'removed' };

/** One command's row in a comparison. */
export interface PerfCommandDiff {
  readonly name: string;
  readonly verdict: PerfCommandVerdict;
  /** The baseline row, absent when the command is new. */
  readonly before: PerfCommandStats | null;
  /** The compared row, absent when the command was dropped. */
  readonly after: PerfCommandStats | null;
}

/** A refusal to compare at all. */
export interface PerfComparisonRefused {
  readonly ok: false;
  /** Human-facing refusal, prefixed `REFUSED:`. */
  readonly refusal: string;
}

/** A completed comparison. */
export interface PerfComparisonResult {
  readonly ok: true;
  /** Which axis varies, or `null` when the two reports share a coordinate. */
  readonly axis: Axis | null;
  readonly commands: readonly PerfCommandDiff[];
  /**
   * True when either side was measured on a contaminated machine.
   *
   * Surfaced at the top level because it qualifies every number below it, and a
   * caller that has to dig for that will not.
   */
  readonly contaminated: boolean;
}

/** The outcome of comparing two perf reports. */
export type PerfComparison = PerfComparisonResult | PerfComparisonRefused;

/** Options for {@link comparePerf}. */
export interface ComparePerfOptions extends DecideComparisonOptions, SignificanceOptions {}

/**
 * Read an envelope's body as a `perf` body.
 *
 * @param envelope - A report whose header already says it is `perf`
 * @param side - Which side of the comparison this is, for the message
 * @returns The validated body, or a refusal string
 */
function readPerfBody(
  envelope: ReportEnvelope<unknown>,
  side: string,
): { body: PerfBody } | { refusal: string } {
  const parsed = PerfBodySchema.safeParse(envelope.body);
  if (!parsed.success) {
    return {
      refusal:
        `REFUSED: the ${side} report's header says facet '${PERF_FACET}' but its body does not ` +
        `match that facet's schema — ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
    };
  }
  return { body: parsed.data as PerfBody };
}

/**
 * Why a pair of rows cannot yield a delta, or `null` when it can.
 *
 * Three classes, and the order they are tested in is part of the contract:
 *
 * 1. **A side did not produce a measurement.** Its statistics are empty, so
 *    there is nothing to subtract. This stays first because a failed row's
 *    `exitCode` is `null` by design — reporting "exit codes differ (null vs 0)"
 *    for a baseline that crashed would name the wrong cause and send the reader
 *    looking for a finding-count change that never happened.
 * 2. **The cache modes differ.** A warm run and a cold run are not two
 *    measurements of one thing.
 * 3. **The accepted exit codes differ.** Both sides finished their work, but
 *    not the same amount of it: a vat validator exits `1` when it has findings
 *    and `0` when it has none, and rendering findings is work the other side
 *    never did. The delta is real and it is not about speed.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns A reason, or `null`
 */
function unmeasurableReason(before: PerfCommandStats, after: PerfCommandStats): string | null {
  if (before.failed && after.failed) return `both sides failed: ${before.failure ?? 'unknown'}`;
  if (before.failed) return `baseline failed: ${before.failure ?? 'unknown'}`;
  if (after.failed) return `compared side failed: ${after.failure ?? 'unknown'}`;
  if (before.cache !== after.cache) {
    // A warm run and a cold run are not two measurements of one thing.
    return `cache mode differs (${before.cache} vs ${after.cache})`;
  }
  if (before.exitCode !== after.exitCode) {
    // Sibling of the cache check, and deliberately after it: both say "these are
    // not two measurements of one thing", but a cache-mode mismatch is a knob
    // the operator set and can simply re-run, while this one sends the reader
    // off to investigate the subject. Name the cheaper cause first when a pair
    // manages to trip both.
    //
    // Both sides completed here — the `failed` trio above already returned — so
    // these are two ACCEPTED codes, and a validator that exited 1 rendered
    // findings the 0 side had none of. Timing them against each other would
    // charge that extra work to speed.
    return (
      `accepted exit codes differ (${String(before.exitCode)} vs ${String(after.exitCode)}) — ` +
      'one side had findings the other did not, so the two runs did not do the same amount of ' +
      'work; find out why the finding count moved before reading anything into the timing'
    );
  }
  return null;
}

/**
 * Diff one command that appears on both sides.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @param options - Significance thresholds
 * @returns The verdict for this command
 */
function verdictFor(
  before: PerfCommandStats,
  after: PerfCommandStats,
  options: SignificanceOptions,
): PerfCommandVerdict {
  const reason = unmeasurableReason(before, after);
  if (reason !== null) return { kind: 'unmeasurable', reason };
  const significance = isSignificant(before, after, options);
  if (significance.significant) return { kind: 'changed', significance };
  // Below the floor on both sides, no delta can clear it — say that plainly
  // rather than letting arithmetic impossibility wear the shape of stability.
  if (
    before.medianMs <= significance.absoluteMs &&
    after.medianMs <= significance.absoluteMs
  ) {
    return { kind: 'below-resolution', floorMs: significance.absoluteMs, significance };
  }
  return { kind: 'unchanged', significance };
}

/**
 * Index a report's command rows by name.
 *
 * @param body - A perf body
 * @returns Rows keyed by command name
 */
function byName(body: PerfBody): ReadonlyMap<string, PerfCommandStats> {
  return new Map(body.commands.map((command) => [command.name, command]));
}

/**
 * Compare two `perf` reports.
 *
 * @param before - The baseline report
 * @param after - The report being compared against it
 * @param options - Axis and significance options
 * @returns A comparison, or a refusal explaining why the two cannot be compared
 */
export function comparePerf(
  before: ReportEnvelope<unknown>,
  after: ReportEnvelope<unknown>,
  options: ComparePerfOptions = {},
): PerfComparison {
  const schemaRefusal = refuseIncomparableSchemas(before, after);
  if (schemaRefusal !== null) return { ok: false, refusal: schemaRefusal };

  if (before.facet !== PERF_FACET) {
    return {
      ok: false,
      refusal: `REFUSED: comparePerf was given '${before.facet}' reports, not '${PERF_FACET}'.`,
    };
  }

  const decision = decideComparison(
    before.coordinate satisfies Coordinate,
    after.coordinate,
    options,
  );
  if (!decision.ok) return { ok: false, refusal: decision.refusal };

  const beforeBody = readPerfBody(before, 'baseline');
  if ('refusal' in beforeBody) return { ok: false, refusal: beforeBody.refusal };
  const afterBody = readPerfBody(after, 'compared');
  if ('refusal' in afterBody) return { ok: false, refusal: afterBody.refusal };

  const beforeRows = byName(beforeBody.body);
  const afterRows = byName(afterBody.body);
  const names = [...new Set([...beforeRows.keys(), ...afterRows.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );

  const commands = names.map((name): PerfCommandDiff => {
    const rowBefore = beforeRows.get(name) ?? null;
    const rowAfter = afterRows.get(name) ?? null;
    if (rowBefore === null && rowAfter !== null) {
      return { name, verdict: { kind: 'added' }, before: null, after: rowAfter };
    }
    if (rowBefore !== null && rowAfter === null) {
      return { name, verdict: { kind: 'removed' }, before: rowBefore, after: null };
    }
    if (rowBefore === null || rowAfter === null) {
      // Unreachable: a name came from one of the two maps.
      return {
        name,
        verdict: { kind: 'unmeasurable', reason: 'row missing on both sides' },
        before: rowBefore,
        after: rowAfter,
      };
    }
    return {
      name,
      verdict: verdictFor(rowBefore, rowAfter, options),
      before: rowBefore,
      after: rowAfter,
    };
  });

  return {
    ok: true,
    axis: decision.axis,
    commands,
    contaminated: beforeBody.body.load.contaminated || afterBody.body.load.contaminated,
  };
}
