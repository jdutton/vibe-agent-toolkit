/**
 * Randomized DIFFERENTIAL test of `vat claude context` against a reference port
 * of Claude Code's memory loader — the WIDE tier, on disk through the production population lane: seeds 409–508.
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
  loaderDifferentialFailures,
  loaderSweepSeeds,
} from '../helpers/claude-loader-differential.js';

import { onDiskProjection } from './claude-context-tree.js';

describe('vat claude context agrees with a reference port of the Claude Code loader (wide sweep, on disk)', () => {
  it('across 100 seeded random trees (seeds 409–508)', async () => {
    const failures = await loaderDifferentialFailures(loaderSweepSeeds(409, 100), FAST_SETTLED_FEATURES, onDiskProjection);
    expect(failures, failures.join('\n')).toEqual([]);
  }, 60_000);
});
