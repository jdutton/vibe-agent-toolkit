/**
 * The store's lane counters, each moved by a seed by an exact amount, and the
 * seed families together cover every work counter, both ways.
 */

import { WORK_COUNTER_NAMES } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { PARSE_SEEDS, POPULATION_SEEDS, runSeed, seedCases, seedScope, STORE_SEEDS } from './work-counter-seeds.js';

describe('the work counter seed families', () => {
  it('seed every counter, and nothing that is not one', () => {
    const seeded = [...Object.keys(STORE_SEEDS), ...Object.keys(PARSE_SEEDS), ...Object.keys(POPULATION_SEEDS)];
    expect(seeded.toSorted((a, b) => a.localeCompare(b))).toEqual(
      WORK_COUNTER_NAMES.toSorted((a, b) => a.localeCompare(b)),
    );
  });
});

describe('work counter seeds: store lanes', () => {
  const scope = seedScope();
  it.each(seedCases(STORE_SEEDS))('%s', (counter, seed) => runSeed(scope, counter, seed));
});
