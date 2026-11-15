/**
 * The claude-context population publishes ONE provenance, combined here.
 *
 * Two passes decide it — the root list (stored rows, or a discovery crawl) and
 * the real population — and a caller handed both halves combined them itself:
 * a hit on the real pass behind a crawled root list was not served from the
 * store end to end, and a caller that read `outcome` alone said it was.
 */
import { describe, expect, it } from 'vitest';

import { claudeContextProvenance } from '../src/projection/claude-context-population.js';
import type { PopulationOutcome } from '../src/projection/merge.js';

const HIT: PopulationOutcome = { population: 'store', stored: 'hit' };
const WRITTEN: PopulationOutcome = { population: 'derived', stored: 'written' };

describe('claudeContextProvenance', () => {
  it.each([
    { roots: 'store', outcome: HIT, expected: 'store' },
    // The real pass hit, but the root list was crawled: part of the answer was derived.
    { roots: 'derived', outcome: HIT, expected: 'derived' },
    { roots: 'store', outcome: WRITTEN, expected: 'derived' },
    { roots: 'derived', outcome: WRITTEN, expected: 'derived' },
  ] as const)('root list $roots, real pass $outcome.stored ⇒ $expected', ({ roots, outcome, expected }) => {
    expect(claudeContextProvenance(roots, outcome)).toBe(expected);
  });
});
