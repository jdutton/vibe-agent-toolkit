/**
 * The statistics behind the `perf` facet, and the rule for calling a difference
 * real.
 *
 * Two decisions are encoded here, and both exist to stop a performance gate
 * from losing its credibility:
 *
 * 1. **The centre is the median, never the mean.** A repeat that landed while
 *    the machine was busy is not evidence about vat; it is evidence about the
 *    machine. A mean hands that outlier a vote proportional to how wrong it was,
 *    so one contaminated repeat out of five can move the reported number by
 *    hundreds of milliseconds. The median simply does not see it.
 * 2. **A difference has to clear three independent gates.** Any single gate is
 *    wrong somewhere: a spread-only rule shouts about a tiny move between two
 *    very steady runs, a percentage-only rule shouts about a move that sits
 *    entirely inside the run-to-run jitter, and neither notices that a 1 ms →
 *    2 ms "doubling" is smaller than the cost of starting a process. Requiring
 *    all three makes the answer conservative — this module would rather stay
 *    quiet about a real regression than cry "regression" at noise, because the
 *    first costs one release and the second costs the gate's credibility
 *    permanently.
 *
 * Everything here is pure: no clock, no filesystem, no process. The measuring
 * lives elsewhere so that the arithmetic can be tested without one.
 */

import { quantile } from '../../harness/estimator.js';

import type { PerfCommandStats } from './types.js';

/**
 * The statistics {@link summarize} derives from a set of repeats.
 *
 * Deliberately a `Pick` of the report shape rather than a fresh interface: the
 * summary and the row it lands in cannot drift apart if only one of them is
 * written down.
 */
export type PerfSummary = Pick<PerfCommandStats, 'medianMs' | 'minMs' | 'maxMs' | 'iqrMs'>;

/**
 * A centre and the spread that travels with it.
 *
 * Also a `Pick`, so a whole {@link PerfCommandStats} row can be handed to
 * {@link isSignificant} without unpacking it first.
 */
export type MedianWithSpread = Pick<PerfCommandStats, 'medianMs' | 'iqrMs'>;

/**
 * Reduce a set of repeats to the statistics the report carries.
 *
 * Throws on an empty array rather than returning zeros. **An empty measurement
 * is not a zero measurement** — `0 ms` is the fastest number this tool can
 * print, so inventing one turns "we never ran it" into a spectacular
 * improvement, which is the most expensive lie a perf report can tell.
 *
 * @param samplesMs - Wall-clock duration of each repeat, in any order
 * @returns The median, the extremes, and the interquartile range
 * @throws When `samplesMs` is empty
 */
export function summarize(samplesMs: readonly number[]): PerfSummary {
  if (samplesMs.length === 0) {
    throw new Error(
      'summarize: no samples — an empty measurement is not a zero measurement. ' +
        'A command that never ran has no median, and reporting 0 ms would read as the best result possible.',
    );
  }
  // Copy before sorting: the caller's array is readonly, and the report keeps
  // `samplesMs` in capture order so a reader can see run-to-run drift.
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const minMs = sorted[0];
  const maxMs = sorted.at(-1);
  if (minMs === undefined || maxMs === undefined) {
    // Unreachable — the length was checked above. Present so the extremes are
    // read without a non-null assertion papering over the index type.
    throw new Error('summarize: sorted samples were unexpectedly empty');
  }
  return {
    medianMs: quantile(sorted, 0.5),
    minMs,
    maxMs,
    iqrMs: quantile(sorted, 0.75) - quantile(sorted, 0.25),
  };
}

/** Which test a candidate difference failed. */
export type SignificanceGate = 'spread' | 'relative' | 'absolute';

/** Options for {@link isSignificant}. */
export interface SignificanceOptions {
  /**
   * Smallest fraction of the smaller median that counts as a real difference.
   *
   * Defaults to `0.05`. Raise it on a noisy machine: the honest response to
   * contaminated measurements is to demand a bigger effect, never to explain
   * away the ones that appear.
   */
  readonly minRelative?: number;
  /**
   * Smallest difference in milliseconds that counts as a real difference.
   *
   * Defaults to `10`. **Do not delete this gate** — it is the only one of the
   * three that survives the two situations where the others are useless:
   *
   * 1. A sub-10 ms move is below the run-to-run noise of starting a process on
   *    any real machine, whatever percentage it works out to. `1 ms → 2 ms` is a
   *    100 % regression by the relative gate and a cosmic-ray hit in reality.
   * 2. A single repeat has an IQR of exactly `0`, which opens the spread gate
   *    completely. The absolute floor is the only thing still holding the line
   *    in precisely the case where the measurement is weakest.
   *
   * Lower it only when the thing being timed is genuinely sub-millisecond and
   * measured without spawning a process.
   */
  readonly minAbsoluteMs?: number;
}

/**
 * Why a difference was, or was not, called real.
 *
 * Every threshold travels with the verdict on purpose: a caller has to be able
 * to say *"2 ms, but the two runs overlap by 40 ms"* rather than the
 * unfalsifiable *"not significant"*. A gate nobody can interrogate gets
 * overridden the first time it is inconvenient.
 */
export interface SignificanceResult {
  /** True only when every gate passed. */
  readonly significant: boolean;
  /** Signed difference `b - a`, so the direction of the move survives. */
  readonly deltaMs: number;
  /**
   * `b / a`, or `null` when the baseline median is `0` and no ratio exists.
   *
   * `null` rather than `Infinity`: a formatter printing `Infinity%` has been
   * handed something that was never a number.
   */
  readonly ratio: number | null;
  /** Threshold the spread gate applied: half of each IQR, summed. */
  readonly spreadMs: number;
  /** Threshold the relative gate applied, in milliseconds. */
  readonly floorMs: number;
  /** Threshold the absolute gate applied, in milliseconds. */
  readonly absoluteMs: number;
  /** Gates that failed, in the order tested; empty when the difference is real. */
  readonly failedGates: readonly SignificanceGate[];
}

/** Fraction of the smaller median a difference must exceed by default. */
const DEFAULT_MIN_RELATIVE = 0.05;

/**
 * Milliseconds a difference must exceed by default.
 *
 * 10 ms is roughly the jitter of spawning a process, which is the floor of what
 * this facet can measure at all. See {@link SignificanceOptions.minAbsoluteMs}
 * for why removing this gate is not safe even though the other two look
 * sufficient.
 */
const DEFAULT_MIN_ABSOLUTE_MS = 10;

/**
 * Is the difference between two medians real, or is it noise?
 *
 * All three gates must pass, and each catches a lie the others miss:
 *
 * - **spread** — `|delta| > iqrA / 2 + iqrB / 2`. Half of each IQR is the width
 *   of the band each measurement plausibly occupies; while those bands still
 *   touch, the medians drifting apart proves nothing. This is what stops a
 *   jittery machine from manufacturing regressions.
 * - **relative** — `|delta| > minRelative * min(medianA, medianB)`. Two very
 *   steady runs have near-zero IQRs, which makes the spread gate pass on almost
 *   any difference at all; this gate keeps the tool quiet about moves too small
 *   *in proportion* to act on.
 * - **absolute** — `|delta| > minAbsoluteMs`. The relative gate is scale-free,
 *   so it waves through `1 ms → 2 ms` as a 100 % regression; and a single repeat
 *   has `iqr === 0`, which opens the spread gate entirely. This gate is what is
 *   left holding the line in both of those cases — see
 *   {@link SignificanceOptions.minAbsoluteMs}.
 *
 * The three compose to an effective threshold of `max(spread, floor, absolute)`,
 * with a different one dominating at each scale: absolute for very fast
 * commands, relative for slow ones, spread whenever the machine is noisy.
 *
 * All are strict inequalities: a difference exactly equal to its threshold has
 * not exceeded it.
 *
 * @param a - The baseline measurement
 * @param b - The measurement being compared against it
 * @param options - See {@link SignificanceOptions}
 * @returns The verdict, all three thresholds, and the gates that failed
 */
export function isSignificant(
  a: MedianWithSpread,
  b: MedianWithSpread,
  options: SignificanceOptions = {},
): SignificanceResult {
  const minRelative = options.minRelative ?? DEFAULT_MIN_RELATIVE;
  const deltaMs = b.medianMs - a.medianMs;
  const magnitude = Math.abs(deltaMs);

  const spreadMs = a.iqrMs / 2 + b.iqrMs / 2;
  const floorMs = Math.min(a.medianMs, b.medianMs) * minRelative;
  const absoluteMs = options.minAbsoluteMs ?? DEFAULT_MIN_ABSOLUTE_MS;

  const failedGates: SignificanceGate[] = [];
  if (magnitude <= spreadMs) failedGates.push('spread');
  if (magnitude <= floorMs) failedGates.push('relative');
  if (magnitude <= absoluteMs) failedGates.push('absolute');

  return {
    significant: failedGates.length === 0,
    deltaMs,
    ratio: a.medianMs === 0 ? null : b.medianMs / a.medianMs,
    spreadMs,
    floorMs,
    absoluteMs,
    failedGates,
  };
}
