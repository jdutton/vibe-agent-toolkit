/**
 * `foldRepeat`: one repeat's RSS dumps become one sample only when the spawner
 * and at least one vat process both reported, and the sample is the largest vat
 * process's peak — never the spawner's.
 */

import { describe, expect, it } from 'vitest';

import { foldRepeat, foldRepeats } from '../src/facets/memory/capture.js';
import type { RssDump } from '../src/facets/memory/types.js';

const spawner = (maxRssKb: number): RssDump => ({ pid: 1, role: 'spawner', maxRssKb });
const vat = (maxRssKb: number): RssDump => ({ pid: 2, role: 'vat', maxRssKb });

describe('foldRepeat', () => {
  it('takes the largest vat peak, counts vat processes only, and carries the spawner as the floor', () => {
    expect(foldRepeat([spawner(900_000), vat(300_000), vat(500_000)], 0)).toEqual({
      peakKb: 500_000,
      processes: 2,
      spawnerKb: 900_000,
    });
  });

  it('refuses a repeat where no vat process wrote a peak, rather than reporting the spawner', () => {
    expect(foldRepeat([spawner(40_000)], 1)).toMatch(/^repeat 2: no vat process wrote a peak/);
  });

  it('refuses a repeat that did not run through exactly one spawner', () => {
    expect(foldRepeat([vat(300_000)], 0)).toMatch(/the spawner wrote 0 peaks, not 1/);
    expect(foldRepeat([spawner(1), spawner(2), vat(3)], 0)).toMatch(/the spawner wrote 2 peaks, not 1/);
  });
});

describe('foldRepeats', () => {
  it('collects every repeat\'s sample, process count and floor', () => {
    expect(foldRepeats([[spawner(10), vat(100)], [spawner(11), vat(120)]])).toEqual({
      samplesKb: [100, 120],
      processesPerRepeat: [1, 1],
      spawnerKb: [10, 11],
    });
  });

  it('fails the row when the repeats disagree on how many vat processes ran', () => {
    expect(foldRepeats([[spawner(10), vat(100)], [spawner(10), vat(90), vat(100)]])).toMatch(
      /^the repeats disagree on how many vat processes ran \(1\/2\)/,
    );
  });

  it('passes on the first repeat\'s refusal', () => {
    expect(foldRepeats([[spawner(10), vat(100)], [vat(100)]])).toMatch(/^repeat 2: the spawner wrote 0 peaks/);
  });
});
