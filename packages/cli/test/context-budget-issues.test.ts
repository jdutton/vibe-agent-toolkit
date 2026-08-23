/**
 * The always-loaded context budget, as findings.
 *
 * The property under test that is NOT obvious from the signature: one issue per
 * over-budget REPRESENTATIVE, never one per working location. On VAT's own tree
 * 553 directories share the single chain `['CLAUDE.md']`, so per-location
 * emission would print 553 byte-identical findings the moment the root file
 * crossed the budget — and a check that emits 553 findings for one cause is a
 * check people silence rather than fix.
 */

import {
  type AlwaysLoadedBudget,
  type BudgetContributor,
  type BudgetSweep,
  type LocationBudget,
} from '@vibe-agent-toolkit/resources';
import { CODE_REGISTRY } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { contextBudgetIssues } from '../src/utils/context-budget-issues.js';

/** The threshold every fixture uses unless it says otherwise. */
const THRESHOLD = 12_000;

/** A representative that is not the corpus root, so `location` is carried. */
const NESTED = 'packages/cli';

/**
 * One representative's budget, and how many working locations borrow it.
 *
 * Every field but `representative` and `tokens` has a default, so a test states
 * only the thing it is about.
 */
interface BudgetSpec {
  readonly representative: string;
  readonly tokens: number;
  readonly threshold?: number;
  /** How many working locations pay this representative's chain. Default 1. */
  readonly locations?: number;
  readonly contributors?: readonly BudgetContributor[];
  readonly unknownTokenRows?: number;
  readonly excludedRuleRows?: number;
  readonly excludedDeepImportRows?: number;
  readonly unattributedImportRows?: number;
}

/**
 * Build one representative's `AlwaysLoadedBudget` exactly as
 * `alwaysLoadedBudget` would — `overBudget` and `lowerBound` are DERIVED here
 * rather than accepted from the spec, so no fixture can assert a combination the
 * real producer cannot make.
 *
 * @param spec - What this representative pays
 * @returns The budget
 */
function budgetOf(spec: BudgetSpec): AlwaysLoadedBudget {
  const threshold = spec.threshold ?? THRESHOLD;
  const unknownTokenRows = spec.unknownTokenRows ?? 0;
  const excludedDeepImportRows = spec.excludedDeepImportRows ?? 0;
  const unattributedImportRows = spec.unattributedImportRows ?? 0;
  return {
    directory: spec.representative,
    tokens: spec.tokens,
    threshold,
    overBudget: spec.tokens > threshold,
    contributors: spec.contributors ?? [{ path: chainFile(spec.representative), tokens: spec.tokens }],
    unknownTokenRows,
    excludedRuleRows: spec.excludedRuleRows ?? 0,
    excludedDeepImportRows,
    unattributedImportRows,
    lowerBound:
      unknownTokenRows > 0 || excludedDeepImportRows > 0 || unattributedImportRows > 0,
  };
}

/**
 * The `CLAUDE.md` a representative directory holds.
 *
 * @param directory - The representative, `''` for the corpus root
 * @returns Its root-relative chain file
 */
function chainFile(directory: string): string {
  return directory === '' ? 'CLAUDE.md' : `${directory}/CLAUDE.md`;
}

/**
 * A sweep whose locations appear in SPEC order rather than sorted order.
 *
 * Deliberate: `contextBudgetIssues` must impose its own code-point ordering on
 * the issues it emits, and a fixture that arrived pre-sorted could not tell a
 * real sort from a pass-through.
 *
 * @param specs - One entry per representative
 * @returns The sweep
 */
function sweepOf(specs: readonly BudgetSpec[]): BudgetSweep {
  const locations: LocationBudget[] = [];
  for (const spec of specs) {
    const budget = budgetOf(spec);
    const count = spec.locations ?? 1;
    for (let index = 0; index < count; index += 1) {
      locations.push({
        directory: index === 0 ? spec.representative : `${spec.representative}/sub${String(index)}`,
        representative: spec.representative,
        budget,
      });
    }
  }
  return {
    locations,
    queriedDirectories: specs.length,
    evaluatedDirectories: locations.length,
    skippedUnknownLocations: 0,
  };
}

/** The one message a single-issue fixture produced. */
function soleMessage(sweep: BudgetSweep): string {
  const issues = contextBudgetIssues(sweep);
  expect(issues).toHaveLength(1);
  return issues[0]?.message ?? '';
}

describe('contextBudgetIssues', () => {
  it('emits ONE issue per over-budget representative, however many locations share it', () => {
    const issues = contextBudgetIssues(
      sweepOf([{ representative: NESTED, tokens: 14_195, locations: 4 }]),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('ALWAYS_LOADED_CONTEXT_BUDGET');
    expect(issues[0]?.location).toBe(NESTED);
  });

  it('says how many working locations pay the over-budget chain', () => {
    expect(soleMessage(sweepOf([
      { representative: NESTED, tokens: 14_195, locations: 4 },
    ]))).toContain('4 working locations');
  });

  it('emits nothing for a representative inside its budget', () => {
    expect(contextBudgetIssues(
      sweepOf([{ representative: NESTED, tokens: 11_999, locations: 40 }]),
    )).toEqual([]);
  });

  it('emits nothing for a representative exactly ON its budget', () => {
    expect(contextBudgetIssues(
      sweepOf([{ representative: NESTED, tokens: THRESHOLD }]),
    )).toEqual([]);
  });

  it('orders issues by representative directory, code point ascending', () => {
    // Specs are supplied in DESCENDING order, so a pass-through would fail here.
    const issues = contextBudgetIssues(sweepOf([
      { representative: 'zeta', tokens: 20_000 },
      { representative: 'alpha', tokens: 30_000 },
      { representative: 'Alpha', tokens: 40_000 },
    ]));

    // 'A' (U+0041) precedes 'a' (U+0061) by code point — `localeCompare` would
    // put 'alpha' first on most locales, which is the divergence being pinned.
    expect(issues.map((issue) => issue.location)).toEqual(['Alpha', 'alpha', 'zeta']);
  });

  it('omits `location` ENTIRELY for the corpus root, which is not a relative path', () => {
    const issues = contextBudgetIssues(sweepOf([{ representative: '', tokens: 14_195 }]));

    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue).toBeDefined();
    // ⛔ `toEqual` cannot tell an absent key from an `undefined` one — ask the
    // object directly. `ValidationIssue.location` is a project-relative path and
    // `''` is not one, so the key must not be there at all.
    expect(Object.hasOwn(issue as object, 'location')).toBe(false);
  });

  it('names the corpus root in prose, since it has no `location` to carry it', () => {
    expect(soleMessage(sweepOf([{ representative: '', tokens: 14_195 }])))
      .toContain('the repository root');
  });

  it('states the total and the threshold with thousands separators', () => {
    const message = soleMessage(sweepOf([{ representative: 'docs', tokens: 14_195 }]));

    expect(message).toContain('14,195');
    expect(message).toContain('12,000');
  });

  it('lists the largest contributors with their token counts', () => {
    const message = soleMessage(sweepOf([{
      representative: 'docs',
      tokens: 14_195,
      contributors: [
        { path: 'CLAUDE.md', tokens: 8184 },
        { path: 'docs/CLAUDE.md', tokens: 6011 },
      ],
    }]));

    expect(message).toContain('CLAUDE.md (8,184 tokens)');
    expect(message).toContain('docs/CLAUDE.md (6,011 tokens)');
    expect(message).not.toContain('more');
  });

  it('caps the contributor list at three and counts the rest', () => {
    const message = soleMessage(sweepOf([{
      representative: 'docs',
      tokens: 15_000,
      contributors: [
        { path: 'a.md', tokens: 5000 },
        { path: 'b.md', tokens: 4000 },
        { path: 'c.md', tokens: 3000 },
        { path: 'd.md', tokens: 2000 },
        { path: 'e.md', tokens: 1000 },
      ],
    }]));

    expect(message).toContain('a.md (5,000 tokens)');
    expect(message).toContain('c.md (3,000 tokens)');
    expect(message).not.toContain('d.md');
    expect(message).toContain('+2 more');
  });

  it('appends the LOWER BOUND sentence with the three ignorance counts', () => {
    const message = soleMessage(sweepOf([{
      representative: 'docs',
      tokens: 14_195,
      unknownTokenRows: 3,
      excludedDeepImportRows: 2,
      unattributedImportRows: 1,
    }]));

    expect(message).toContain('lower bound');
    expect(message).toMatch(/3 .*unknown size/);
    expect(message).toMatch(/2 .*one hop/);
    expect(message).toMatch(/1 .*unattributed/);
  });

  it('does NOT call the total a lower bound when nothing was excluded by ignorance', () => {
    // `excludedRuleRows` is an exclusion BY DESIGN — rules files are `selected`,
    // not `always` — so it never sets `lowerBound` and must not add the sentence.
    const message = soleMessage(sweepOf([{
      representative: 'docs',
      tokens: 14_195,
      excludedRuleRows: 7,
    }]));

    expect(message).not.toContain('lower bound');
  });

  it('never claims to report the total cost, which this tree-only projection cannot know', () => {
    const message = soleMessage(sweepOf([{ representative: 'docs', tokens: 14_195 }]));

    expect(message).not.toContain('total cost');
  });

  it('takes severity, fix and reference from the registry rather than restating them', () => {
    const issues = contextBudgetIssues(sweepOf([{ representative: 'docs', tokens: 14_195 }]));
    const entry = CODE_REGISTRY.ALWAYS_LOADED_CONTEXT_BUDGET;

    expect(entry.defaultSeverity).toBe('info');
    expect(issues[0]?.severity).toBe(entry.defaultSeverity);
    expect(issues[0]?.fix).toBe(entry.fix);
    expect(issues[0]?.reference).toBe(entry.reference);
  });

  it('emits nothing at all for an empty sweep', () => {
    expect(contextBudgetIssues({
      locations: [],
      queriedDirectories: 0,
      evaluatedDirectories: 0,
      skippedUnknownLocations: 0,
    })).toEqual([]);
  });
});
