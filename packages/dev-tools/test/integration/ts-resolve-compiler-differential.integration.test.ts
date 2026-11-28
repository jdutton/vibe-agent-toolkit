/**
 * The resolved import graph agrees with the compiler, both ways, over the fixture corpus; the repository subject lives in
 * `test/system/check-ports-repository.system.test.ts`.
 *
 * The corpus is the I0 corpus of `ts_import_targets` (`packages/cli/test/helpers/ts-resolve-rows.ts` over the workspace of
 * `packages/resources/test/helpers/ts-resolve-corpus.ts`, imported, never copied), committed to a temp tree with the links an isolated install presents made
 * on disk from its hand-written list (real directory symlinks, junctions on Windows), plus one member
 * of this file's own, `@acme/kinds`, holding the reference kinds the corpus does not (`export`,
 * `importEquals`, `importType`, `require`, `jsdocImport`, `jsdocImportType`), so the floor holds
 * here, and the program-membership members of {@link MEMBERSHIP_FILES}: the cases where TypeScript
 * resolves a file its program does not add, or adds a file the relation does not walk (each such
 * file is a named, counted exclusion of the oracle). The relation is computed by the built `vat resources query` on that tree; the oracle builds
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

/** A NodeNext `noEmit` config over `src`, with `extra` options. */
const noEmitConfig = (extra: Readonly<Record<string, unknown>> = {}): string => json({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', noEmit: true, ...extra }, include: ['src'] });

/** A member manifest whose `build` script compiles its own `tsconfig.json`. */
const builtMember = (name: string, fields: Readonly<Record<string, unknown>> = {}): string => json({ name, private: true, type: 'module', ...fields, scripts: { build: 'tsc -p .' } });

/**
 * Program membership, each case one member:
 * - `@acme/nojs`: a `.js` target without `allowJs`, which tsc resolves and does not add (nor what it imports);
 * - `@acme/nojsx`: a `.tsx` target without a `jsx` setting, likewise;
 * - `@acme/relout-app`: a relative import and a `paths` alias into the emitting `@acme/relout-lib`'s
 *   output directory, which the output map redirects to its source, a leaf (tsc reads the output);
 * - `@acme/typed`: a `types`-option entry whose index imports a helper and references another
 *   file: three files tsc holds only through the `types` option (`typesOnly`);
 * - `@acme/srcapp` over `@acme/srclib`, a source-only member no script compiles: two files tsc
 *   holds through the member link and the relation has in no program (`throughMember`).
 */
const MEMBERSHIP_FILES: Readonly<Record<string, string>> = {
  'packages/nojs/package.json': builtMember('@acme/nojs'),
  'packages/nojs/tsconfig.json': noEmitConfig(),
  'packages/nojs/src/index.ts': "export { a } from './legacy.js';\n",
  'packages/nojs/src/legacy.js': "export { c as a } from './deep.js';\n",
  'packages/nojs/src/deep.ts': 'export const c = 1;\n',
  'packages/nojsx/package.json': builtMember('@acme/nojsx'),
  'packages/nojsx/tsconfig.json': json({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', noEmit: true }, files: ['src/index.ts'] }),
  'packages/nojsx/src/index.ts': "export { v } from './view.js';\n",
  'packages/nojsx/src/view.tsx': "export { w as v } from './w.js';\n",
  'packages/nojsx/src/w.ts': 'export const w = 1;\n',
  'packages/relout-lib/package.json': builtMember('@acme/relout-lib'),
  'packages/relout-lib/tsconfig.json': json({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', outDir: 'dist', rootDir: 'src', declaration: true }, include: ['src'] }),
  'packages/relout-lib/src/index.ts': "export { h as x } from './helper.js';\n",
  'packages/relout-lib/src/helper.ts': 'export const h = 1;\n',
  'packages/relout-app/package.json': builtMember('@acme/relout-app'),
  'packages/relout-app/tsconfig.json': noEmitConfig({ paths: { '@relout/*': ['../relout-lib/dist/*'] } }),
  'packages/relout-app/src/main.ts': "import { x } from '../../relout-lib/dist/index.js';\nimport { x as aliased } from '@relout/index.js';\nexport const y = [x, aliased];\n",
  'packages/typed/package.json': builtMember('@acme/typed'),
  'packages/typed/tsconfig.json': noEmitConfig({ typeRoots: ['./typings'], types: ['env'] }),
  'packages/typed/src/index.ts': 'export const x: Env = 1;\n',
  'packages/typed/typings/env/index.d.ts': "/// <reference path=\"./more.d.ts\" />\ndeclare type Env = import('./helper.js').H;\n",
  'packages/typed/typings/env/helper.d.ts': 'export type H = number;\n',
  'packages/typed/typings/env/more.d.ts': 'declare const more: 1;\n',
  'packages/srclib/package.json': json({ name: '@acme/srclib', private: true, type: 'module', exports: { '.': './src/index.ts' } }),
  'packages/srclib/tsconfig.json': noEmitConfig(),
  'packages/srclib/src/index.ts': "export { h as x } from './h.js';\n",
  'packages/srclib/src/h.ts': 'export const h = 1;\n',
  'packages/srcapp/package.json': builtMember('@acme/srcapp', { dependencies: { '@acme/srclib': 'workspace:*' } }),
  'packages/srcapp/tsconfig.json': noEmitConfig(),
  'packages/srcapp/src/main.ts': "import { x } from '@acme/srclib';\nexport const y = x;\n",
};

/** The membership members' install link: `@acme/srcapp` declares `@acme/srclib`. */
const MEMBERSHIP_LINKS: Readonly<Record<string, string>> = { 'packages/srcapp/node_modules/@acme/srclib': 'packages/srclib' };

const CORPUS: Readonly<Record<string, string>> = { ...TS_RESOLVE_FILES, ...KINDS_FILES, ...MEMBERSHIP_FILES };

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
    writeInstallLinks(dirs.corpus, { ...TS_RESOLVE_LINKS, ...MEMBERSHIP_LINKS });
    subject.root = canonicalPath(dirs.corpus, dirs.corpus);
    subject.typescript = await loadOracleTypeScript();
    subject.relation = await relationOf(dirs.corpus, dirs.cache);
    subject.oracle = oracleOf(subject.typescript, { root: subject.root, inMemoryBuild: true }, subject.relation.configs);
  }, atLeastTierTimeout(inject('tierTestTimeout'), 120_000));

  it('agrees both ways: every oracle reference has an equal relation row, every relation row an oracle reference, and the program files are equal', () => {
    const comparison = compare(answer().relation);

    expect(differences(comparison)).toStrictEqual(AGREEING);
    expect(comparison.compared).toBeGreaterThan(0);
  });

  it('matches every compared kind at least once to an agreeing relation row, so the comparison cannot pass vacuously', () => {
    expect(compare(answer().relation).kinds).toStrictEqual([...COMPARED_KINDS].toSorted((left, right) => left.localeCompare(right)));
  });

  it('counts each exclusion by name', () => {
    expect(compare(answer().relation).excluded).toStrictEqual({
      // `tsconfig.amb.json` sets `jsx: react-jsx`: TypeScript synthesizes a `react/jsx-runtime` import
      // for each of its two non-declaration files, `x.ts` and `x.tsx`, JSX in them or not.
      implicit: 2,
      // TypeScript 6 defaults `types` to `[]`, so `refs`' `typeRoots` loads nothing automatically:
      // `types/env` enters its program through the `/// <reference types>` only. `typed` names one.
      automaticTypeDirectives: 1,
      // `typed`'s `env` entry, the helper its index imports and the file it references.
      typesOnly: 3,
      // Git-content files reached only through a member link: `srclib`'s two sources (through
      // `srcapp`'s link), `shared`'s committed declaration (through `other`'s root link) and
      // `layout`'s committed bundle declaration (through `consumer`'s link).
      throughMember: 4,
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
      // require mode: the oracle's import-mode references (the `import()`, and the `resolution-mode`
      // import type) have no relation row left.
      const lost = (kind: string): string[] => comparison.onlyOracle.filter((line) => line.startsWith(`packages/app/tsconfig.json packages/app/src/index.ts ${kind} '@acme/lib' import `));
      expect([lost('dynamic'), lost('import')].map((lines) => lines.length)).toStrictEqual([1, 1]);
      expect(differences(comparison)).not.toStrictEqual(AGREEING);
    });

    it('a kind dropped or relabelled where three references share a file, specifier and mode: each is red, and the floor loses it', () => {
      const { relation } = answer();
      const legacy = 'packages/kinds/src/legacy.js';
      const dropped = compare({ ...relation, targets: relation.targets.filter((row) => !(row.path === legacy && row.kind === 'jsdocImport')) });
      const relabelled = compare(withTargets(relation, (row) => (row.path === legacy && row.kind === 'jsdocImportType' ? { ...row, kind: 'require' } : row)));

      expect(dropped.onlyOracle.filter((line) => line.includes(`${legacy} jsdocImport './base.js'`))).toHaveLength(1);
      expect(dropped.kinds).not.toContain('jsdocImport');
      expect(relabelled.onlyOracle.filter((line) => line.includes(`${legacy} jsdocImportType './base.js'`))).toHaveLength(1);
      expect(relabelled.onlyRelation.filter((line) => line.includes(`${legacy} require './base.js'`))).toHaveLength(1);
    });

    it('one reference more under a key than the oracle holds: the count per key is red', () => {
      const { relation } = answer();
      const first = relation.targets.find((row) => row.kind === 'import');
      if (first === undefined) throw new Error('the corpus has no import row');
      const doubled = compare({ ...relation, targets: [...relation.targets, { ...first, ordinal: first.ordinal + 1000 }] });

      expect(doubled.onlyRelation).toHaveLength(1);
    });

    it('an unresolved relative reference labelled external: apart, though the oracle has it unresolved too', () => {
      const relabelled = compare(withTargets(answer().relation, (row) => (row.specifier === './dir' ? { ...row, targetKind: 'external' } : row)));

      expect(relabelled.disagree.filter((line) => line.includes("'./dir'"))).toHaveLength(1);
    });

    it('a .js target walked without allowJs, and a redirected target walked: the program files are red', () => {
      const { relation } = answer();
      const walked = [
        { config: 'packages/nojs/tsconfig.json', path: 'packages/nojs/src/legacy.js' },
        { config: 'packages/relout-app/tsconfig.json', path: 'packages/relout-lib/src/index.ts' },
      ];

      expect(compare({ ...relation, programFiles: [...relation.programFiles, ...walked] }).programOnlyRelation).toStrictEqual(walked.map((file) => `${file.config} ${file.path}`));
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

