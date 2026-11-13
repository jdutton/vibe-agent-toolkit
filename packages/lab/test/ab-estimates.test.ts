/**
 * What the exact-count facets hand `ab`: one number per row, or the reason
 * there is none. Both go through the shared `rowEstimates` rule, so a failed
 * row is lost with its failure, and a row that ran but whose own repeats give no
 * warrant is lost with the reason `compare` gives, never published as a value.
 */

import { describe, expect, it } from 'vitest';

import { ioEstimates, workEstimates } from '../src/bin/vat-lab.js';

import { ioCommand } from './io-fixtures.js';
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

  it('loses a failed row with no reason in the one wording every facet uses', () => {
    const [estimate] = workEstimates([row({ failed: true, failure: null, counters: [] })]);
    expect(estimate?.lost).toBe('failed, with no reason recorded');
  });
});

describe('ioEstimates', () => {
  it('publishes the user calls of a stable row', () => {
    expect(ioEstimates([ioCommand()])).toEqual([{ name: 'resources-scan', value: 436, unit: 'calls', lost: null }]);
  });

  it.each([
    ['disagreed', { stable: false }, /repeats disagreed/],
    ['were never tested', { stable: null, comparedRuns: 1 }, /never tested/],
  ] as const)('loses a row whose repeats %s, never publishing its count', (_label, over, reason) => {
    const [estimate] = ioEstimates([ioCommand(over)]);
    expect(estimate?.value).toBe(0);
    expect(estimate?.lost).toMatch(reason);
  });

  it('loses a failed row, naming its failure', () => {
    const [estimate] = ioEstimates([ioCommand({ failed: true, failure: 'exit 1' })]);
    expect(estimate?.lost).toBe('exit 1');
  });
});
