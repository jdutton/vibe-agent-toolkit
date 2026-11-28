/**
 * The resolved import graph agrees with the compiler, both ways, over this repository's own tree
 * after `bun run build` (CI's clean
 * checkout plus its build is the built clone). The fixture corpus subject, its floor
 * over every compared kind and the positive controls are in
 * `ts-resolve-compiler-differential.integration.test.ts`; this file is split out by the integration
 * tier's per-file budget.
 *
 * The relation is the built `vat resources query` over the checkout, in the checkout's own cache.
 * The oracle reads the outputs on disk as the build (`inMemoryBuild: false`): every member a
 * demanded program reaches is built before this suite by turbo's `@vibe-agent-toolkit/cli#build`
 * edge on `dev-tools#test:integration`, whose `^build` closure holds every such member.
 *
 * Integration tier: it runs the built `vat` and the vendored compiler over the whole repository.
 */

import { atLeastTierTimeout } from '@vibe-agent-toolkit/utils/testing';
import { beforeAll, describe, expect, inject, it } from 'vitest';

import { REPO_ROOT, repositoryCacheDir } from '../check-port-differential.js';
import { compareWithOracle, loadOracleTypeScript, oracleOf, relationOf, type Comparison } from '../ts-resolve-oracle.js';

describe('the resolved import graph agrees with the compiler: this repository', () => {
  const subject: { comparison?: Comparison; memberUndeclaredRows?: number } = {};
  const comparison = (): Comparison => {
    if (subject.comparison === undefined) throw new Error('the suite did not set up');
    return subject.comparison;
  };

  beforeAll(async () => {
    const typescript = await loadOracleTypeScript();
    const relation = relationOf(REPO_ROOT, repositoryCacheDir());
    const oracle = oracleOf(typescript, { root: REPO_ROOT, inMemoryBuild: false }, relation.configs);
    subject.comparison = compareWithOracle(oracle, relation, REPO_ROOT);
    subject.memberUndeclaredRows = relation.targets.filter((row) => row.targetKind === 'memberUndeclared').length;
  }, atLeastTierTimeout(inject('tierTestTimeout'), 300_000));

  it('agrees both ways: references and program files', () => {
    const { onlyOracle, onlyRelation, disagree, programOnlyOracle, programOnlyRelation } = comparison();

    expect({ onlyOracle, onlyRelation, disagree, programOnlyOracle, programOnlyRelation }).toStrictEqual({
      onlyOracle: [], onlyRelation: [], disagree: [], programOnlyOracle: [], programOnlyRelation: [],
    });
    expect(comparison().compared).toBeGreaterThan(0);
  });

  it('compares the kinds this repository is written in (the full floor holds over the corpus)', () => {
    expect(comparison().kinds).toStrictEqual(expect.arrayContaining(['dynamic', 'export', 'import']));
  });

  it('counts each exclusion by name, and every undeclared member resolution lands in the member the row names', () => {
    const { excluded } = comparison();

    expect(excluded.implicit).toBe(0);
    expect(excluded.referenceLib.oracle).toBe(excluded.referenceLib.relation);
    // Every package config names `types`, so each program has automatic type directives.
    expect(excluded.automaticTypeDirectives).toBeGreaterThan(0);
    // bun links every member at the root `node_modules`: each `memberUndeclared` row the oracle
    // resolves is set aside, and only after `compareWithOracle` saw it land in the named member.
    expect(excluded.memberUndeclared).toBeLessThanOrEqual(subject.memberUndeclaredRows ?? 0);
    // `dev-tools` references `resources` and imports its sources: tsc reads their `.d.ts` outputs,
    // which reach `resources`' committed vendored typings, a file the relation never walks to.
    expect(excluded.pastReferenceOutput).toBeGreaterThan(0);
  });
});
