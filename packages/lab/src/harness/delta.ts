/**
 * Subtracting two measurements, and deciding whether the difference is real.
 *
 * Extracted from the facets rather than written per facet, and the reason is not
 * economy. Every measurement facet publishes a "did this move?" verdict, and the
 * *rule* behind that verdict is the tool's contract with its reader: which side
 * the relative gate is taken against, whether a move exactly equal to a threshold
 * counts, what a ratio against a zero baseline is. Two hand-written copies are
 * free to answer those differently, and then two reports of the same run
 * disagree about whether anything happened — for reasons a reader has no way to
 * discover, because both look correct.
 *
 * What stays in a facet: which of its numbers are worth subtracting, and what a
 * movement in them means. That is the part that is genuinely about milliseconds
 * in a parser versus milliseconds in a crawler.
 */

import { pairByKey } from './diff.js';

/** A before/after pair of counts with the difference already taken. */
export interface CountDelta {
  readonly before: number;
  readonly after: number;
  /** `after - before`. Exact: these are counts. */
  readonly delta: number;
}

/** A before/after pair of durations, with the verdict on whether the move is real. */
export interface MsDelta {
  readonly before: number;
  readonly after: number;
  /** `after - before`, unrounded. */
  readonly delta: number;
  /** `after / before`, or `null` when the baseline is `0` and no ratio exists. */
  readonly ratio: number | null;
  /** True when the move cleared both the relative gate and the absolute floor. */
  readonly significant: boolean;
}

/** How big a duration move has to be before it counts. */
export interface DeltaThresholds {
  /** Smallest fraction of the smaller side that counts as a real move. */
  readonly minRelative?: number;
  /** Smallest millisecond move that counts. */
  readonly minAbsoluteMs?: number;
}

/** Fraction of the smaller side a duration must move by to count as real. */
export const DEFAULT_MIN_RELATIVE = 0.1;

/**
 * Milliseconds a duration must move by to count as real.
 *
 * Lower than `perf`'s floor because the facets using this bracket their work
 * *inside* the process with `performance.now()`, so there is no process-startup
 * jitter underneath the figure. It is not zero, because summing hundreds of
 * sub-millisecond brackets accumulates its own noise.
 */
export const DEFAULT_MIN_ABSOLUTE_MS = 2;

/**
 * Take one count difference.
 *
 * @param before - The baseline value
 * @param after - The compared value
 * @returns Both sides and the signed difference
 */
export function countDelta(before: number, after: number): CountDelta {
  return { before, after, delta: after - before };
}

/**
 * Take one duration difference and say whether it is real.
 *
 * Both gates are strict inequalities: a move exactly equal to its threshold has
 * not exceeded it. The relative gate is taken against the SMALLER side so that
 * "10% bigger" and "10% smaller" are the same size of claim.
 *
 * ⚠️ Both gates are scaled to the ROW they are applied to, never to the
 * measurement the row belongs to. A caller that ORs this verdict across many
 * rows therefore gives a cheap row the same power to flip a command's verdict as
 * an expensive one — measured on `parse`, where a 16ms pass worth 0.17% of the
 * budget flipped a control run while the pass worth 83% correctly stayed quiet.
 * The failure direction is safe (it over-reports `changed`, which surfaces as a
 * refusal to answer rather than a wrong answer), but nothing should GATE on such
 * a verdict without first scaling the floor to the command total.
 *
 * @param before - The baseline duration
 * @param after - The compared duration
 * @param thresholds - How big a move has to be; both fields default
 * @returns The delta, the ratio, and the verdict
 */
export function msDelta(before: number, after: number, thresholds: DeltaThresholds): MsDelta {
  const delta = after - before;
  const magnitude = Math.abs(delta);
  const relative = (thresholds.minRelative ?? DEFAULT_MIN_RELATIVE) * Math.min(before, after);
  const absolute = thresholds.minAbsoluteMs ?? DEFAULT_MIN_ABSOLUTE_MS;
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

/** A labelled `(calls, elapsedMs)` pair — what a per-row movement is built from. */
export interface LabelledRow {
  readonly label: string;
  readonly calls: number;
  readonly elapsedMs: number;
}

/** Whether a row is new, gone, or present on both sides. */
export type RowMovementKind = 'added' | 'removed' | 'changed';

/** What happened to one labelled row between two reports. */
export interface RowMovement {
  readonly label: string;
  readonly kind: RowMovementKind;
  readonly elapsedMs: MsDelta;
  readonly calls: CountDelta;
}

/**
 * Pair two sides' labelled rows and describe each one.
 *
 * **Every row appears, moved or not.** A report's subject is the *shape* of what
 * was measured, and a list that dropped the unmoved rows would make one shifted
 * row look like the whole story. A row present on only one side is `added` or
 * `removed` rather than silently omitted — its delta is still taken against
 * zero, because a row that appeared genuinely did go from nothing to something
 * and a reader needs the size of that.
 *
 * @param before - The baseline rows
 * @param after - The compared rows
 * @param thresholds - How big a duration move has to be to count
 * @returns One movement per row, in a stable order
 */
export function labelledMovements(
  before: readonly LabelledRow[],
  after: readonly LabelledRow[],
  thresholds: DeltaThresholds,
): readonly RowMovement[] {
  const identify = (row: LabelledRow): string => row.label;
  return pairByKey(before, after, identify).map((pair): RowMovement => {
    let kind: RowMovementKind = 'changed';
    if (pair.before === null) kind = 'added';
    else if (pair.after === null) kind = 'removed';
    return {
      label: pair.key,
      kind,
      elapsedMs: msDelta(pair.before?.elapsedMs ?? 0, pair.after?.elapsedMs ?? 0, thresholds),
      calls: countDelta(pair.before?.calls ?? 0, pair.after?.calls ?? 0),
    };
  });
}
