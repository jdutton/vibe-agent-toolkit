/** The parse route's and the content key's counters, each moved by a seed by an exact amount. */

import { describe, it } from 'vitest';

import { PARSE_SEEDS, runSeed, seedCases, seedScope } from './work-counter-seeds.js';

describe('work counter seeds: parse and content', () => {
  const scope = seedScope();
  it.each(seedCases(PARSE_SEEDS))('%s', (counter, seed) => runSeed(scope, counter, seed));
});
