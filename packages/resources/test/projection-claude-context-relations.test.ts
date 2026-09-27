/**
 * The instruction chain as two relations: their shape, their keys, and the
 * `launchCharge` column a launch-cost sum filters on.
 *
 * Whether the per-chain collapse agrees with a per-location query — and whether
 * the charged sum equals `vat claude context`'s `alwaysTokens` — is
 * `projection-claude-context-chains-oracle.test.ts`'s to hold.
 *
 * The fixture carries a path-scoped rule deliberately: it is what puts a
 * `not-always` row in the relation beside the charged ones, so an assertion
 * about the charged sum is about a relation where something was left out.
 */

import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../src/link-classify.js';
import { SIZE_CLIFF_STATES } from '../src/projection/claude-context-accounting.js';
import { LAUNCH_CHARGES } from '../src/projection/claude-context-launch-charge.js';
import {
  claudeContextRelations,
  contextChainId,
} from '../src/projection/claude-context-relations.js';
import { CLAUDE_CODE } from '../src/projection/harness/claude-code.js';
import type { Projection } from '../src/projection/projection.js';
import { ClaudeContextLoadRowSchema, type ClaudeContextLoadRow } from '../src/schemas/projection-claude-context.js';

import { claudeContextFixture } from './helpers/claude-context-fixture.js';

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
 * Sum the charged rows the way `vat resources query --help` tells an adopter to.
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
    if (row.launchCharge !== 'charged') continue;
    totals.set(row.chainId, (totals.get(row.chainId) ?? 0) + (row.tokens ?? 0));
  }
  return totals;
}

describe('claudeContextRelations', () => {
  it('charges something, and leaves unmeasured rows unknown rather than zero', async () => {
    const measured = chargedTokensByChain(claudeContextRelations(await claudeContextFixture(TREE)).claudeContextLoads);
    expect([...measured.values()].some((tokens) => tokens > 0)).toBe(true);

    // A deferred realization has no blob, so its `tokens` are UNKNOWN.
    const projection = await claudeContextFixture(TREE, { deferred: ['packages/cli/CLAUDE.md'] });
    const unmeasured = claudeContextRelations(projection).claudeContextLoads
      .filter((row) => row.launchCharge === 'unknown-size');
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
    const keys = claudeContextLoads.map((row) => JSON.stringify([row.chainId, row.resourceId]));
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

  it('publishes the once-per-launch preamble on the CHAIN, repeated per location like `representative`', async () => {
    const projection = await claudeContextFixture(TREE);
    const { claudeContextChains } = claudeContextRelations(projection);

    // The root's own CLAUDE.md is genuinely charged, so its chain's preamble
    // is non-zero and equals the one estimate every reader of this column
    // must reproduce by hand — `CLAUDE_CODE.launchPreamble`, estimated.
    const rootChain = claudeContextChains.filter((row) => row.chainId === contextChainId(ROOT));
    expect(rootChain.length).toBeGreaterThan(0);
    for (const row of rootChain) {
      expect(row.preambleTokens).toBe(estimateTokens(CLAUDE_CODE.launchPreamble));
    }

    // Repeated per location, not per chain — the same asymmetry `representative`
    // carries, stated in the schema's own docstring.
    const byChain = new Map<string, Set<number>>();
    for (const row of claudeContextChains) {
      const seen = byChain.get(row.chainId) ?? new Set<number>();
      seen.add(row.preambleTokens);
      byChain.set(row.chainId, seen);
    }
    for (const [chainId, values] of byChain) {
      expect(values.size, chainId).toBe(1);
    }
  });

  it('carries an `@` import with its closure root and hop depth', async () => {
    const projection = await claudeContextFixture(TREE);
    const { claudeContextLoads } = claudeContextRelations(projection);
    const imported = claudeContextLoads.filter((row) => row.path === 'docs/handbook.md');

    expect(imported.length).toBeGreaterThan(0);
    for (const row of imported) {
      expect(row.admissionKind).toBe('import');
      // 🔑 `pattern` is the closure ROOT for an import admission, and `depth`
      // the hop count — what an adopter needs to ask "how deep does my launch
      // cost go".
      expect(row.pattern).toBe('CLAUDE.md');
      expect(row.depth).toBe(1);
      expect(row.launchCharge).toBe('charged');
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
      expect(row.launchCharge).toBe('not-always');
      expect(row.admissionKind).toContain('rule');
      expect(row.tokens).not.toBeNull();
    }

    // The positive control on that exclusion: the rule DOES carry tokens, so a
    // total that accidentally included it would differ from the charged sum.
    const everything = claudeContextLoads.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
    const charged = [...chargedTokensByChain(claudeContextLoads).values()]
      .reduce((sum, tokens) => sum + tokens, 0);
    expect(everything).toBeGreaterThan(charged);
  });

  it('carries the deciding admission, not merely the first one listed', async () => {
    const projection = await claudeContextFixture(TREE);
    const { claudeContextLoads } = claudeContextRelations(projection);

    for (const row of claudeContextLoads) {
      if (row.launchCharge !== 'charged') continue;
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
    // `unknown` for it.
    const projection: Projection = {
      ...populated,
      resourceRealizations: populated.resourceRealizations.filter(
        (row) => !(row.isDirectory && row.path === 'packages/cli'),
      ),
    };

    const { claudeContextChains, claudeContextLoads } = claudeContextRelations(projection);
    const unknownChain = contextChainId('packages/cli');
    expect(claudeContextChains.some((row) => row.chainId === unknownChain)).toBe(false);
    expect(claudeContextLoads.some((row) => row.chainId === unknownChain)).toBe(false);
    // The positive control: the rest of the tree is still reported, so the two
    // assertions above are about this chain and not about an empty result.
    expect(claudeContextChains.some((row) => row.representative === ROOT)).toBe(true);
    expect(claudeContextLoads.length).toBeGreaterThan(0);
  });

});

describe('claude_context_loads vocabulary', () => {
  it('names the 4 MiB cliff verdict sizeCliff, and carries no column called charge', () => {
    // ⛔ `charge = 'charged'` was a no-op filter that read as the right one: every
    // row the cliff let through said `charged`, including every on-demand rule.
    // Measured on a 12,602-file tree it selected all 8,119,657 bytes, while the
    // correct launch-cost filter selected 5,251,056.
    const columns = Object.keys(ClaudeContextLoadRowSchema.shape);
    expect(columns).toContain('sizeCliff');
    expect(columns).not.toContain('charge');
  });

  it('shares no value between the cliff verdict and the launch charge', () => {
    // The class, not the instance: two columns on one row whose vocabularies
    // share a token are one `WHERE` away from a filter that means the other one.
    // `unknown-size` coincided too, and a comment said so instead of a test.
    const charges: readonly string[] = LAUNCH_CHARGES;
    expect(SIZE_CLIFF_STATES.filter((state) => charges.includes(state))).toEqual([]);
    // Non-vacuous: both lists are the real, populated vocabularies.
    expect(SIZE_CLIFF_STATES).toContain('oversize-skipped');
    expect(LAUNCH_CHARGES).toContain('charged');
  });

});
