/**
 * The repository arm of the compiler differential of the resolved import graph, both ways: over
 * this repository's git content, every reference of every demanded config's program, by kind and
 * count, and every program file, as the vendored compiler resolves them and as the built `vat
 * resources query` answers `ts_import_targets` and `ts_program_files`. The fixture corpus, the
 * kinds floor and the positive controls are `integration/ts-resolve-compiler-differential.integration.test.ts`.
 *
 * System tier, because its cost is the whole repository's: the query populates a fresh store of
 * this file's own (`vitest.setup.js` gives every test file its own `VAT_CACHE_DIR`, so it shares
 * none with `check-ports-repository.system.test.ts` and every run is cold), and the oracle builds
 * every demanded config's program. Its own file, so the oracle's programs
 * never share a fork with that file's lint. The oracle reads the outputs on disk as the build
 * (`inMemoryBuild: false`): every member a demanded program reaches is built before this suite by
 * turbo's `@vibe-agent-toolkit/cli#build` edge on `dev-tools#test:system`.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT, repositoryCacheDir } from '../check-port-differential.js';
import { compareWithOracle, loadOracleTypeScript, oracleOf, relationOf, type Comparison } from '../ts-resolve-oracle.js';

describe('the resolved import graph agrees with the compiler: this repository', () => {
  const subject: { comparison?: Comparison; memberUndeclaredRows?: number } = {};
  const comparison = (): Comparison => {
    if (subject.comparison === undefined) throw new Error('the suite did not set up');
    return subject.comparison;
  };

  beforeAll(async () => {
    const typescript = loadOracleTypeScript();
    const relation = await relationOf(REPO_ROOT, repositoryCacheDir());
    const oracle = oracleOf(typescript, { root: REPO_ROOT, inMemoryBuild: false }, relation.configs);
    subject.comparison = compareWithOracle(oracle, relation, REPO_ROOT);
    subject.memberUndeclaredRows = relation.targets.filter((row) => row.targetKind === 'memberUndeclared').length;
  });

  it('agrees both ways: references by kind and count, and program files', () => {
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
