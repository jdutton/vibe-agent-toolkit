/**
 * `foldRepeat`: one repeat's RSS dumps become one sample only when at least one
 * vat process reported, and the sample is the largest vat process's peak.
 */

import { describe, expect, it } from 'vitest';

import { foldRepeat, foldRepeats } from '../src/facets/memory/capture.js';
import type { RssDump } from '../src/facets/memory/types.js';

const vat = (maxRssKb: number): RssDump => ({ pid: 2, maxRssKb });

describe('foldRepeat', () => {
  it('takes the largest vat peak and counts the vat processes', () => {
    expect(foldRepeat([vat(300_000), vat(500_000)], 0)).toEqual({ peakKb: 500_000, processes: 2 });
  });

  it('refuses a repeat where no vat process wrote a peak', () => {
    expect(foldRepeat([], 1)).toMatch(/^repeat 2: no vat process wrote a peak/);
  });
});

describe('foldRepeats', () => {
  it('collects every repeat\'s sample and process count', () => {
    expect(foldRepeats([[vat(100)], [vat(120)]])).toEqual({ samplesKb: [100, 120], processesPerRepeat: [1, 1] });
  });

  it('fails the row when the repeats disagree on how many vat processes ran', () => {
    expect(foldRepeats([[vat(100)], [vat(90), vat(100)]])).toMatch(
      /^the repeats disagree on how many vat processes ran \(1\/2\)/,
    );
  });

  it('passes on the first repeat\'s refusal', () => {
    expect(foldRepeats([[vat(100)], []])).toMatch(/^repeat 2: no vat process wrote a peak/);
  });
});
