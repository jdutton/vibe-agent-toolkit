/**
 * A pass bar compares two arms, and holds only when it holds on the median AND
 * on the min. The two statistics answer different questions — the typical run
 * and the best the machine could do — and a bar that holds on one and not the
 * other is INCONCLUSIVE, never passed. Ties pass under `≤` and fail under `<`.
 *
 * A bar is written `<build>:<sequence>:<state> <=|< <factor>*<build>:<sequence>:<state>`
 * — the `--arm` spelling on both sides, and a factor that is never implied.
 */

import { describe, expect, it } from 'vitest';

import { type BarSide, judgeBar, judgeBars, parseBar, renderBars } from '../src/facets/perf/bars.js';

/** An arm whose median and min are the same number, so one statistic can be moved alone. */
function side(medianMs: number, minMs = medianMs): BarSide {
  return { medianMs, minMs };
}

describe('judgeBar', () => {
  it('passes when the bar holds on both the median and the min', () => {
    expect(judgeBar(side(90, 80), '<=', side(100, 95), 1).verdict).toBe('pass');
  });

  it('fails when the bar fails on both', () => {
    expect(judgeBar(side(110, 100), '<=', side(100, 95), 1).verdict).toBe('fail');
  });

  it('is INCONCLUSIVE when the median holds and the min does not', () => {
    const judged = judgeBar(side(90, 99), '<=', side(100, 95), 1);

    expect(judged).toEqual({ verdict: 'inconclusive', median: true, min: false });
  });

  it('is INCONCLUSIVE when the min holds and the median does not', () => {
    const judged = judgeBar(side(110, 80), '<=', side(100, 95), 1);

    expect(judged).toEqual({ verdict: 'inconclusive', median: false, min: true });
  });

  it('passes a tie under ≤ and fails the same tie under <', () => {
    expect(judgeBar(side(100), '<=', side(100), 1).verdict).toBe('pass');
    expect(judgeBar(side(100), '<', side(100), 1).verdict).toBe('fail');
  });

  it('scales the right-hand arm by the bar factor on both statistics', () => {
    // 114 ≤ 1.15 × 100 and 103 ≤ 1.15 × 90; neither holds unscaled.
    expect(judgeBar(side(114, 103), '<=', side(100, 90), 1.15).verdict).toBe('pass');
    expect(judgeBar(side(114, 103), '<=', side(100, 90), 1).verdict).toBe('fail');
  });

  it('refuses a factor that is not a positive finite number', () => {
    for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => judgeBar(side(1), '<=', side(1), factor)).toThrow(/factor/u);
    }
  });
});

describe('parseBar', () => {
  it('reads both arms in the --arm spelling, the relation and the factor', () => {
    expect(parseBar('cand:ci-c:cold<=1.15*rc11:ci-a:cold')).toEqual({
      text: 'cand:ci-c:cold<=1.15*rc11:ci-a:cold',
      left: { build: 'cand', arm: 'ci-c', state: 'cold' },
      relation: '<=',
      factor: 1.15,
      right: { build: 'rc11', arm: 'ci-a', state: 'cold' },
    });
    expect(parseBar(' cand:ci-c:warm < 1 * cand:ci-b:warm ')).toMatchObject({ relation: '<', factor: 1 });
  });

  it('refuses a bar with no factor — a factor is never implied — and anything else malformed', () => {
    expect(parseBar('cand:ci-c:cold<=rc11:ci-a:cold')).toMatch(/factor/u);
    expect(parseBar('cand:ci-c:tepid<=1*rc11:ci-a:cold')).toMatch(/expects/u);
    expect(parseBar('cand:ci-c:cold>=1*rc11:ci-a:cold')).toMatch(/expects/u);
    expect(parseBar('cand:ci-c:cold<=0*rc11:ci-a:cold')).toMatch(/factor/u);
  });
});

describe('judgeBars', () => {
  const arm = (build: string, name: string, medianMs: number, minMs: number) => ({
    build,
    arm: name,
    state: 'cold' as const,
    summary: { medianMs, minMs },
    failure: null,
  });
  const report = {
    arms: [
      arm('rc11', 'ci-a', 100, 90),
      arm('cand', 'ci-c', 110, 100),
      arm('cand', 'ci-b', 105, 101),
      { build: 'rc11', arm: 'ci-b', state: 'cold' as const, summary: null, failure: "1 of 5 repeats failed — step 'x' exited 1" },
    ],
  };
  const bar = (text: string) => {
    const parsed = parseBar(text);
    if (typeof parsed === 'string') throw new Error(parsed);
    return parsed;
  };

  it('judges each bar against the report’s arms', () => {
    const judged = judgeBars(report, [bar('cand:ci-c:cold<=1.15*rc11:ci-a:cold'), bar('cand:ci-b:cold<=1*cand:ci-c:cold')]);

    expect(judged.ok ? judged.results.map((result) => result.verdict) : judged.refusal).toEqual(['pass', 'inconclusive']);
  });

  it('fails a bar over an arm with no measurement, giving the arm’s failure', () => {
    const judged = judgeBars(report, [bar('rc11:ci-b:cold<=1*rc11:ci-a:cold')]);

    expect(judged.ok ? judged.results[0] : judged.refusal).toMatchObject({
      verdict: 'fail',
      reason: "rc11 ci-b cold has no measurement: 1 of 5 repeats failed — step 'x' exited 1",
    });
  });

  it('refuses a bar naming an arm the report does not hold', () => {
    const judged = judgeBars(report, [bar('cand:ci-a:warm<=1*rc11:ci-a:cold')]);

    expect(judged.ok ? '' : judged.refusal).toMatch(/cand:ci-a:warm.*not in the report/u);
  });

  it('renders one line per bar with its verdict and both statistics', () => {
    const judged = judgeBars(report, [bar('cand:ci-b:cold<=1*cand:ci-c:cold')]);
    if (!judged.ok) throw new Error(judged.refusal);

    expect(renderBars(judged.results)).toBe(
      'INCONCLUSIVE  cand:ci-b:cold<=1*cand:ci-c:cold  (median holds, min does not — re-run on a quiet machine)',
    );
  });
});
