/**
 * The always-loaded context budget: which rows the threshold is measured
 * against, and which are excluded and why.
 *
 * ## Why the rows are hand-built rather than fixtured
 *
 * `alwaysLoadedBudget` is a pure predicate over `AccountedRow[]`, so a projection
 * fixture would add a whole population run plus an `account()` pass to reach the
 * seven fields it actually reads. The point of the function is that it is
 * testable WITHOUT a builder; a fixture here would quietly retire that property.
 *
 * ## The case that separates this from a simpler implementation
 *
 * A row carrying BOTH a rule admission and an ancestry admission is counted —
 * one qualifying admission is enough. An implementation that asked "is this a
 * rules row?" first, or that used `every` where it needed `some`, passes every
 * other test in this file and fails that one.
 *
 * ## ⛔ These are the ONLY tests that will ever cover the exclusion branches
 *
 * Re-measured 2026-08-23 over this whole repo (819 directories): the budget
 * equals the shipped `totals.alwaysTokens` with ZERO divergence. VAT's own tree
 * has no rules-only `always` rows, no imports past one hop, and no unattributed
 * imports — so `excludedRuleRows`, `excludedDeepImportRows` and
 * `unattributedImportRows` are unreachable from any fixture derived from this
 * corpus, and from any system test that runs against it. Deleting or weakening
 * an exclusion case here does not lower coverage of a branch; it removes the
 * branch's only coverage entirely.
 */

import { describe, expect, it } from 'vitest';

import type { AccountedRow } from '../src/projection/claude-context-accounting.js';
import {
  DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS,
  alwaysLoadedBudget,
} from '../src/projection/claude-context-budget.js';
import type { Admission } from '../src/projection/claude-context-query.js';

/** The directory every fixture here queries. Echoed back, never interpreted. */
const DIR = 'packages/thing';

/** A threshold well above every fixture's total, so nothing is over budget by accident. */
const ROOMY = 1_000_000;

/** The closure root the import admissions below hang off. */
const ROOT = 'CLAUDE.md';

/** An import admission at a given depth. `depth: null` is the unattributed row. */
function imported(depth: number | null): Admission {
  return { kind: 'import', rootPath: ROOT, viaPath: ROOT, depth };
}

/** The ancestry admission every default row carries. */
const ANCESTRY: Admission = { kind: 'ancestry', dir: DIR };

/** A root-rule admission — the kind that can never qualify on its own. */
const RULE: Admission = { kind: 'root-rule' };

function makeRow(overrides: Partial<AccountedRow> & Pick<AccountedRow, 'path'>): AccountedRow {
  return {
    resourceId: `id:${overrides.path}`,
    tokens: 100,
    bytes: 400,
    loadClass: 'always',
    charge: 'charged',
    admissions: [ANCESTRY],
    ...overrides,
  };
}

/** The zero-exclusion shape, so a test can assert only what it is about. */
const NO_EXCLUSIONS = {
  unknownTokenRows: 0,
  excludedRuleRows: 0,
  excludedDeepImportRows: 0,
  unattributedImportRows: 0,
  lowerBound: false,
};

/**
 * Asserts that `rows` are invisible to the budget: no tokens, no contributor,
 * and — the part that is easy to lose — no exclusion counter incremented and no
 * lower-bound flag. "Adds nothing" and "counts nothing" are separate claims; a
 * row that were merely excluded would pass the first two and fail the third.
 */
function expectContributesNothing(rows: readonly AccountedRow[]): void {
  const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
  expect(budget.tokens).toBe(0);
  expect(budget.contributors).toEqual([]);
  expect(budget).toMatchObject(NO_EXCLUSIONS);
}

describe('alwaysLoadedBudget', () => {
  it('publishes 12,000 as the calibrated default, not 10,000', () => {
    expect(DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS).toBe(12_000);
  });

  it('echoes the directory and threshold it was given', () => {
    const budget = alwaysLoadedBudget(DIR, [], 4321);
    expect(budget.directory).toBe(DIR);
    expect(budget.threshold).toBe(4321);
    expect(budget.tokens).toBe(0);
    expect(budget.contributors).toEqual([]);
    expect(budget).toMatchObject(NO_EXCLUSIONS);
  });

  describe('qualifying admissions', () => {
    it('counts an ancestry-only row', () => {
      const budget = alwaysLoadedBudget(DIR, [makeRow({ path: 'CLAUDE.md' })], ROOMY);
      expect(budget.tokens).toBe(100);
      expect(budget.contributors).toEqual([{ path: 'CLAUDE.md', tokens: 100 }]);
      expect(budget).toMatchObject(NO_EXCLUSIONS);
    });

    it('counts a depth-0 import row — the declared root is itself depth 0', () => {
      const rows = [makeRow({ path: 'CLAUDE.md', admissions: [imported(0)] })];
      const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
      expect(budget.tokens).toBe(100);
      expect(budget).toMatchObject(NO_EXCLUSIONS);
    });

    it('counts a depth-1 import row — one hop is inside the calibration', () => {
      const rows = [makeRow({ path: 'handbook.md', admissions: [imported(1)] })];
      const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
      expect(budget.tokens).toBe(100);
      expect(budget).toMatchObject(NO_EXCLUSIONS);
    });

    it('counts a row carrying BOTH a rule admission and an ancestry admission', () => {
      const rows = [makeRow({ path: 'both.md', admissions: [RULE, ANCESTRY] })];
      const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
      expect(budget.tokens).toBe(100);
      expect(budget.contributors).toEqual([{ path: 'both.md', tokens: 100 }]);
      expect(budget).toMatchObject(NO_EXCLUSIONS);
    });

    it('counts a row whose only qualifying admission sits behind a deep one', () => {
      const rows = [makeRow({ path: 'mixed.md', admissions: [imported(4), imported(1)] })];
      const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
      expect(budget.tokens).toBe(100);
      expect(budget.excludedDeepImportRows).toBe(0);
    });
  });

  describe('excluded always-class rows', () => {
    it('excludes a depth-2 import row and counts it as a deep import', () => {
      const rows = [makeRow({ path: 'deep.md', admissions: [imported(2)] })];
      const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
      expect(budget.tokens).toBe(0);
      expect(budget.contributors).toEqual([]);
      expect(budget.excludedDeepImportRows).toBe(1);
      expect(budget.lowerBound).toBe(true);
    });

    it('excludes a `depth: null` import row and counts it as unattributed', () => {
      const rows = [makeRow({ path: 'orphan.md', admissions: [imported(null)] })];
      const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
      expect(budget.tokens).toBe(0);
      expect(budget.unattributedImportRows).toBe(1);
      expect(budget.excludedDeepImportRows).toBe(0);
      expect(budget.lowerBound).toBe(true);
    });

    it('prefers the unattributed bucket when a row carries both a null and a deep import', () => {
      const rows = [makeRow({ path: 'both-bad.md', admissions: [imported(3), imported(null)] })];
      const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
      expect(budget.unattributedImportRows).toBe(1);
      expect(budget.excludedDeepImportRows).toBe(0);
    });

    it('excludes a rules-only row WITHOUT making the total a lower bound', () => {
      const rows = [makeRow({ path: '.claude/rules/style.md', admissions: [RULE] })];
      const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
      expect(budget.tokens).toBe(0);
      expect(budget.contributors).toEqual([]);
      expect(budget.excludedRuleRows).toBe(1);
      expect(budget.lowerBound).toBe(false);
    });

    it('files an admission-less always row under the rules bucket', () => {
      const rows = [makeRow({ path: 'nothing.md', admissions: [] })];
      const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
      expect(budget.excludedRuleRows).toBe(1);
      expect(budget.lowerBound).toBe(false);
    });
  });

  describe('charge states', () => {
    it('adds nothing for `unknown-size` and marks the total a lower bound', () => {
      const rows = [
        makeRow({ path: 'a.md' }),
        makeRow({ path: 'b.md', charge: 'unknown-size', tokens: null }),
      ];
      const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
      expect(budget.tokens).toBe(100);
      expect(budget.contributors).toEqual([{ path: 'a.md', tokens: 100 }]);
      expect(budget.unknownTokenRows).toBe(1);
      expect(budget.lowerBound).toBe(true);
    });

    it('never coalesces a null token count to zero on a `charged` row', () => {
      const rows = [makeRow({ path: 'impossible.md', charge: 'charged', tokens: null })];
      const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
      expect(budget.tokens).toBe(0);
      expect(budget.contributors).toEqual([]);
      expect(budget.unknownTokenRows).toBe(1);
      expect(budget.lowerBound).toBe(true);
    });

    it('adds nothing and counts nothing for the two oversize states', () => {
      expectContributesNothing([
        makeRow({ path: 'huge.md', charge: 'oversize-skipped' }),
        makeRow({ path: 'behind-huge.md', charge: 'pruned-by-oversize' }),
      ]);
    });
  });

  it('ignores an on-demand row entirely, incrementing no counter', () => {
    expectContributesNothing([
      makeRow({ path: 'ondemand-rule.md', loadClass: 'on-demand', admissions: [RULE] }),
      makeRow({ path: 'ondemand-deep.md', loadClass: 'on-demand', admissions: [imported(9)] }),
      makeRow({
        path: 'ondemand-unknown.md',
        loadClass: 'on-demand',
        charge: 'unknown-size',
        tokens: null,
      }),
    ]);
  });

  describe('the threshold comparison', () => {
    it('is not over budget when the total EQUALS the threshold', () => {
      const budget = alwaysLoadedBudget(DIR, [makeRow({ path: 'a.md', tokens: 500 })], 500);
      expect(budget.tokens).toBe(500);
      expect(budget.overBudget).toBe(false);
    });

    it('is over budget one token past the threshold', () => {
      const budget = alwaysLoadedBudget(DIR, [makeRow({ path: 'a.md', tokens: 501 })], 500);
      expect(budget.overBudget).toBe(true);
    });
  });

  it('sorts contributors descending by tokens, ties ascending by path', () => {
    const rows = [
      makeRow({ path: 'b.md', tokens: 50 }),
      makeRow({ path: 'a.md', tokens: 50 }),
      makeRow({ path: 'z.md', tokens: 900 }),
      makeRow({ path: 'c.md', tokens: 300 }),
    ];
    const budget = alwaysLoadedBudget(DIR, rows, ROOMY);
    expect(budget.contributors).toEqual([
      { path: 'z.md', tokens: 900 },
      { path: 'c.md', tokens: 300 },
      { path: 'a.md', tokens: 50 },
      { path: 'b.md', tokens: 50 },
    ]);
    expect(budget.tokens).toBe(1300);
  });

  describe('threshold validation', () => {
    it.each([
      ['zero', 0],
      ['negative', -1],
      ['fractional', 12_000.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('throws a TypeError for a %s threshold', (_label, threshold) => {
      expect(() => alwaysLoadedBudget(DIR, [], threshold)).toThrow(TypeError);
    });

    it('names the received value in the message', () => {
      expect(() => alwaysLoadedBudget(DIR, [], 0)).toThrow(/\b0\b/);
    });
  });
});
