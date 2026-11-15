/**
 * Randomized DIFFERENTIAL test of `claude-context-rules.ts` against a
 * brute-force `node-ignore` reference — the small, unit-budget sweep.
 *
 * The engine, the reference and the generator live in
 * `helpers/rules-differential.ts`, whose header says what is compared and why.
 * This sweeps seeds 1–45; the integration tier continues from 46 for 1,000
 * more, so the two tiers together sweep one contiguous prefix.
 * Re-run one failing seed with `RULES_DIFFERENTIAL_SEED=<n>`.
 */

import { describe, expect, it } from 'vitest';

import {
  differentialFailures,
  directoryVerdict,
  namingVerdict,
  referenceOf,
  sweepSeeds,
  territoryVerdict,
  treeOf,
  type DifferentialCase,
} from './helpers/rules-differential.js';

/** Seeds 1–45: the smoke range, inside the unit per-file budget under coverage; the integration tier is the sweep. */
const UNIT_SEEDS = sweepSeeds(1, 45);

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
    const loaded: DifferentialCase = { seed: 0, rulePath: ROOT_RULE, paths: ['*.ts'], files: ['a.ts'], gitignores: [] };
    expect(directoryVerdict(loaded, referenceOf(loaded), '', ['a.ts'], undefined))
      .toBe('absent, reference loads a.ts');
  });

  it('keeps the reference honest on the two node-ignore corners it found', () => {
    // A bare `!` (the stripped `!/**`) negates everything, and a nested rule
    // never matches its own project directory.
    const bareNegation: DifferentialCase = { seed: 0, rulePath: ROOT_RULE, paths: ['/a', '!/**'], files: ['a'], gitignores: [] };
    expect(referenceOf(bareNegation).loads('a')).toBe(false);
    const nested: DifferentialCase = { seed: 0, rulePath: 'pkg/.claude/rules/r.md', paths: ['**/', '!**'], files: ['pkg/a.ts'], gitignores: [] };
    expect(referenceOf(nested).loads('pkg/a.ts')).toBe(false);
  });
});

describe('the gitignore and naming halves of the reference can fail', () => {
  it('reds a false inert: an ignored file the pattern would load', () => {
    const built: DifferentialCase = { seed: 0, rulePath: ROOT_RULE, paths: ['dist/**'], files: ['src/a.ts', 'dist/x.js'], gitignores: [{ dir: '', lines: ['dist/'] }] };
    expect(territoryVerdict(built, referenceOf(built), treeOf(built), 0, 'inert'))
      .toBe('inert, reference loads gitignored dist/x.js');
    // ...and allows `gitignored` for the same case.
    expect(territoryVerdict(built, referenceOf(built), treeOf(built), 0, 'gitignored')).toBeUndefined();
  });

  it('allows inert only for the documented blind spot: a match inside an ignored directory the glob does not name', () => {
    const blind: DifferentialCase = { seed: 0, rulePath: ROOT_RULE, paths: ['docs'], files: ['a.md', 'sub/x/docs/a.md'], gitignores: [{ dir: '', lines: ['/sub'] }] };
    expect(treeOf(blind).entries).toEqual(['sub/']);
    expect(territoryVerdict(blind, referenceOf(blind), treeOf(blind), 0, 'inert')).toBeUndefined();
  });

  it('reds a gitignored verdict when nothing ignored could match the pattern', () => {
    const clean: DifferentialCase = { seed: 0, rulePath: ROOT_RULE, paths: ['/docs/**'], files: ['a.md'], gitignores: [{ dir: '', lines: ['/dist/'] }] };
    expect(territoryVerdict(clean, referenceOf(clean), treeOf(clean), 0, 'gitignored'))
      .toBe('gitignored, but no path git ignores could match it');
  });

  it('reds a name a later negation cancels', () => {
    const cancelled: DifferentialCase = { seed: 0, rulePath: ROOT_RULE, paths: ['src', 'gen.ts', '!gen.ts'], files: ['src/gen.ts'], gitignores: [] };
    expect(namingVerdict(cancelled, referenceOf(cancelled), 'gen.ts', 'src/gen.ts'))
      .toBe('names "gen.ts" at src/gen.ts, last loader ["src"]');
    expect(namingVerdict(cancelled, referenceOf(cancelled), 'src', 'src/gen.ts')).toBeUndefined();
  });

  it('keeps the tree honest: a wholly-ignored directory collapses, and an ignored ancestor carries its subtree', () => {
    const tree = treeOf({
      seed: 0, rulePath: ROOT_RULE, paths: ['x'],
      files: ['dist/keep.md', 'dist/a/b.ts', 'src/x.js', 'src/y.ts'],
      gitignores: [{ dir: '', lines: ['dist', '!dist/keep.md', '*.js'] }],
    });
    // `dist` is ignored, so `!dist/keep.md` cannot re-include beneath it.
    expect(tree.hidden).toEqual(['dist/keep.md', 'dist/a/b.ts', 'src/x.js']);
    expect(tree.entries).toEqual(['dist/', 'src/x.js']);
    expect(tree.isIgnored('dist')).toBe(true);
    expect(tree.isIgnored('src')).toBe(false);
    // An absent path is answered by pattern.
    expect(tree.isIgnored('build/z.js')).toBe(true);
  });
});
