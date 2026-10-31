import { describe, expect, it } from 'vitest';

import type { PopulationOutcome } from '../src/projection/merge.js';
import { combineOutcomes } from '../src/projection/resource-population.js';

const HIT: PopulationOutcome = { population: 'store', stored: 'hit' };
const WRITTEN: PopulationOutcome = { population: 'derived', stored: 'written' };
const SKIPPED: PopulationOutcome = { population: 'derived', stored: 'skipped-tree-changed' };
const NO_STORE: PopulationOutcome = { population: 'derived', stored: 'no-store' };

describe('combineOutcomes', () => {
  it('is null when no root was enumerated, because nothing was populated', () => {
    expect(combineOutcomes([])).toBeNull();
  });

  it('is the one root\'s outcome for a single root', () => {
    expect(combineOutcomes([WRITTEN])).toEqual(WRITTEN);
    expect(combineOutcomes([HIT])).toEqual(HIT);
  });

  it('is a hit only when every root hit', () => {
    expect(combineOutcomes([HIT, HIT, HIT])).toEqual(HIT);
  });

  it('is the FIRST root, in enumeration order, that did not hit', () => {
    expect(combineOutcomes([HIT, SKIPPED, NO_STORE])).toEqual(SKIPPED);
    expect(combineOutcomes([NO_STORE, HIT, SKIPPED])).toEqual(NO_STORE);
    expect(combineOutcomes([HIT, WRITTEN])).toEqual(WRITTEN);
  });
});
