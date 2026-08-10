/**
 * The `perf` facet's arithmetic. Pure logic, so these are the tests that have to
 * carry the design decisions rather than a later integration run.
 *
 * Three things are pinned here, each because getting it wrong produces a report
 * that looks authoritative and is not:
 *
 * 1. **Median, not mean.** One contaminated repeat must not move the reported
 *    number. The first test is the positive control for that whole choice: it
 *    computes the mean alongside, shows the two answers differ by orders of
 *    magnitude, and asserts the median is the one that ignored the outlier.
 * 2. **A spread that matches its centre.** The IQR uses the same quantile
 *    definition as the median, so the boundary shapes (1 sample, 2 samples, odd,
 *    even) are all pinned rather than assumed.
 * 3. **Three gates, all required.** `isSignificant` is only conservative while
 *    every gate is enforced. Three tests here fail if the corresponding gate is
 *    deleted, and they say so in their names.
 */

import { describe, expect, it } from 'vitest';

import {
  isSignificant,
  type MedianWithSpread,
  summarize,
} from '../src/facets/perf/stats.js';

/** A tight run with one repeat that landed while the machine was busy. */
const CONTAMINATED = [10, 11, 12, 13, 5000] as const;
/** The same run with the contaminated repeat behaving. */
const CLEAN = [10, 11, 12, 13, 14] as const;

/**
 * Arithmetic mean — defined here only so the tests can show what the median is
 * refusing to do. Production code has no mean, on purpose.
 *
 * @param values - The samples
 * @returns Their mean
 */
function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe('summarize', () => {
  it('reports the median, not the mean: one huge outlier does not move it', () => {
    const stats = summarize(CONTAMINATED);

    // The control: mean and median disagree by two orders of magnitude here, so
    // this test can actually tell the two implementations apart.
    expect(mean(CONTAMINATED)).toBeGreaterThan(1000);
    expect(stats.medianMs).toBe(12);

    // And the outlier changed nothing about the centre — only the extremes and
    // the spread, which is exactly where it belongs.
    expect(summarize(CLEAN).medianMs).toBe(stats.medianMs);
    expect(stats.maxMs).toBe(5000);
  });

  it('handles an odd count, sorting the input first', () => {
    // Deliberately unsorted: capture order is arrival order, never rank order.
    expect(summarize([30, 10, 20])).toEqual({
      medianMs: 20,
      minMs: 10,
      maxMs: 30,
      // n=3: q25 sits at h=0.5 → 15, q75 at h=1.5 → 25.
      iqrMs: 10,
    });
  });

  it('handles an even count by interpolating between the middle two', () => {
    expect(summarize([40, 10, 30, 20])).toEqual({
      medianMs: 25,
      minMs: 10,
      maxMs: 40,
      // n=4: q25 at h=0.75 → 17.5, q75 at h=2.25 → 32.5.
      iqrMs: 15,
    });
  });

  it('gives a single sample a spread of exactly zero', () => {
    // Not an error: one repeat is a legitimate (if weak) measurement. Its IQR is
    // 0, which correctly makes every later difference clear the spread gate and
    // leaves the relative gate as the only defence.
    expect(summarize([42])).toEqual({ medianMs: 42, minMs: 42, maxMs: 42, iqrMs: 0 });
  });

  it('handles two samples', () => {
    // n=2: the quartiles sit a quarter of the way in from each end.
    expect(summarize([20, 10])).toEqual({ medianMs: 15, minMs: 10, maxMs: 20, iqrMs: 5 });
  });

  it('does not mutate the caller-supplied samples while sorting', () => {
    const samples = [30, 10, 20];
    summarize(samples);
    expect(samples).toEqual([30, 10, 20]);
  });

  it('throws on an empty array — an empty measurement is not a zero measurement', () => {
    // Returning zeros would report the fastest number the tool can print for a
    // command that never ran.
    expect(() => summarize([])).toThrow(/not a zero measurement/);
  });
});

/** A slow, perfectly steady baseline — big enough that 5 % is 50 ms. */
const STEADY: MedianWithSpread = { medianMs: 1000, iqrMs: 0 };
/** A 100 ms command measured on a machine with 40 ms of jitter. */
const JITTERY: MedianWithSpread = { medianMs: 100, iqrMs: 40 };
/** A command so fast that percentages stop meaning anything. */
const TINY: MedianWithSpread = { medianMs: 1, iqrMs: 0.02 };

describe('isSignificant', () => {
  it('calls a clear regression real and reports its size and direction', () => {
    const result = isSignificant({ medianMs: 100, iqrMs: 4 }, { medianMs: 160, iqrMs: 6 });

    expect(result.significant).toBe(true);
    expect(result.failedGates).toEqual([]);
    expect(result.deltaMs).toBe(60);
    expect(result.ratio).toBeCloseTo(1.6);
    expect(result.spreadMs).toBe(5);
    expect(result.floorMs).toBe(5);
    expect(result.absoluteMs).toBe(10);
  });

  it('keeps the sign so an improvement is distinguishable from a regression', () => {
    const result = isSignificant({ medianMs: 160, iqrMs: 6 }, { medianMs: 100, iqrMs: 4 });

    expect(result.significant).toBe(true);
    expect(result.deltaMs).toBe(-60);
  });

  it('calls identical measurements noise, naming every gate', () => {
    const result = isSignificant(JITTERY, JITTERY);

    expect(result.significant).toBe(false);
    expect(result.deltaMs).toBe(0);
    expect(result.failedGates).toEqual(['spread', 'relative', 'absolute']);
  });

  it('ALL THREE gates are required: a difference swallowed by the spread is noise even at 30%', () => {
    // Mutation this test kills: dropping the spread gate. 30 ms of 100 ms clears
    // both the 5 % relative floor and the 10 ms absolute floor, so a rule without
    // the spread gate reports a regression — while the two runs' 40 ms bands
    // still overlap completely.
    const result = isSignificant(JITTERY, { medianMs: 130, iqrMs: 40 });

    expect(result.significant).toBe(false);
    expect(result.failedGates).toEqual(['spread']);
    // Spelled out: the two gates that would have passed alone did pass.
    expect(Math.abs(result.deltaMs)).toBeGreaterThan(result.floorMs);
    expect(Math.abs(result.deltaMs)).toBeGreaterThan(result.absoluteMs);
    expect(Math.abs(result.deltaMs)).toBeLessThanOrEqual(result.spreadMs);
  });

  it('ALL THREE gates are required: a 2% difference is noise even with zero spread', () => {
    // Mutation this test kills: dropping the relative gate. Two perfectly steady
    // runs have zero combined spread, and 20 ms clears the absolute floor — so
    // without the relative gate this 2 % move reads as a regression.
    const result = isSignificant(STEADY, { medianMs: 1020, iqrMs: 0 });

    expect(result.significant).toBe(false);
    expect(result.failedGates).toEqual(['relative']);
    expect(Math.abs(result.deltaMs)).toBeGreaterThan(result.spreadMs);
    expect(Math.abs(result.deltaMs)).toBeGreaterThan(result.absoluteMs);
    expect(Math.abs(result.deltaMs)).toBeLessThanOrEqual(result.floorMs);
  });

  it('ALL THREE gates are required: 1ms → 2ms is a 100% move and still noise', () => {
    // Mutation this test kills: dropping the absolute gate. Doubling clears the
    // 5 % relative floor by a mile and the near-zero spread trivially, so both
    // other gates wave it through — but 1 ms is below the run-to-run jitter of
    // starting a process, so the "doubling" is measuring the operating system.
    const result = isSignificant(TINY, { medianMs: 2, iqrMs: 0.02 });

    expect(result.significant).toBe(false);
    expect(result.failedGates).toEqual(['absolute']);
    expect(result.ratio).toBeCloseTo(2);
    expect(Math.abs(result.deltaMs)).toBeGreaterThan(result.spreadMs);
    expect(Math.abs(result.deltaMs)).toBeGreaterThan(result.floorMs);
    expect(Math.abs(result.deltaMs)).toBeLessThanOrEqual(result.absoluteMs);
  });

  it('holds the line on a single repeat, where IQR 0 opens the spread gate completely', () => {
    // One repeat per side: `summarize` gives each an IQR of exactly 0, so the
    // spread threshold is 0 and every non-zero difference clears it. 8 % of 50 ms
    // clears the relative floor too. Only the absolute gate is left — which is
    // the whole argument for keeping it.
    const [a, b] = [summarize([50]), summarize([54])];
    expect(a.iqrMs).toBe(0);
    expect(b.iqrMs).toBe(0);

    const result = isSignificant(a, b);
    expect(result.spreadMs).toBe(0);
    expect(result.significant).toBe(false);
    expect(result.failedGates).toEqual(['absolute']);
  });

  it('raises the relative floor on request, demanding a bigger effect', () => {
    const slower: MedianWithSpread = { medianMs: 1400, iqrMs: 0 };

    expect(isSignificant(STEADY, slower).significant).toBe(true);
    // 40 % is a real move at the default 5 % floor and noise at a 50 % floor.
    const strict = isSignificant(STEADY, slower, { minRelative: 0.5 });
    expect(strict.significant).toBe(false);
    expect(strict.failedGates).toEqual(['relative']);
    expect(strict.floorMs).toBe(500);
  });

  it('honours a lowered minAbsoluteMs for something measured without spawning a process', () => {
    const result = isSignificant(TINY, { medianMs: 2, iqrMs: 0.02 }, { minAbsoluteMs: 0.5 });

    expect(result.absoluteMs).toBe(0.5);
    expect(result.significant).toBe(true);
    expect(result.failedGates).toEqual([]);
  });

  it('honours a raised minAbsoluteMs, suppressing a move that clears the other two gates', () => {
    const result = isSignificant(
      { medianMs: 100, iqrMs: 4 },
      { medianMs: 160, iqrMs: 6 },
      { minAbsoluteMs: 100 },
    );

    expect(result.significant).toBe(false);
    expect(result.failedGates).toEqual(['absolute']);
  });

  it('reports no ratio when the baseline median is zero', () => {
    // Infinity formats as a percentage that reads like data. `null` does not.
    expect(isSignificant({ medianMs: 0, iqrMs: 0 }, { medianMs: 5, iqrMs: 0 }).ratio).toBeNull();
  });

  it('accepts a whole report row, since the argument is a slice of it', () => {
    const summary = summarize(CONTAMINATED);
    const result = isSignificant(summary, summarize(CLEAN));

    // Same median either side — the outlier moved max and IQR, not the centre.
    expect(result.deltaMs).toBe(0);
    expect(result.significant).toBe(false);
  });
});
