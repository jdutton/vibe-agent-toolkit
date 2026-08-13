import { describe, expect, it } from 'vitest';

import { ContributorRegistry, extentDigest } from '../src/projection/contributor.js';
import type { ExtentContribution, ExtentContributor } from '../src/projection/contributor.js';

const GIT_KIND = 'git';
const RES_A = 'res-aaa';
const RES_B = 'res-bbb';
const CTX_ONE = 'ctx-1';
const GIT_TRACKED = 'git-tracked';

function emptyContribution(): ExtentContribution {
  return { contexts: [], resources: [], realizations: [], memberships: [], tags: [], conditions: [] };
}

function stubContributor(id: string, kind: string): ExtentContributor {
  return { id, kind, stratum: 'base', contribute: async () => emptyContribution() };
}

/**
 * One non-empty row per table, so "every table participates" is checkable.
 *
 * Rows are the minimum each table's digest needs to move, cast where the full
 * column list belongs to another test's fixture — this file asserts the digest
 * covers the table, not that the row validates.
 */
const NON_EMPTY_TABLES: ReadonlyArray<readonly [string, Partial<ExtentContribution>]> = [
  ['contexts', { contexts: [{ contextId: CTX_ONE, species: 'extent', kind: GIT_KIND, rootId: 'root-x', extentContextId: null, role: null }] }],
  ['resources', { resources: [{ resourceId: RES_A, kind: 'file', origin: GIT_KIND, observed: true, fromEnumeration: true, vatId: null }] }],
  ['realizations', { realizations: [{ resourceId: RES_A, extentId: CTX_ONE, path: 'a.md' }] as unknown as ExtentContribution['realizations'] }],
  ['memberships', { memberships: [{ resourceId: RES_A, extentId: CTX_ONE }] }],
  ['tags', { tags: [{ resourceId: RES_A, tag: 'skill', value: null, source: 'config' }] }],
  ['conditions', { conditions: [{ extentId: CTX_ONE, path: 'a.md', code: 'X', severity: 'info', message: '', resourceId: null }] }],
];

describe('extentDigest', () => {
  it('is stable for the same membership set', () => {
    const contribution = {
      ...emptyContribution(),
      memberships: [{ resourceId: RES_A, extentId: CTX_ONE }],
    };
    expect(extentDigest(contribution)).toBe(extentDigest(contribution));
  });

  it('ignores emission order — a contributor is not required to be ordered', () => {
    const forward = { ...emptyContribution(), memberships: [
      { resourceId: RES_A, extentId: CTX_ONE },
      { resourceId: RES_B, extentId: CTX_ONE },
    ] };
    const reversed = { ...emptyContribution(), memberships: [...forward.memberships].reverse() };
    expect(extentDigest(forward)).toBe(extentDigest(reversed));
  });

  it('ignores key order within a row — two code paths assembling one row agree', () => {
    // `JSON.stringify` alone preserves insertion order, so a row spread from a
    // template and a row built literally would otherwise digest differently.
    const forward = { ...emptyContribution(), memberships: [{ resourceId: RES_A, extentId: CTX_ONE }] };
    const reversed = { ...emptyContribution(), memberships: [{ extentId: CTX_ONE, resourceId: RES_A }] };
    expect(extentDigest(forward)).toBe(extentDigest(reversed));
  });

  it('moves when one member is added — this is the convergence oracle', () => {
    const before = { ...emptyContribution(), memberships: [{ resourceId: RES_A, extentId: CTX_ONE }] };
    const after = { ...emptyContribution(), memberships: [
      { resourceId: RES_A, extentId: CTX_ONE },
      { resourceId: RES_B, extentId: CTX_ONE },
    ] };
    expect(extentDigest(before)).not.toBe(extentDigest(after));
  });

  it('moves when a realization changes, not only when membership does', () => {
    // A fixpoint that watched memberships alone would call a run converged
    // while realizations were still being attached.
    const base = emptyContribution();
    const withRealization = {
      ...base,
      realizations: [{ resourceId: RES_A, extentId: CTX_ONE, path: 'a.md' }] as unknown as ExtentContribution['realizations'],
    };
    expect(extentDigest(base)).not.toBe(extentDigest(withRealization));
  });

  it.each(NON_EMPTY_TABLES)('moves when the %s table alone changes', (_table, delta) => {
    // Without this, a digest covering only memberships and realizations passes
    // every other case in this file — the four remaining tables are unwatched
    // and a run would converge while tags or conditions were still arriving.
    expect(extentDigest(emptyContribution())).not.toBe(extentDigest({ ...emptyContribution(), ...delta }));
  });

  it('is a bare lowercase hex digest — merge writes it straight to zone_provenance', () => {
    expect(extentDigest(emptyContribution())).toMatch(/^[\da-f]{64}$/u);
  });
});

describe('ContributorRegistry', () => {
  it('returns every contributor registered for a kind', () => {
    const registry = new ContributorRegistry();
    registry.register(stubContributor(GIT_TRACKED, GIT_KIND));
    registry.register(stubContributor('git-untracked', GIT_KIND));
    expect(registry.forKind(GIT_KIND)).toHaveLength(2);
  });

  it('THROWS for a kind with no registered contributor — never an empty extent', () => {
    // §7.5: an empty set is a confident wrong answer. This is the whole rule.
    const registry = new ContributorRegistry();
    expect(() => registry.forKind('marketplace')).toThrow(/marketplace/u);
  });

  it('refuses a duplicate contributor id, because provenance keys on it', () => {
    const registry = new ContributorRegistry();
    registry.register(stubContributor(GIT_TRACKED, GIT_KIND));
    expect(() => registry.register(stubContributor(GIT_TRACKED, GIT_KIND))).toThrow(/git-tracked/u);
  });

  it('partitions by stratum so the driver can run base once and closure to fixpoint', () => {
    const registry = new ContributorRegistry();
    registry.register(stubContributor(GIT_TRACKED, GIT_KIND));
    registry.register({ ...stubContributor('skill-closure', 'skill'), stratum: 'closure' });
    expect(registry.byStratum('base').map((c) => c.id)).toEqual([GIT_TRACKED]);
    expect(registry.byStratum('closure').map((c) => c.id)).toEqual(['skill-closure']);
  });
});
