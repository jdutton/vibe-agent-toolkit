/**
 * `ts__import_names` and `ts__exports` from the `ts` instance's extractor, run in-process with the
 * vendored TypeScript: every binding form, every export kind, the `ts__imports` ordinal each points
 * at, and positions at the name token (never the statement's start).
 */

import { describe, expect, it } from 'vitest';

import type { ExtractedTsExport, ExtractedTsImportName } from '../src/projection/ts-extractor.js';
import type { TsVariant } from '../src/schemas/projection-ts.js';

import { at, loadTypeScriptBeforeAll, tsRowsOf } from './helpers/ts-rows.js';

loadTypeScriptBeforeAll();

function namesOf(text: string, variant: TsVariant = 'ts'): readonly ExtractedTsImportName[] {
  return tsRowsOf(text, variant).importNames;
}

function exportsOf(text: string, variant: TsVariant = 'ts'): readonly ExtractedTsExport[] {
  return tsRowsOf(text, variant).exports;
}

/** An import-name row: `imported` bound to `local`, positioned at `needle` in `text`. */
function binding(text: string, ordinal: number, seq: number, imported: string, local: string, needle: string, typeOnly = false): ExtractedTsImportName {
  return { import: ordinal, seq, imported, local, typeOnly, ...at(text, needle) };
}

/** The columns an export row states beyond its kind, its name and its place. */
interface ExportColumns {
  readonly local?: string | null;
  readonly imported?: string | null;
  readonly import?: number | null;
  readonly typeOnly?: boolean;
}

/** An export row of `kind` exporting `name`, positioned at `needle` in `text`. */
function exported(text: string, seq: number, kind: ExtractedTsExport['kind'], name: string | null, needle: string, columns: ExportColumns = {}): ExtractedTsExport {
  return { seq, name, kind, local: null, imported: null, import: null, typeOnly: false, ...columns, ...at(text, needle) };
}

describe('ts__import_names: import declarations', () => {
  it('rows a default, a named, a renamed and an inline-type binding, each at its local name', () => {
    const text = "import a, { b, c as d, type E } from './m';\nimport * as ns from 'n';\n";
    expect(namesOf(text)).toEqual([
      binding(text, 0, 0, 'default', 'a', 'a,'),
      binding(text, 0, 1, 'b', 'b', 'b,'),
      binding(text, 0, 2, 'c', 'd', 'd,'),
      binding(text, 0, 3, 'E', 'E', 'E }', true),
      binding(text, 1, 0, '*', 'ns', 'ns '),
    ]);
  });

  it('marks every binding of a statement-level type-only import', () => {
    const text = "import type { A, B as C } from 'm';\nimport type D from 'n';\nimport type * as E from 'o';\n";
    expect(namesOf(text).map((row) => [row.import, row.imported, row.local, row.typeOnly])).toEqual([
      [0, 'A', 'A', true], [0, 'B', 'C', true], [1, 'default', 'D', true], [2, '*', 'E', true],
    ]);
  });

  it('rows a string-named import by its text, and nothing for a bindingless import', () => {
    const text = "import { 'a-b' as c } from 'm';\nimport 'n';\nimport {} from 'o';\n";
    expect(namesOf(text)).toEqual([binding(text, 0, 0, 'a-b', 'c', 'c }')]);
  });

  it('points a binding inside a `declare module` body at its own import', () => {
    const text = "declare module 'm' {\n  import { A } from 'n';\n}\n";
    expect(namesOf(text, 'dts')).toEqual([binding(text, 1, 0, 'A', 'A', 'A }')]);
  });

  it('rows a JSDoc `@import` in a js file, type-only', () => {
    const text = "/** @import { A, B as C } from 'a' */\nlet x;\n";
    expect(namesOf(text, 'js')).toEqual([binding(text, 0, 0, 'A', 'A', 'A,', true), binding(text, 0, 1, 'B', 'C', 'C }', true)]);
  });
});

describe('ts__import_names: import equals and require', () => {
  it('rows `import x = require()` as the whole module', () => {
    const text = "import x = require('m');\nimport type y = require('n');\n";
    expect(namesOf(text)).toEqual([binding(text, 0, 0, '*', 'x', 'x '), binding(text, 1, 0, '*', 'y', 'y ', true)]);
  });

  it('rows no binding for an entity-name alias', () => {
    expect(namesOf('namespace N { export const y = 1; }\nimport x = N.y;\n')).toEqual([]);
  });

  it('rows a module-scope whole-module require and a destructured one', () => {
    const text = "const x = require('m');\nconst { a: b, c, 'd-e': f, g = 1 } = require('n');\nlet h = (require('o'));\nvar i = require('p');\n";
    expect(namesOf(text, 'js')).toEqual([
      binding(text, 0, 0, '*', 'x', 'x '),
      binding(text, 1, 0, 'a', 'b', 'b,'),
      binding(text, 1, 1, 'c', 'c', 'c,'),
      binding(text, 1, 2, 'd-e', 'f', 'f,'),
      binding(text, 1, 3, 'g', 'g', 'g ='),
      binding(text, 2, 0, '*', 'h', 'h '),
      binding(text, 3, 0, '*', 'i', 'i '),
    ]);
  });

  it('rows no binding for a nested require, a member of one, an import() or a pattern it cannot name', () => {
    const text = [
      "function f() { const a = require('m'); }",
      "const b = require('n').b;",
      "const c = import('o');",
      "const { ...d } = require('p');",
      "const [e] = require('q');",
      "const { g: { h } } = require('r');",
      "const { [k]: v } = require('s');",
      "const w = require(name);",
      '',
    ].join('\n');
    const rows = namesOf(text, 'js');
    expect(rows).toEqual([binding(text, 7, 0, '*', 'w', 'w ')]);
  });

  it('rows a binding through a `createRequire` result at that call\'s ordinal', () => {
    const text = "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nconst m = load('m');\n";
    expect(namesOf(text)).toEqual([binding(text, 0, 0, 'createRequire', 'createRequire', 'createRequire }'), binding(text, 1, 0, '*', 'm', 'm =')]);
  });
});

describe('ts__exports: declarations', () => {
  it('positions `export const x` at `x`, not at the statement', () => {
    const text = 'export const x = 1, y = 2;\n';
    expect(exportsOf(text)).toEqual([
      exported(text, 0, 'declaration', 'x', 'x =', { local: 'x' }),
      exported(text, 1, 'declaration', 'y', 'y =', { local: 'y' }),
    ]);
  });

  it('rows every declaration form an `export` modifier carries', () => {
    const text = [
      'export function f() {}',
      'export class C {}',
      'export abstract class A {}',
      'export interface I {}',
      'export type T = 1;',
      'export enum E {}',
      'export const enum K {}',
      'export namespace N {}',
      'export declare const z: number;',
      'export const { a, b: [c] } = o;',
      '',
    ].join('\n');
    expect(exportsOf(text).map((row) => [row.kind, row.name, row.local])).toEqual([
      ['declaration', 'f', 'f'], ['declaration', 'C', 'C'], ['declaration', 'A', 'A'], ['declaration', 'I', 'I'], ['declaration', 'T', 'T'],
      ['declaration', 'E', 'E'], ['declaration', 'K', 'K'], ['declaration', 'N', 'N'], ['declaration', 'z', 'z'],
      ['declaration', 'a', 'a'], ['declaration', 'c', 'c'],
    ]);
    expect(exportsOf(text).at(-1)).toMatchObject(at(text, 'c] }'));
  });

  it('rows a default declaration at `default`, with its local name when it has one', () => {
    const text = 'export default function f() {}\n';
    expect(exportsOf(text)).toEqual([exported(text, 0, 'declaration', 'default', 'default', { local: 'f' })]);
    const anonymous = 'export   default class {}\n';
    expect(exportsOf(anonymous)).toEqual([exported(anonymous, 0, 'declaration', 'default', 'default')]);
  });

  it('rows nothing for a declaration without `export`, nor for exports inside a namespace or a `declare module`', () => {
    expect(exportsOf('const a = 1;\nnamespace N { export const b = 1; }\n')).toEqual([]);
    expect(exportsOf("declare module 'm' {\n  export const a: number;\n  export * from 'n';\n  export = a;\n}\n", 'dts')).toEqual([]);
  });
});

describe('ts__exports: local, expression and module forms', () => {
  it('rows a local export list by exported name, with inline `type`', () => {
    const text = 'const a = 1;\nexport { a, a as b, type a as c };\n';
    expect(exportsOf(text)).toEqual([
      exported(text, 0, 'local', 'a', 'a,', { local: 'a' }),
      exported(text, 1, 'local', 'b', 'b,', { local: 'a' }),
      exported(text, 2, 'local', 'c', 'c }', { local: 'a', typeOnly: true }),
    ]);
    const typed = 'type A = 1;\nexport type { A };\n';
    expect(exportsOf(typed)).toEqual([exported(typed, 0, 'local', 'A', 'A }', { local: 'A', typeOnly: true })]);
  });

  it('rows `export default ident` as local and anything else as expression, at `default`', () => {
    const text = 'const a = 1;\nexport /* c */ default a;\n';
    expect(exportsOf(text)).toEqual([exported(text, 0, 'local', 'default', 'default', { local: 'a' })]);
    const expression = 'export default 1 + 2;\n';
    expect(exportsOf(expression)).toEqual([exported(expression, 0, 'expression', 'default', 'default')]);
  });

  it('rows a re-export by exported and imported name, at its `ts__imports` ordinal', () => {
    const text = "import z from 'z';\nexport { a, b as c, type d, default } from 'm';\nexport type { e } from 'n';\n";
    expect(exportsOf(text)).toEqual([
      exported(text, 0, 'reexport', 'a', 'a,', { imported: 'a', import: 1 }),
      exported(text, 1, 'reexport', 'c', 'c,', { imported: 'b', import: 1 }),
      exported(text, 2, 'reexport', 'd', 'd,', { imported: 'd', import: 1, typeOnly: true }),
      exported(text, 3, 'reexport', 'default', 'default }', { imported: 'default', import: 1 }),
      exported(text, 4, 'reexport', 'e', 'e }', { imported: 'e', import: 2, typeOnly: true }),
    ]);
  });

  it('rows `export *` at its specifier and `export * as ns` at `ns`', () => {
    const text = "export * from 'm';\nexport type * from 'n';\nexport * as ns from 'o';\nexport type * as T from 'p';\n";
    expect(exportsOf(text)).toEqual([
      exported(text, 0, 'star', null, "'m'", { import: 0 }),
      exported(text, 1, 'star', null, "'n'", { import: 1, typeOnly: true }),
      exported(text, 2, 'namespace', 'ns', 'ns ', { import: 2 }),
      exported(text, 3, 'namespace', 'T', 'T ', { import: 3, typeOnly: true }),
    ]);
  });

  it('rows nothing for `export {}`', () => {
    expect(exportsOf('export {};\n')).toEqual([]);
  });
});

describe('ts__exports: assignment, CommonJS, global namespace and import alias', () => {
  it('rows `export =` at its expression, naming no export', () => {
    const text = 'const x = 1;\nexport = x;\n';
    expect(exportsOf(text)).toEqual([exported(text, 0, 'assignment', null, 'x;', { local: 'x' })]);
  });

  it('rows `module.exports =`, `exports.x =` and `module.exports.x =`', () => {
    const text = "module.exports = f;\nexports.x = 1;\nmodule.exports.y = z;\nexports['w'] = 2;\nmodule.exports = { a };\n";
    expect(exportsOf(text, 'js')).toEqual([
      exported(text, 0, 'assignment', null, 'f;', { local: 'f' }),
      exported(text, 1, 'cjs', 'x', 'x =', {}),
      exported(text, 2, 'cjs', 'y', 'y =', { local: 'z' }),
      exported(text, 3, 'cjs', 'w', "'w'", {}),
      exported(text, 4, 'assignment', null, '{ a }', {}),
    ]);
  });

  it('rows each target of a chained assignment, and no compound, foreign or nested one', () => {
    const text = 'exports.a = exports.b = c;\n';
    expect(exportsOf(text, 'js')).toEqual([
      exported(text, 0, 'cjs', 'a', 'a =', {}),
      exported(text, 1, 'cjs', 'b', 'b =', { local: 'c' }),
    ]);
    expect(exportsOf('exports.a += 1;\nfoo.exports = 1;\nfoo.exports.b = 1;\nif (c) { exports.d = 1; }\nfunction f() { module.exports = 1; }\n', 'js')).toEqual([]);
  });

  it('rows `export as namespace X` at `X`', () => {
    const text = 'export as namespace X;\nexport {};\n';
    expect(exportsOf(text, 'dts')).toEqual([exported(text, 0, 'globalNamespace', 'X', 'X;')]);
  });

  it('rows `export import a = N.b` at `a`, and an exported require alias with its binding', () => {
    const text = "namespace N { export const b = 1; }\nexport import a = N.b;\nexport import r = require('m');\n";
    expect(exportsOf(text)).toEqual([
      exported(text, 0, 'importAlias', 'a', 'a =', { local: 'a' }),
      exported(text, 1, 'importAlias', 'r', 'r =', { local: 'r' }),
    ]);
    expect(namesOf(text)).toEqual([binding(text, 0, 0, '*', 'r', 'r =')]);
  });
});

describe('order and positions', () => {
  it('numbers exports in source order across kinds', () => {
    const text = "export * from 'a';\nexport const b = 1;\nexport { b as c };\nexport default b;\n";
    expect(exportsOf(text).map((row) => [row.seq, row.kind, row.name])).toEqual([
      [0, 'star', null], [1, 'declaration', 'b'], [2, 'local', 'c'], [3, 'local', 'default'],
    ]);
  });

  it('counts CRLF, a lone CR and an astral character as the shared line index does', () => {
    expect(exportsOf('const a = 1;\r\nexport const b = 2;')).toMatchObject([{ line: 2, column: 14 }]);
    expect(exportsOf('const a = 1;\rexport const b = 2;')).toMatchObject([{ line: 2, column: 14 }]);
    expect(namesOf("const s = '\u{1F600}'; import { b } from 'm';")).toMatchObject([{ line: 1, column: 26 }]);
  });

  it('rows names and exports in all four variants', () => {
    for (const variant of ['ts', 'dts', 'tsx', 'js'] as const) {
      const rows = tsRowsOf("import { a } from 'm';\nexport { a };\n", variant);
      expect(rows.importNames).toMatchObject([{ import: 0, imported: 'a', local: 'a' }]);
      expect(rows.exports).toMatchObject([{ kind: 'local', name: 'a', local: 'a' }]);
    }
  });
});
