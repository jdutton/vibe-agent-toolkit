/**
 * The always-loaded chain as two relations, and the claim that makes them worth
 * materialising: **the verb and the SQL cannot disagree.**
 *
 * ## The oracle
 *
 * `vat claude budget` publishes a per-chain token total. An adopter is told they
 * can reproduce it with `SUM(tokens) … WHERE budgetDisposition = 'charged'
 * GROUP BY chainId`. {@link expectSqlTwinAgreement} performs that arithmetic
 * over `claude_context_loads` — in JavaScript, since the rows are the same rows
 * SQLite would hold — and demands it equal `sweepAlwaysLoadedBudgets`' answer
 * for every chain.
 *
 * ⛔ That is not a tautology just because both now fold one row set. It is what
 * PINS the fold: the documented statement selects on a literal
 * (`'charged'`) and a column name, so a disposition renamed, a column dropped,
 * or a qualifying predicate widened breaks the oracle here rather than silently
 * making the published twin wrong for every adopter who copied it.
 *
 * ## What a fixture must contain to exercise the exclusions
 *
 * VAT's own corpus reaches none of them (see `claude-context-budget.ts`), so the
 * fixtures here carry a two-hop import and a path-scoped rule deliberately: the
 * first is the only way to reach `excluded-deep-import`, and the second the only
 * way to reach `excluded-rule` alongside a chain that also charges something.
 */

import { describe, expect, it } from 'vitest';

import { sweepAlwaysLoadedBudgets } from '../src/projection/claude-context-budget-sweep.js';
import { DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS } from '../src/projection/claude-context-budget.js';
import {
  claudeContextRelations,
  contextChainId,
  contextChains,
} from '../src/projection/claude-context-relations.js';
import type { Projection } from '../src/projection/projection.js';
import type { ClaudeContextLoadRow } from '../src/schemas/projection-claude-context.js';

import { claudeContextFixture } from './helpers/claude-context-fixture.js';

/** A threshold well above every fixture total, so nothing flags by accident. */
const ROOMY = 1_000_000;

/** The corpus root, as both a location and a representative. */
const ROOT = '';

/**
 * A tree with a root chain, a nested chain, an `@` import and a scoped rule.
 *
 * The import is what makes the `import` admission columns (`pattern`, `depth`)
 * reachable at all, and the scoped rule is what puts a non-charged row in the
 * relation beside the charged ones — without one, every assertion about the
 * total would pass over a relation where nothing was excluded.
 */
const TREE: Record<string, string> = {
  'CLAUDE.md': '# Root\n\nSome root instructions.\n\n@docs/handbook.md\n',
  'docs/handbook.md': '# Handbook\n\nA handbook with plenty of prose in it.\n',
  'packages/cli/CLAUDE.md': '# CLI\n\nInstructions that apply under packages/cli.\n',
  'packages/cli/src/index.md': '# Source\n\nAn ordinary file, so `src` is a working location.\n',
  '.claude/rules/scoped.md':
    '---\npaths:\n  - "packages/**"\n---\n\n# Scoped\n\nA path-scoped rule, on demand.\n',
  'README.md': '# Readme\n\nAn ordinary file at the root.\n',
};

/**
 * Sum the SQL twin the way `vat claude budget --help` tells an adopter to.
 *
 * Returned rather than asserted internally, so the caller asserts too — the
 * positive control on an assertion helper.
 *
 * @param loads - Every `claude_context_loads` row
 * @returns chainId → the charged token sum for that chain
 */
function chargedTokensByChain(
  loads: readonly ClaudeContextLoadRow[],
): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const row of loads) {
    if (row.budgetDisposition !== 'charged') continue;
    totals.set(row.chainId, (totals.get(row.chainId) ?? 0) + (row.tokens ?? 0));
  }
  return totals;
}

/**
 * `COUNT(*) … WHERE budgetDisposition = ? GROUP BY chainId`, in JavaScript.
 *
 * @param loads - Every `claude_context_loads` row
 * @param disposition - The disposition to count
 * @returns chainId → how many of its rows carry it
 */
function countByChain(
  loads: readonly ClaudeContextLoadRow[],
  disposition: string,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const row of loads) {
    if (row.budgetDisposition !== disposition) continue;
    counts.set(row.chainId, (counts.get(row.chainId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Demand the SQL twin reproduce EVERY number the verb publishes per chain.
 *
 * ⛔ Not the token total alone. A total-only oracle is satisfied by a relation
 * that marks every always-class row `charged`, because an unmeasured row
 * contributes zero to the sum either way — the mutation that was tried and
 * passed. The counters are what separate "excluded because it is not loaded at
 * launch" from "excluded because nothing measured it", and they are exactly the
 * fields {@link AlwaysLoadedBudget.lowerBound} is computed from.
 *
 * @param projection - The populated projection
 * @returns The per-chain charged sums it asserted on, so the caller can assert too
 */
function expectSqlTwinAgreement(projection: Projection): ReadonlyMap<string, number> {
  const sweep = sweepAlwaysLoadedBudgets(projection, ROOMY);
  const { claudeContextLoads } = claudeContextRelations(projection);
  const twin = chargedTokensByChain(claudeContextLoads);
  const unknown = countByChain(claudeContextLoads, 'unknown-size');
  const deepImports = countByChain(claudeContextLoads, 'excluded-deep-import');
  const unattributed = countByChain(claudeContextLoads, 'excluded-unattributed-import');
  const rules = countByChain(claudeContextLoads, 'excluded-rule');

  expect(sweep.locations.length).toBeGreaterThan(0);
  for (const location of sweep.locations) {
    const chainId = contextChainId(location.representative);
    const { budget } = location;
    expect(twin.get(chainId) ?? 0).toBe(budget.tokens);
    expect(unknown.get(chainId) ?? 0).toBe(budget.unknownTokenRows);
    expect(deepImports.get(chainId) ?? 0).toBe(budget.excludedDeepImportRows);
    expect(unattributed.get(chainId) ?? 0).toBe(budget.unattributedImportRows);
    expect(rules.get(chainId) ?? 0).toBe(budget.excludedRuleRows);
  }
  return twin;
}

describe('claudeContextRelations — the SQL twin of the always-loaded budget', () => {
  it('reproduces every chain total the budget verb publishes', async () => {
    const projection = await claudeContextFixture(TREE);
    const twin = expectSqlTwinAgreement(projection);
    // The positive control: a twin of all zeros would satisfy the loop above if
    // the verb also answered zero everywhere.
    expect([...twin.values()].some((tokens) => tokens > 0)).toBe(true);
  });

  it('reproduces them when part of the chain has no measurable size', async () => {
    // 🔑 The arm that separates "charged" from "counted". A deferred
    // realization has no blob, so its `tokens` are UNKNOWN — and an unmeasured
    // row contributes zero to a SUM whether it is marked charged or not, so the
    // token total alone cannot tell the two apart. `unknownTokenRows` can.
    const projection = await claudeContextFixture(TREE, { deferred: ['packages/cli/CLAUDE.md'] });
    expectSqlTwinAgreement(projection);

    const { claudeContextLoads } = claudeContextRelations(projection);
    const unmeasured = claudeContextLoads.filter((row) => row.budgetDisposition === 'unknown-size');
    expect(unmeasured.length).toBeGreaterThan(0);
    // ⛔ Null is UNKNOWN, never zero — the whole reason the column is nullable.
    for (const row of unmeasured) expect(row.tokens).toBeNull();
  });

  it('emits one chain row per working location and one load row per (chain, resource)', async () => {
    const projection = await claudeContextFixture(TREE);
    const { claudeContextChains, claudeContextLoads } = claudeContextRelations(projection);

    const locations = claudeContextChains.map((row) => row.directory);
    expect(new Set(locations).size).toBe(locations.length);
    expect(locations).toContain(ROOT);
    expect(locations).toContain('packages/cli/src');

    // ⛔ The key that makes SUM(tokens) honest. A resource admitted two ways
    // must be ONE row.
    const keys = claudeContextLoads.map((row) => `${row.chainId} ${row.resourceId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('maps every location to a chain whose representative is itself a location', async () => {
    const projection = await claudeContextFixture(TREE);
    const { claudeContextChains } = claudeContextRelations(projection);
    const locations = new Set(claudeContextChains.map((row) => row.directory));

    for (const row of claudeContextChains) {
      expect(row.chainId).toBe(contextChainId(row.representative));
      // The representative is a working location too — which is what makes
      // `claude_context_chains` self-joinable without a second relation.
      expect(locations.has(row.representative)).toBe(true);
    }
  });

  it('carries an `@` import with the hop depth the budget is calibrated against', async () => {
    const projection = await claudeContextFixture(TREE);
    const { claudeContextLoads } = claudeContextRelations(projection);
    const imported = claudeContextLoads.filter((row) => row.path === 'docs/handbook.md');

    expect(imported.length).toBeGreaterThan(0);
    for (const row of imported) {
      expect(row.admissionKind).toBe('import');
      // 🔑 `pattern` is the closure ROOT for an import admission, and `depth`
      // the hop count — the two facts the calibrated `<= 1` predicate rests on.
      // Without them in the relation an adopter could not reproduce the
      // exclusion, only the inclusion.
      expect(row.pattern).toBe('CLAUDE.md');
      expect(row.depth).toBe(1);
      expect(row.budgetDisposition).toBe('charged');
    }
  });

  it('keeps an on-demand row IN the relation and OUT of the total', async () => {
    const projection = await claudeContextFixture(TREE);
    const { claudeContextLoads } = claudeContextRelations(projection);
    const scoped = claudeContextLoads.filter((row) => row.path === '.claude/rules/scoped.md');

    expect(scoped.length).toBeGreaterThan(0);
    for (const row of scoped) {
      // A row that costs nothing at launch is still part of the answer —
      // dropping it would leave a reader unable to tell "not loaded at launch"
      // from "never seen".
      expect(row.loadClass).toBe('on-demand');
      expect(row.budgetDisposition).toBe('not-always');
      expect(row.admissionKind).toContain('rule');
      expect(row.tokens).not.toBeNull();
    }

    // The positive control on that exclusion: the rule DOES carry tokens, so a
    // total that accidentally included it would differ from the verb's.
    const everything = claudeContextLoads.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
    const charged = [...chargedTokensByChain(claudeContextLoads).values()]
      .reduce((sum, tokens) => sum + tokens, 0);
    expect(everything).toBeGreaterThan(charged);
  });

  it('carries the deciding admission, not merely the first one listed', async () => {
    const projection = await claudeContextFixture(TREE);
    const { claudeContextLoads } = claudeContextRelations(projection);

    for (const row of claudeContextLoads) {
      if (row.budgetDisposition !== 'charged') continue;
      // A charged row must name the kind that charged it. The alternative — the
      // first admission whatever it is — would routinely print `glob-rule`
      // beside `charged`, which no reader could make sense of.
      expect(['ancestry', 'root-rule', 'import']).toContain(row.admissionKind);
      expect(row.admissionCount).toBeGreaterThan(0);
    }
  });

  it('omits a chain whose representative the projection never realized, from BOTH relations', async () => {
    const populated = await claudeContextFixture(TREE);
    // `packages/cli` stays a working LOCATION — its files are still realized —
    // but nothing realizes the directory itself, so `whatLoadsAt` answers
    // `unknown` for it. The same shape the sweep counts as
    // `skippedUnknownLocations`.
    const projection: Projection = {
      ...populated,
      resourceRealizations: populated.resourceRealizations.filter(
        (row) => !(row.isDirectory && row.path === 'packages/cli'),
      ),
    };

    // ⛔ `null`, not `[]`: "VAT never looked" is not "this chain loads nothing".
    expect(contextChains(projection).filter((chain) => chain.loads === null)).toHaveLength(1);

    const { claudeContextChains, claudeContextLoads } = claudeContextRelations(projection);
    const unknownChain = contextChainId('packages/cli');
    expect(claudeContextChains.some((row) => row.chainId === unknownChain)).toBe(false);
    expect(claudeContextLoads.some((row) => row.chainId === unknownChain)).toBe(false);
    // The positive control: the rest of the tree is still reported, so the two
    // assertions above are about this chain and not about an empty result.
    expect(claudeContextChains.some((row) => row.representative === ROOT)).toBe(true);
    expect(claudeContextLoads.length).toBeGreaterThan(0);
  });

  it('issues one query per CHAIN, not one per working location', async () => {
    const projection = await claudeContextFixture(TREE);
    const sweep = sweepAlwaysLoadedBudgets(projection, DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS);
    // The collapse, made observable: more locations than chains, and the query
    // counter follows the chains.
    expect(sweep.queriedDirectories).toBe(contextChains(projection).length);
    expect(sweep.evaluatedDirectories).toBeGreaterThan(sweep.queriedDirectories);
  });
});
