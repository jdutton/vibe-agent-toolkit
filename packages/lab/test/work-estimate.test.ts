/**
 * What `work ab` compares: a row's persistent-store rows decoded, or the reason
 * there is no such number. A missing counter is lost, never zero, and a row
 * whose own repeats give no warrant is lost with the reason `compare` gives.
 */

import { describe, expect, it } from 'vitest';

import { workEstimates } from '../src/facets/work/estimate.js';

import { workCounters as counters, workRow as row } from './work-fixtures.js';

const UNIT = 'persistent-store rows decoded';

describe('workEstimates', () => {
  it('publishes the count of a stable row', () => {
    expect(workEstimates([row()])).toEqual([{ name: 'resources-scan', value: 120, unit: UNIT, lost: null }]);
  });

  it('loses a row whose measured vat does not emit the counter, never calling it zero', () => {
    const [estimate] = workEstimates([row({ counters: counters().filter((r) => r.name !== 'store.rows.decoded.persistent') })]);
    expect(estimate?.lost).toMatch(/does not emit store\.rows\.decoded\.persistent/);
  });

  it.each([
    ['disagreed', { stable: false }, /repeats disagreed/],
    ['were never tested', { stable: null, comparedRuns: 1 }, /never tested/],
    ['refused a parse under load', { stable: null, loadRefusedRepeats: 2 }, /under machine load/],
  ] as const)('loses a row whose repeats %s, with the reason compare gives', (_label, over, reason) => {
    const [estimate] = workEstimates([row(over)]);
    expect(estimate?.value).toBe(0);
    expect(estimate?.lost).toMatch(reason);
  });

  it('loses a failed row, naming its failure', () => {
    const [estimate] = workEstimates([row({ failed: true, failure: 'no cli dump', counters: [] })]);
    expect(estimate?.lost).toBe('no cli dump');
  });
});
