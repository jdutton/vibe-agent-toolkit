/** The population's counters and the git spawn counter, each moved by a seed by an exact amount. */

import { describe, it } from 'vitest';

import { POPULATION_SEEDS, runSeed, seedCases, seedScope } from './work-counter-seeds.js';

describe('work counter seeds: population and git', () => {
  const scope = seedScope();
  it.each(seedCases(POPULATION_SEEDS))('%s', (counter, seed) => runSeed(scope, counter, seed));
});
