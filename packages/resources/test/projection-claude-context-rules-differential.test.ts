/**
 * Randomized DIFFERENTIAL test of `claude-context-rules.ts` against a
 * brute-force `node-ignore` reference — the small, unit-budget sweep.
 *
 * The engine, the reference and the generator live in
 * `helpers/rules-differential.ts`, whose header says what is compared and why.
 * This sweeps seeds 1–150; the integration tier sweeps a wider, disjoint range.
 * Re-run one failing seed with `RULES_DIFFERENTIAL_SEED=<n>`.
 */

import { describe, expect, it } from 'vitest';

import {
  differentialFailures,
  directoryVerdict,
  referenceOf,
  sweepSeeds,
  type DifferentialCase,
} from './helpers/rules-differential.js';

/** Seeds 1–150: ~0.4 s locally, inside the 1,000 ms unit per-file budget. */
const UNIT_SEEDS = sweepSeeds(1, 150);

/** A root rule's path, for the hand-built control cases. */
const ROOT_RULE = '.claude/rules/r.md';

describe('claude-context-rules agrees with a brute-force node-ignore reference', () => {
  it('on every derived answer, across seeded random trees and rules', () => {
    const failures = differentialFailures(UNIT_SEEDS);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('keeps the positive control: the comparison reds on an answer VAT would get wrong', () => {
    // A comparison that cannot fail proves nothing: an ABSENT directory
    // admission where the reference loads a file must be reported.
    const loaded: DifferentialCase = { seed: 0, rulePath: ROOT_RULE, paths: ['*.ts'], files: ['a.ts'] };
    expect(directoryVerdict(loaded, referenceOf(loaded), ['a.ts'], undefined))
      .toBe('absent, reference loads a.ts');
  });

  it('keeps the reference honest on the two node-ignore corners it found', () => {
    // A bare `!` (the stripped `!/**`) negates everything, and a nested rule
    // never matches its own project directory.
    const bareNegation: DifferentialCase = { seed: 0, rulePath: ROOT_RULE, paths: ['/a', '!/**'], files: ['a'] };
    expect(referenceOf(bareNegation).loads('a')).toBe(false);
    const nested: DifferentialCase = { seed: 0, rulePath: 'pkg/.claude/rules/r.md', paths: ['**/', '!**'], files: ['pkg/a.ts'] };
    expect(referenceOf(nested).loads('pkg/a.ts')).toBe(false);
  });
});
