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

import { contextBudgetIssues, scopeSweepToPaths } from '../src/utils/context-budget-issues.js';

/** The threshold every fixture uses unless it says otherwise. */
const THRESHOLD = 12_000;

/** A representative that is not the corpus root, so `location` is carried. */
const NESTED = 'packages/cli';

/** A working location beneath {@link NESTED}. */
const NESTED_CHILD = `${NESTED}/src`;

/** A SIBLING of {@link NESTED} whose name merely starts with it — the segment-boundary trap. */
const NESTED_SIBLING = `${NESTED}-x`;

/** A path no fixture realizes. */
const UNREALIZED = 'no/such/dir';

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
  /**
   * The exact working locations paying this chain, overriding {@link locations}.
   *
   * Needed by the scoping tests and by nothing else: the generated names are all
   * DESCENDANTS of the representative, so a fixture built from them cannot show
   * a payer that sits outside the scope being asked about — which is the very
   * case `scopeSweepToPaths` retains.
   */
  readonly locationDirs?: readonly string[];
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
    for (const directory of payingDirectories(spec)) {
      locations.push({ directory, representative: spec.representative, budget });
    }
  }
  return {
    locations,
    queriedDirectories: specs.length,
    evaluatedDirectories: locations.length,
    skippedUnknownLocations: 0,
  };
}

/**
 * The working locations one spec's chain is paid by.
 *
 * @param spec - The representative's spec
 * @returns Its payers, the representative itself first
 */
function payingDirectories(spec: BudgetSpec): readonly string[] {
  if (spec.locationDirs !== undefined) return spec.locationDirs;
  const dirs = [spec.representative];
  for (let index = 1; index < (spec.locations ?? 1); index += 1) {
    dirs.push(`${spec.representative}/sub${String(index)}`);
  }
  return dirs;
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

describe('scopeSweepToPaths', () => {
  /**
   * A tree where the root chain is paid from three places — one of them a
   * SIBLING whose name merely starts with the other scope's name — plus a
   * second chain that sibling does NOT pay.
   */
  const TREE = sweepOf([
    { representative: '', tokens: 14_195, locationDirs: ['', 'src', NESTED_SIBLING] },
    { representative: NESTED, tokens: 20_000, locationDirs: [NESTED, NESTED_CHILD] },
  ]);

  it('selects every chain when the scope is the corpus root', () => {
    const { sweep, unmatchedScope } = scopeSweepToPaths(TREE, ['']);

    expect(sweep.locations).toEqual(TREE.locations);
    expect(unmatchedScope).toEqual([]);
  });

  it('selects nothing at all for an empty scope', () => {
    // `['']` is "the whole tree"; `[]` is "you named nothing". The two must not
    // collapse into each other — a caller that passed an empty list by mistake
    // would otherwise silently sweep everything.
    expect(scopeSweepToPaths(TREE, []).sweep.locations).toEqual([]);
  });

  it('RETAINS every payer of a selected chain, including payers outside the scope', () => {
    const { sweep } = scopeSweepToPaths(TREE, ['src']);

    // `src` pays the root chain, so the root chain is selected — and all THREE
    // of its payers come back, not just `src`. The finding's message says how
    // many working locations pay it, and that is a fact about the TREE: keeping
    // only the in-scope payer would report "1 working location pays it" for a
    // chain three pay, which is a number nobody measured.
    expect(sweep.locations.map((location) => location.directory))
      .toEqual(['', 'src', NESTED_SIBLING]);
    expect(contextBudgetIssues(sweep)[0]?.message).toContain('3 working locations pay it');
  });

  it('matches on SEGMENT boundaries, so a name-prefix sibling is not swept in', () => {
    const { sweep, unmatchedScope } = scopeSweepToPaths(TREE, [NESTED]);

    // `packages/cli-x` starts with `packages/cli` and pays a DIFFERENT chain. A
    // bare `startsWith` would select the root chain too, reporting two findings
    // where the caller asked about one directory.
    expect(new Set(sweep.locations.map((location) => location.representative)))
      .toEqual(new Set([NESTED]));
    expect(unmatchedScope).toEqual([]);
  });

  it('includes the scope directory itself, not only what is beneath it', () => {
    const { sweep } = scopeSweepToPaths(TREE, [NESTED_CHILD]);

    expect(sweep.locations.map((location) => location.directory))
      .toEqual([NESTED, NESTED_CHILD]);
  });

  it('names a scope that matched no working location rather than reporting it clean', () => {
    const { sweep, unmatchedScope } = scopeSweepToPaths(TREE, [UNREALIZED, 'src']);

    // The matched half still works; the unmatched half is REPORTED. Zero
    // findings for `no/such/dir` is byte-identical to "within budget", and only
    // this list distinguishes them.
    expect(unmatchedScope).toEqual([UNREALIZED]);
    expect(sweep.locations).not.toHaveLength(0);
  });

  it('carries the sweep counters through untouched, because a scope measures nothing', () => {
    const { sweep } = scopeSweepToPaths(TREE, [NESTED]);

    // They describe what was SWEPT. Recomputing them from the narrowed view
    // would let `vat claude budget packages/cli` claim the tree has one chain.
    expect(sweep.evaluatedDirectories).toBe(TREE.evaluatedDirectories);
    expect(sweep.queriedDirectories).toBe(TREE.queriedDirectories);
    expect(sweep.skippedUnknownLocations).toBe(TREE.skippedUnknownLocations);
  });
});
