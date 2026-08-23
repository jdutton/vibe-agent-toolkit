/**
 * Order statistics, shared by everything in the lab that reduces repeats to a
 * number.
 *
 * There is one quantile definition here and every caller uses it. *Which* of the
 * several plausible definitions is used matters far less than using one
 * consistently — a median computed one way and an IQR another produces a spread
 * that does not describe the centre it is attached to, and the same hazard
 * applies across modules: a `p25` computed here and an IQR computed in the perf
 * facet would silently describe two different distributions of the same samples.
 */

/**
 * Quantile of an already-sorted sample, by linear interpolation between the
 * order statistics.
 *
 * **The method:** for `n` samples and probability `p`, the zero-based position
 * is `h = (n - 1) * p`, and the result is
 * `x[floor(h)] + (h - floor(h)) * (x[ceil(h)] - x[floor(h)])`. This is the R
 * type-7 / NumPy-default definition.
 *
 * Consequences worth knowing: at `n = 1` every quantile is the single sample, so
 * an IQR is exactly `0`; at `n = 2` the quartiles sit a quarter of the way in
 * from each end rather than on the samples themselves.
 *
 * @param sorted - Samples in ascending order; must be non-empty
 * @param p - Probability in `[0, 1]`
 * @returns The interpolated quantile
 * @throws {Error} When `sorted` is empty, which would otherwise index off the end
 */
export function quantile(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lowIndex = Math.floor(h);
  const lowValue = sorted[lowIndex];
  const highValue = sorted[Math.ceil(h)];
  if (lowValue === undefined || highValue === undefined) {
    throw new Error('quantile: no samples — an empty measurement has no quantiles');
  }
  return lowValue + (highValue - lowValue) * (h - lowIndex);
}

/**
 * The two order statistics an A/B reports for one arm.
 *
 * **`min` is the estimator, and `p25` is what qualifies it — never a median and
 * never a mean.** On a loaded machine every sample is the true cost plus a
 * non-negative contamination, so the *smallest* sample is the closest thing to
 * an uncontaminated observation the run produced; a median hands the machine a
 * vote proportional to how busy it was. The failure is worse than general
 * noisiness in this harness specifically: each instrument gets its own
 * parse-cache namespace, so an arm's first invocation is systematically cold, and
 * with a handful of samples one cold repeat is enough to drag a median while
 * leaving the min untouched.
 *
 * `p25` travels with it because a min alone cannot be interrogated. Two arms
 * whose mins differ by less than the gap between each arm's own min and p25 have
 * not shown anything, and a reader needs both numbers to see that.
 */
export interface Estimate {
  /** The estimator: the smallest sample. */
  readonly min: number;
  /** The first quartile, as the spread that qualifies {@link Estimate.min}. */
  readonly p25: number;
  /** Every sample, in the order it was taken, so a reader can check the two above. */
  readonly samples: readonly number[];
}

/**
 * Reduce a set of samples to {@link Estimate}.
 *
 * Throws on an empty array rather than returning zeros. An empty measurement is
 * not a zero measurement — `0` is the best number this tool can print, so
 * inventing one turns "we never ran it" into a spectacular improvement.
 *
 * @param samples - The samples, in any order
 * @returns The min, the first quartile, and the samples as given
 * @throws {Error} When `samples` is empty
 */
export function estimate(samples: readonly number[]): Estimate {
  if (samples.length === 0) {
    throw new Error(
      'estimate: no samples — an empty measurement is not a zero measurement. ' +
        'An arm that never produced a reading has no minimum, and reporting 0 would read as ' +
        'the best result possible.',
    );
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { min: quantile(sorted, 0), p25: quantile(sorted, 0.25), samples: [...samples] };
}
