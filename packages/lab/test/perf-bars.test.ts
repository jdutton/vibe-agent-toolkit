/**
 * A pass bar compares two arms, and holds only when it holds on the median AND
 * on the min. The two statistics answer different questions — the typical run
 * and the best the machine could do — and a bar that holds on one and not the
 * other is INCONCLUSIVE, never passed. Ties pass under `≤` and fail under `<`.
 */

import { describe, expect, it } from 'vitest';

import { judgeBar, type BarSide } from '../src/facets/perf/bars.js';

/** An arm whose median and min are the same number, so one statistic can be moved alone. */
function side(medianMs: number, minMs = medianMs): BarSide {
  return { medianMs, minMs };
}

describe('judgeBar', () => {
  it('passes when the bar holds on both the median and the min', () => {
    expect(judgeBar(side(90, 80), '<=', side(100, 95)).verdict).toBe('pass');
  });

  it('fails when the bar fails on both', () => {
    expect(judgeBar(side(110, 100), '<=', side(100, 95)).verdict).toBe('fail');
  });

  it('is INCONCLUSIVE when the median holds and the min does not', () => {
    const judged = judgeBar(side(90, 99), '<=', side(100, 95));

    expect(judged).toEqual({ verdict: 'inconclusive', median: true, min: false });
  });

  it('is INCONCLUSIVE when the min holds and the median does not', () => {
    const judged = judgeBar(side(110, 80), '<=', side(100, 95));

    expect(judged).toEqual({ verdict: 'inconclusive', median: false, min: true });
  });

  it('passes a tie under ≤ and fails the same tie under <', () => {
    expect(judgeBar(side(100), '<=', side(100)).verdict).toBe('pass');
    expect(judgeBar(side(100), '<', side(100)).verdict).toBe('fail');
  });

  it('scales the right-hand arm by the bar factor on both statistics', () => {
    // 114 ≤ 1.15 × 100 and 103 ≤ 1.15 × 90; neither holds unscaled.
    expect(judgeBar(side(114, 103), '<=', side(100, 90), 1.15).verdict).toBe('pass');
    expect(judgeBar(side(114, 103), '<=', side(100, 90)).verdict).toBe('fail');
  });

  it('refuses a factor that is not a positive finite number', () => {
    for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => judgeBar(side(1), '<=', side(1), factor)).toThrow(/factor/u);
    }
  });
});
