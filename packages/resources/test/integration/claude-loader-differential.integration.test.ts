/**
 * Randomized DIFFERENTIAL test of `vat claude context` against a reference port
 * of Claude Code's memory loader — the WIDE tier, in memory: seeds 9–308,
 * continuing the unit tier's 1–8 so the tiers together sweep one contiguous
 * prefix. The on-disk sweep (309–508) and the 4 MiB size-cliff cases live in
 * sibling files so each stays inside the integration tier's per-file budget.
 *
 * The engine is `../helpers/claude-loader-differential.ts`; its header says
 * what is compared. Re-run one failing seed with `LOADER_DIFFERENTIAL_SEED=<n>`.
 */

import { describe, expect, it } from 'vitest';

import { claudeContextFixture } from '../helpers/claude-context-fixture.js';
import { loaderDifferentialFailures, loaderSweepSeeds, SETTLED_FEATURES } from '../helpers/claude-loader-differential.js';

/** VAT's projection, built in memory through the shipped contributors. */
const inMemory = (files: Readonly<Record<string, string>>) => claudeContextFixture({ ...files });

/** The settled groups without the 4 MiB files, which cost VAT's parser most of a second each. */
const FAST_SETTLED = new Set(SETTLED_FEATURES.filter((feature) => feature !== 'oversize'));

describe('vat claude context agrees with a reference port of the Claude Code loader (wide sweep)', () => {
  it('in memory, across 300 seeded random trees (seeds 9–308)', async () => {
    const failures = await loaderDifferentialFailures(loaderSweepSeeds(9, 300), FAST_SETTLED, inMemory);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
