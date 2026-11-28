/**
 * The resolved import graph agrees with the compiler, both ways, over the fixture corpus; the repository subject is its own file
 * (`ts-resolve-compiler-differential-repository.integration.test.ts`).
 *
 * The corpus is the I0 corpus of `ts_import_targets` (`packages/cli/test/helpers/ts-resolve-rows.ts` over the workspace of
 * `packages/resources/test/helpers/ts-resolve-corpus.ts`, imported, never copied), committed to a temp tree with the links an isolated install presents made
 * on disk from its hand-written list (real directory symlinks, junctions on Windows), plus one member
 * of this file's own, `@acme/kinds`, holding the reference kinds the corpus does not (`export`,
 * `importEquals`, `importType`, `require`, `jsdocImport`, `jsdocImportType`), so the floor holds
 * here. The relation is computed by the built `vat resources query` on that tree; the oracle builds
 * it in memory ({@link oracleOf}). Each positive control is the relation one defect would answer,
 * as a transformation of its rows, and each must turn the comparison red where the defect lives.
 *
 * Integration tier: it runs the built `vat` and the vendored compiler.
 */

import { canonicalPath, safePath } from '@vibe-agent-toolkit/utils';
import { atLeastTierTimeout } from '@vibe-agent-toolkit/utils/testing';
import type ts from 'typescript';
import { beforeAll, describe, expect, inject, it } from 'vitest';

import { TS_RESOLVE_FILES } from '../../../cli/test/helpers/ts-resolve-rows.js';
import { TS_RESOLVE_LINKS } from '../../../resources/test/helpers/ts-resolve-corpus.js';
import { portTempDirs } from '../check-port-differential.js';
import {
  COMPARED_KINDS, compareWithOracle, fileKey, loadOracleTypeScript, oracleOf, relationOf, writeInstallLinks,
  type Comparison, type OracleAnswer, type RelationAnswer, type RelationTarget,
} from '../ts-resolve-oracle.js';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The kinds the corpus lacks, in one member whose config a script invokes; `allowJs` so its `.js` file is in the program. */
const KINDS_FILES: Readonly<Record<string, string>> = {
  'packages/kinds/package.json': json({ name: '@acme/kinds', private: true, scripts: { build: 'tsc -p .' } }),
  'packages/kinds/tsconfig.json': json({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', noEmit: true, allowJs: true, checkJs: true }, include: ['src'] }),
  'packages/kinds/src/base.ts': 'export const base = 1;\nexport type Base = number;\n',
  'packages/kinds/src/reexport.ts': "export { base } from './base.js';\n",
  'packages/kinds/src/equals.ts': "import kinds = require('./base.js');\nexport const again = kinds.base;\n",
  'packages/kinds/src/types.ts': "export type Again = import('./base.js').Base;\n",
  'packages/kinds/src/legacy.js': [
    "const { base } = require('./base.js');",
    "/** @import { Base } from './base.js' */",
    "/** @type {import('./base.js').Base} */",
    'const value = base;',
    'module.exports = { value };',
    '',
  ].join('\n'),
};

const CORPUS: Readonly<Record<string, string>> = { ...TS_RESOLVE_FILES, ...KINDS_FILES };

/** An empty comparison, as an agreeing one reads. */
const AGREEING = { onlyOracle: [], onlyRelation: [], disagree: [], programOnlyOracle: [], programOnlyRelation: [] };

/** The comparison's five difference lists. */
function differences(comparison: Comparison): Pick<Comparison, keyof typeof AGREEING> {
  const { onlyOracle, onlyRelation, disagree, programOnlyOracle, programOnlyRelation } = comparison;
  return { onlyOracle, onlyRelation, disagree, programOnlyOracle, programOnlyRelation };
}

/** The relation with its target rows rewritten by `rewrite`. */
function withTargets(relation: RelationAnswer, rewrite: (row: RelationTarget) => RelationTarget): RelationAnswer {
  return { ...relation, targets: relation.targets.map((row) => rewrite(row)) };
}

/**
 * The options a column-subset engine would hand the resolver: only what the tsconfig relations carry
 * as columns, so `pathsBasePath` (which no column holds) is gone.
 */
const COLUMN_SUBSET: ReadonlySet<string> = new Set(['module', 'moduleResolution', 'baseUrl', 'paths', 'allowJs', 'resolveJsonModule']);

describe('the resolved import graph agrees with the compiler: the fixture corpus', () => {
  const dirs = portTempDirs('vat-ts-oracle-', CORPUS, {});
  const subject: { root: string; typescript?: typeof ts; relation?: RelationAnswer; oracle?: OracleAnswer } = { root: '' };
  const compare = (relation: RelationAnswer): Comparison => compareWithOracle(answer().oracle, relation, subject.root);
  const answer = (): { relation: RelationAnswer; oracle: OracleAnswer; typescript: typeof ts } => {
    const { relation, oracle, typescript } = subject;
    if (relation === undefined || oracle === undefined || typescript === undefined) throw new Error('the suite did not set up');
    return { relation, oracle, typescript };
  };

  beforeAll(async () => {
    writeInstallLinks(dirs.corpus, TS_RESOLVE_LINKS);
    subject.root = canonicalPath(dirs.corpus, dirs.corpus);
    subject.typescript = await loadOracleTypeScript();
    subject.relation = relationOf(dirs.corpus, dirs.cache);
    subject.oracle = oracleOf(subject.typescript, { root: subject.root, inMemoryBuild: true }, subject.relation.configs);
  }, atLeastTierTimeout(inject('tierTestTimeout'), 120_000));

  it('agrees both ways: every oracle reference has an equal relation row, every relation row an oracle reference, and the program files are equal', () => {
    const comparison = compare(answer().relation);

    expect(differences(comparison)).toStrictEqual(AGREEING);
    expect(comparison.compared).toBeGreaterThan(0);
  });

  it('holds every compared kind at least once in the oracle set, so the comparison cannot pass vacuously', () => {
    expect(compare(answer().relation).kinds).toStrictEqual([...COMPARED_KINDS].toSorted((left, right) => left.localeCompare(right)));
  });

  it('counts each exclusion by name', () => {
    expect(compare(answer().relation).excluded).toStrictEqual({
      // `tsconfig.amb.json` sets `jsx: react-jsx`: TypeScript synthesizes a `react/jsx-runtime` import
      // for each of its two non-declaration files, `x.ts` and `x.tsx`, JSX in them or not.
      implicit: 2,
      // TypeScript 6 defaults `types` to `[]`, so `refs`' `typeRoots` loads nothing automatically:
      // `types/env` enters its program through the `/// <reference types>` only.
      automaticTypeDirectives: 0,
      referenceLib: { oracle: 1, relation: 1 },
      // An isolated install links only what a manifest declares, so nothing undeclared resolves.
      memberUndeclared: 0,
      // No corpus config has `references`.
      pastReferenceOutput: 0,
    });
  });

  describe('positive controls: each is red where its defect lives', () => {
    it('the output map off: the member rows go unresolved while the oracle resolves them', () => {
      const off = withTargets(answer().relation, (row) => (row.redirected === 1 ? { ...row, targetKind: 'unresolved', target: null, redirected: 0 } : row));

      expect(compare(off).disagree.filter((line) => line.includes('relation unresolved null, oracle git'))).not.toStrictEqual([]);
    });

    it('the mode forced to the file\'s implied format: the dynamic import() in a CommonJS-format file loses import mode', () => {
      const { relation, oracle } = answer();
      const forced = withTargets(relation, (row) => (row.mode === null ? row : { ...row, mode: oracle.impliedFormat.get(fileKey(row.config, row.path)) ?? row.mode }));
      const comparison = compare(forced);

      // The file's implied format is CommonJS, so the forced engine asks every `@acme/lib` usage in
      // require mode: the oracle's import-mode resolution (the `import()`, and the `resolution-mode`
      // import type) has no relation row left.
      expect(comparison.onlyOracle.filter((line) => line.startsWith("packages/app/tsconfig.json packages/app/src/index.ts '@acme/lib' import "))).toHaveLength(1);
      expect(differences(comparison)).not.toStrictEqual(AGREEING);
    });

    it('the options as a column subset: the paths fixture loses pathsBasePath and goes unresolved', () => {
      const { relation, typescript } = answer();
      const subsetResolves = (row: RelationTarget): boolean => {
        const config = typescript.getParsedCommandLineOfConfigFile(safePath.join(subject.root, row.config), undefined, { ...typescript.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
        const options = Object.fromEntries(Object.entries(config?.options ?? {}).filter(([name]) => COLUMN_SUBSET.has(name))) as ts.CompilerOptions;
        return typescript.resolveModuleName(row.specifier, safePath.join(subject.root, row.path), options, typescript.sys).resolvedModule !== undefined;
      };
      const subset = withTargets(relation, (row) => (row.pathsMatched === 1 && !subsetResolves(row) ? { ...row, targetKind: 'unresolved', target: null, redirected: 0 } : row));

      expect(compare(subset).disagree.filter((line) => line.includes("'@shared/util'"))).toHaveLength(1);
    });

    it('an empty relation: the oracle direction fails', () => {
      const comparison = compare({ ...answer().relation, targets: [], programFiles: [], conditions: [] });

      expect(comparison.onlyOracle.length).toBeGreaterThan(0);
      expect(comparison.programOnlyOracle.length).toBeGreaterThan(0);
      expect(comparison.onlyRelation).toStrictEqual([]);
    });
  });
});

