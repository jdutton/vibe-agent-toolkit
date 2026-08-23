/**
 * The order statistics an A/B reports.
 *
 * The load-bearing test here is the one that pins `min` *against* a median: on a
 * loaded machine every sample is the true cost plus a non-negative
 * contamination, and with a handful of samples one cold repeat is enough to move
 * a median while leaving the minimum untouched. A fixture whose samples happen to
 * make the two agree would pass for a module that computed either, so the
 * samples below are chosen so that min, p25, median and mean are four different
 * numbers.
 */

import { describe, expect, it } from 'vitest';

import { estimate, quantile } from '../src/harness/estimator.js';

describe('quantile', () => {
  it('interpolates between order statistics, R type-7 style', () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75);
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(quantile([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25);
  });

  it('collapses to the single sample at n = 1', () => {
    expect(quantile([7], 0)).toBe(7);
    expect(quantile([7], 0.25)).toBe(7);
    expect(quantile([7], 1)).toBe(7);
  });

  it('throws on an empty sample rather than indexing off the end', () => {
    expect(() => quantile([], 0.5)).toThrow(/no samples/);
  });
});

describe('estimate', () => {
  it('reports the minimum, not the median — one slow sample must not move it', () => {
    // min 100, p25 150, median 200, mean 266.67: four different answers, so the
    // assertions below cannot pass for a module that computed a different one.
    const result = estimate([200, 100, 500]);

    expect(result.min).toBe(100);
    expect(result.p25).toBe(150);
    // The control on the control: a median WOULD have been 200 here, and that is
    // the number this estimator exists not to report.
    expect(result.min).not.toBe(200);
  });

  it('keeps the samples in the order they were taken, so drift stays visible', () => {
    expect(estimate([300, 100, 200]).samples).toEqual([300, 100, 200]);
  });

  it('throws on no samples rather than reporting zero', () => {
    // Zero is the best number this tool can print, so inventing one would turn
    // "we never ran it" into the fastest result ever measured.
    expect(() => estimate([])).toThrow(/not a zero measurement/);
  });
});
