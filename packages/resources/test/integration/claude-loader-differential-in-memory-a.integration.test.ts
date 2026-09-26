/**
 * Randomized DIFFERENTIAL test of `vat claude context` against a reference port
 * of Claude Code's memory loader — the WIDE tier, in memory: seeds 9–158.
 * The integration tier sweeps seeds 9–508 in four files (in-memory-a/b, on-disk-a/b), continuing
 * the unit tier's 1–8 so the tiers together sweep one contiguous prefix; it is
 * split only so each file fits the tier's per-file budget.
 *
 * The engine is `../helpers/claude-loader-differential.ts`; its header says
 * what is compared. Re-run one failing seed with `LOADER_DIFFERENTIAL_SEED=<n>`.
 */

import { describe, expect, it } from 'vitest';

import {
  FAST_SETTLED_FEATURES,
  inMemoryProjection,
  loaderDifferentialFailures,
  loaderSweepSeeds,
} from '../helpers/claude-loader-differential.js';

describe('vat claude context agrees with a reference port of the Claude Code loader (wide sweep, in memory)', () => {
  it('across 150 seeded random trees (seeds 9–158)', async () => {
    const failures = await loaderDifferentialFailures(loaderSweepSeeds(9, 150), FAST_SETTLED_FEATURES, inMemoryProjection);
    expect(failures, failures.join('\n')).toEqual([]);
  }, 60_000);
});
