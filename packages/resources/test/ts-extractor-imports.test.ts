/**
 * `ts__imports` from the `ts` instance's extractor, run in-process with the vendored TypeScript:
 * every kind, every column, source order, positions, and the `createRequire` recognition held to
 * `local/projection-sqlite-import-boundary`'s own verdict on the same snippet (run through ESLint's
 * `Linter`), so the two recognitions are one, both ways.
 */

import * as tsParser from '@typescript-eslint/parser';
import eslintPlugin from '@vibe-agent-toolkit/utils/eslint';
import { Linter, type Rule } from 'eslint';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARSE_LIMITS } from '../src/parse-limits.js';
import { assertJsDocAttached, extractTsRows, type ExtractedTsImport } from '../src/projection/ts-extractor.js';
import type { TsVariant } from '../src/schemas/projection-ts.js';
import type ts from '../src/vendor/typescript.cjs';

import { at, loadTypeScriptBeforeAll, tsRowsOf, vendoredTypeScript } from './helpers/ts-rows.js';

loadTypeScriptBeforeAll();

/** The `ts__imports` rows of `text`, which must extract to rows. */
function importsOf(text: string, variant: TsVariant = 'ts'): readonly ExtractedTsImport[] {
  return tsRowsOf(text, variant).imports;
}

/** The one row of `text`. */
function onlyRow(text: string, variant: TsVariant = 'ts'): ExtractedTsImport {
  const rows = importsOf(text, variant);
  expect(rows).toHaveLength(1);
  return rows[0] as ExtractedTsImport;
}

/** `line`/`column` at `specifier` and `nodeLine`/`nodeColumn` at `node`, as a row's columns. */
function placed(text: string, specifier: string, node: string): Pick<ExtractedTsImport, 'line' | 'column' | 'nodeLine' | 'nodeColumn'> {
  const spec = at(text, specifier);
  const carrier = at(text, node);
  return { line: spec.line, column: spec.column, nodeLine: carrier.line, nodeColumn: carrier.column };
}

/** Every column at its default, for a row the test states in full. */
const PLAIN = {
  argumentCount: null,
  typeOnly: false,
  hasClause: false,
  hasDefault: false,
  hasNamespace: false,
  namedBindings: null,
  typeOnlyNamed: null,
  resolutionMode: null,
  attributeType: null,
  scope: 'module',
} as const;

describe('import declarations', () => {
  it('states a default, named and inline-type clause in full', () => {
    const text = "import a, { b, type C } from './m';\n";
    expect(onlyRow(text)).toEqual({
      ...PLAIN,
      ordinal: 0,
      kind: 'import',
      specifier: './m',
      specifierForm: 'string',
      hasClause: true,
      hasDefault: true,
      namedBindings: 2,
      typeOnlyNamed: 1,
      ...placed(text, "'./m'", 'import'),
    });
  });

  it('separates a statement-level type-only import from an inline one', () => {
    expect(onlyRow("import type { A } from 'm';")).toMatchObject({ typeOnly: true, namedBindings: 1, typeOnlyNamed: 0 });
    expect(onlyRow("import { type A } from 'm';")).toMatchObject({ typeOnly: false, namedBindings: 1, typeOnlyNamed: 1 });
    expect(onlyRow("import type A from 'm';")).toMatchObject({ typeOnly: true, hasDefault: true, namedBindings: null });
  });

  it('answers an empty clause, no clause, and a namespace clause', () => {
    expect(onlyRow("import {} from 'm';")).toMatchObject({ hasClause: true, namedBindings: 0, typeOnlyNamed: 0, hasDefault: false });
    expect(onlyRow("import 'm';")).toMatchObject({ hasClause: false, namedBindings: null, typeOnlyNamed: null });
    expect(onlyRow("import * as ns from 'm';")).toMatchObject({ hasClause: true, hasNamespace: true, namedBindings: null });
  });

  it('reads the `type` attribute and the resolution-mode override', () => {
    expect(onlyRow("import data from './a.json' with { type: 'json' };")).toMatchObject({ attributeType: 'json', resolutionMode: null });
    expect(onlyRow("import type { A } from 'm' with { 'resolution-mode': 'require' };")).toMatchObject({ resolutionMode: 'require', attributeType: null });
    expect(onlyRow("import type { A } from 'm' with { 'resolution-mode': 'import' };")).toMatchObject({ resolutionMode: 'import' });
  });
});

describe('export declarations', () => {
  it('rows an export with a module specifier and nothing else', () => {
    expect(importsOf('const a = 1;\nexport { a };\nexport default a;\n')).toEqual([]);
    const text = "export { a, type b } from 'm';\n";
    expect(onlyRow(text)).toEqual({
      ...PLAIN,
      ordinal: 0,
      kind: 'export',
      specifier: 'm',
      specifierForm: 'string',
      hasClause: true,
      namedBindings: 2,
      typeOnlyNamed: 1,
      ...placed(text, "'m'", 'export'),
    });
  });

  it('answers `export *`, `export * as ns` and a type-only export', () => {
    expect(onlyRow("export * from 'm';")).toMatchObject({ kind: 'export', hasClause: false, hasNamespace: false, namedBindings: null });
    expect(onlyRow("export * as ns from 'm';")).toMatchObject({ kind: 'export', hasClause: true, hasNamespace: true, namedBindings: null });
    expect(onlyRow("export type { A } from 'm';")).toMatchObject({ kind: 'export', typeOnly: true });
    expect(onlyRow("export { a } from './a.json' with { type: 'json' };")).toMatchObject({ attributeType: 'json' });
  });
});

describe('import equals', () => {
  it('rows an external module reference, positioned at the reference', () => {
    const text = "import x = require('m');\n";
    expect(onlyRow(text)).toEqual({ ...PLAIN, ordinal: 0, kind: 'importEquals', specifier: 'm', specifierForm: 'string', ...placed(text, "'m'", 'require') });
    expect(onlyRow("import type x = require('m');")).toMatchObject({ kind: 'importEquals', typeOnly: true });
  });

  it('rows no entity-name alias, nor `export as namespace`', () => {
    expect(importsOf('namespace N { export const y = 1; }\nimport x = N.y;\nexport import a = N.y;\n')).toEqual([]);
    expect(importsOf('export as namespace X;\nexport {};\n', 'dts')).toEqual([]);
  });
});

describe('dynamic imports and import types', () => {
  it('rows a string, a template and a computed specifier, with the argument count', () => {
    const text = "const a = import('m');\nconst b = import(`t`);\nconst c = import(name, { with: { type: 'json' } });\n";
    expect(importsOf(text)).toEqual([
      { ...PLAIN, ordinal: 0, kind: 'dynamic', specifier: 'm', specifierForm: 'string', argumentCount: 1, ...placed(text, "'m'", "import('m')") },
      { ...PLAIN, ordinal: 1, kind: 'dynamic', specifier: 't', specifierForm: 'template', argumentCount: 1, ...placed(text, '`t`', 'import(`t`)') },
      { ...PLAIN, ordinal: 2, kind: 'dynamic', specifier: null, specifierForm: null, argumentCount: 2, ...placed(text, 'name', 'import(name') },
    ]);
  });

  it('sees through parentheses on a call argument, as ESTree does, placing the row at the inner literal', () => {
    const text = "const a = import(('m'));\nconst b = require((`t`));\nconst c = import((('n')), 1);\nconst d = require((name));\n";
    expect(importsOf(text)).toEqual([
      { ...PLAIN, ordinal: 0, kind: 'dynamic', specifier: 'm', specifierForm: 'string', argumentCount: 1, ...placed(text, "'m'", "import(('m')") },
      { ...PLAIN, ordinal: 1, kind: 'require', specifier: 't', specifierForm: 'template', argumentCount: 1, ...placed(text, '`t`', 'require((`t`))') },
      { ...PLAIN, ordinal: 2, kind: 'dynamic', specifier: 'n', specifierForm: 'string', argumentCount: 2, ...placed(text, "'n'", "import((('n'))") },
      { ...PLAIN, ordinal: 3, kind: 'require', specifier: null, specifierForm: null, argumentCount: 1, ...placed(text, '(name)', 'require((name))') },
    ]);
  });

  it('sees through parentheses on a createRequire call argument', () => {
    const text = "const r = createRequire(import.meta.url);\nr(('m'));\n";
    expect(importsOf(text).filter((row) => row.kind === 'createRequire')).toMatchObject([{ specifier: 'm', specifierForm: 'string', ...placed(text, "'m'", "r(('m'") }]);
  });

  it('rows a type-position import with its attributes', () => {
    const text = "type T = typeof import('m');\ntype U = import('n', { with: { 'resolution-mode': 'import' } }).X;\n";
    expect(importsOf(text)).toEqual([
      { ...PLAIN, ordinal: 0, kind: 'importType', specifier: 'm', specifierForm: 'string', ...placed(text, "'m'", "import('m'") },
      { ...PLAIN, ordinal: 1, kind: 'importType', specifier: 'n', specifierForm: 'string', resolutionMode: 'import', ...placed(text, "'n'", "import('n'") },
    ]);
  });
});

describe('require and scope', () => {
  it('rows a module-scope require, a nested one, and a computed one', () => {
    const text = "const a = require('m');\nfunction f() { return require('n'); }\nrequire(x, y);\nconst g = () => require('o');\n";
    expect(importsOf(text)).toEqual([
      { ...PLAIN, ordinal: 0, kind: 'require', specifier: 'm', specifierForm: 'string', argumentCount: 1, ...placed(text, "'m'", "require('m')") },
      { ...PLAIN, ordinal: 1, kind: 'require', specifier: 'n', specifierForm: 'string', argumentCount: 1, scope: 'nested', ...placed(text, "'n'", "require('n')") },
      { ...PLAIN, ordinal: 2, kind: 'require', specifier: null, specifierForm: null, argumentCount: 2, ...placed(text, 'x, y', 'require(x') },
      { ...PLAIN, ordinal: 3, kind: 'require', specifier: 'o', specifierForm: 'string', argumentCount: 1, scope: 'nested', ...placed(text, "'o'", "require('o')") },
    ]);
  });

  it('positions a call with no argument at the call', () => {
    const text = 'require();\n';
    expect(onlyRow(text)).toMatchObject({ kind: 'require', specifier: null, argumentCount: 0, ...placed(text, 'require', 'require') });
  });

  it('rows a statement inside a block or a control-flow body as nested', () => {
    expect(importsOf("if (a) require('m');\n{ require('n'); }\nconst b = c ? require('o') : null;\n").map((row) => row.scope)).toEqual(['nested', 'nested', 'module']);
  });

  it('rows `declare module` as ambient and the references in its body as ambientModule', () => {
    const text = "declare module 'm' {\n  import { A } from 'n';\n  export * from 'o';\n  export function f(): typeof import('p');\n}\n";
    expect(importsOf(text, 'dts')).toEqual([
      { ...PLAIN, ordinal: 0, kind: 'ambient', specifier: 'm', specifierForm: 'string', ...placed(text, "'m'", 'declare') },
      { ...PLAIN, ordinal: 1, kind: 'import', specifier: 'n', specifierForm: 'string', scope: 'ambientModule', hasClause: true, namedBindings: 1, typeOnlyNamed: 0, ...placed(text, "'n'", 'import {') },
      { ...PLAIN, ordinal: 2, kind: 'export', specifier: 'o', specifierForm: 'string', scope: 'ambientModule', ...placed(text, "'o'", 'export *') },
      { ...PLAIN, ordinal: 3, kind: 'importType', specifier: 'p', specifierForm: 'string', scope: 'nested', ...placed(text, "'p'", "import('p'") },
    ]);
  });

  it('rows a namespace body as nested, not ambient', () => {
    expect(importsOf("declare namespace N {\n  type T = import('m').X;\n}\n", 'dts')).toMatchObject([{ kind: 'importType', scope: 'nested' }]);
  });
});

describe('triple-slash directives', () => {
  it('rows path, types and lib at the start of each value', () => {
    const text = '/// <reference path="./a.ts" />\n/// <reference types="node" resolution-mode="require" />\n/// <reference lib="es2024" />\nexport {};\n';
    const row = (kind: string, specifier: string, needle: string): ExtractedTsImport => {
      const { line, column } = at(text, needle);
      return { ...PLAIN, ordinal: 0, kind, specifier, specifierForm: 'string', line, column, nodeLine: line, nodeColumn: column } as ExtractedTsImport;
    };
    expect(importsOf(text)).toEqual([
      row('referencePath', './a.ts', './a.ts'),
      { ...row('referenceTypes', 'node', 'node"'), ordinal: 1, resolutionMode: 'require' },
      { ...row('referenceLib', 'es2024', 'es2024'), ordinal: 2 },
    ]);
  });
});

describe('JSDoc imports (js only)', () => {
  const text = "/** @import { A, B } from 'a' */\n/** @type {import('b').C} */\nlet x;\nexport function f(/** @type {import('c').D} */ y) { return y; }\n";

  it('rows an @import tag and a JSDoc import type in a js file, in source order', () => {
    const tag = at(text, "'a'");
    const typeB = at(text, "'b'");
    const typeC = at(text, "'c'");
    expect(importsOf(text, 'js')).toEqual([
      { ...PLAIN, ordinal: 0, kind: 'jsdocImport', specifier: 'a', specifierForm: 'string', hasClause: true, namedBindings: 2, typeOnlyNamed: 0, ...tag, nodeLine: tag.line, nodeColumn: tag.column },
      { ...PLAIN, ordinal: 1, kind: 'jsdocImportType', specifier: 'b', specifierForm: 'string', ...typeB, nodeLine: typeB.line, nodeColumn: typeB.column },
      { ...PLAIN, ordinal: 2, kind: 'jsdocImportType', specifier: 'c', specifierForm: 'string', scope: 'nested', ...typeC, nodeLine: typeC.line, nodeColumn: typeC.column },
    ]);
  });

  it('rows no JSDoc reference outside the js variant', () => {
    for (const variant of ['ts', 'dts', 'tsx'] as const) expect(importsOf(text, variant)).toEqual([]);
  });

  it('orders a JSDoc reference before the statement it documents', () => {
    expect(importsOf("/** @import { A } from 'a' */\nimport b from 'b';\n", 'js').map((row) => [row.ordinal, row.kind])).toEqual([[0, 'jsdocImport'], [1, 'import']]);
  });
});

describe('every variant, source order, positions', () => {
  it('rows an import in all four variants', () => {
    for (const variant of ['ts', 'dts', 'tsx', 'js'] as const) expect(onlyRow("import a from 'm';", variant)).toMatchObject({ kind: 'import', specifier: 'm' });
  });

  it('numbers mixed kinds in source order', () => {
    const text = "/// <reference types=\"t\" />\nimport a from 'a';\nexport * from 'b';\nconst c = require('c');\nconst d = import('d');\ntype E = import('e').E;\n";
    expect(importsOf(text).map((row) => [row.ordinal, row.kind, row.specifier])).toEqual([
      [0, 'referenceTypes', 't'], [1, 'import', 'a'], [2, 'export', 'b'], [3, 'require', 'c'], [4, 'dynamic', 'd'], [5, 'importType', 'e'],
    ]);
  });

  it('places a multi-line import, export and call with the specifier and the node apart', () => {
    const text = "import {\n  a,\n} from\n  'm';\nexport {\n  b,\n} from 'n';\nconst c = require(\n  'o',\n);\n";
    expect(importsOf(text).map(({ line, column, nodeLine, nodeColumn }) => [line, column, nodeLine, nodeColumn])).toEqual([
      [4, 3, 1, 1], [7, 8, 5, 1], [9, 3, 8, 11],
    ]);
  });

  it('counts CRLF and a lone CR as one break each, and an astral character as two UTF-16 columns', () => {
    expect(onlyRow("const a = 1;\r\nimport b from 'm';")).toMatchObject({ line: 2, column: 15, nodeLine: 2, nodeColumn: 1 });
    expect(onlyRow("const a = 1;\rimport b from 'm';")).toMatchObject({ line: 2, column: 15, nodeLine: 2, nodeColumn: 1 });
    expect(onlyRow("const s = '\u{1F600}'; import b from 'm';")).toMatchObject({ line: 1, column: 31, nodeColumn: 17 });
  });

  it('does not break a line at U+2028 inside a string', () => {
    const separator = String.fromCodePoint(0x2028);
    expect(onlyRow(`const s = 'a${separator}b'; import c from 'm';`)).toMatchObject({ line: 1, column: 32, nodeLine: 1, nodeColumn: 18 });
  });
});

/** The storage backend: a specifier the boundary rule reports on whenever it recognises the call. */
const BACKEND = '@vibe-agent-toolkit/projection-sqlite';
const LINTED = '/repo/packages/resources/src/projection/subject.ts';

/** The boundary rule's reports on `code`: one per call it recognises as a require of the backend. */
function ruleReports(code: string): readonly Linter.LintMessage[] {
  const rule = eslintPlugin.rules['projection-sqlite-import-boundary'] as unknown as Rule.RuleModule;
  const config: Linter.Config[] = [{
    files: ['**/*.ts'],
    plugins: { local: { rules: { boundary: rule } } },
    rules: { 'local/boundary': 'error' },
    languageOptions: { parser: tsParser, ecmaVersion: 2024, sourceType: 'module' },
  }];
  const messages = new Linter({ cwd: '/repo' }).verify(code, config, { filename: LINTED });
  expect(messages.filter((message) => message.ruleId !== 'local/boundary')).toEqual([]);
  return messages;
}

/** Each `createRequire` shape, and how many calls of the backend each one makes through it. */
const CREATE_REQUIRE_CASES: readonly { readonly name: string; readonly code: string; readonly calls: number }[] = [
  { name: 'the bare name, called at once', code: `createRequire(import.meta.url)('${BACKEND}');`, calls: 1 },
  { name: 'a name bound to its result', code: `const load = createRequire(import.meta.url);\nload('${BACKEND}');`, calls: 1 },
  { name: 'renamed by an import from `module`', code: `import { createRequire as make } from 'module';\nconst load = make(import.meta.url);\nload('${BACKEND}');`, calls: 1 },
  { name: 'renamed by an import from `node:module`', code: `import { createRequire as make } from 'node:module';\nmake(import.meta.url)('${BACKEND}');`, calls: 1 },
  { name: 'imported below its use', code: `make(import.meta.url)('${BACKEND}');\nimport { createRequire as make } from 'node:module';`, calls: 1 },
  { name: 'a member `X.createRequire`', code: `import * as mod from 'node:module';\nmod.createRequire(import.meta.url)('${BACKEND}');`, calls: 1 },
  { name: 'a member bound to a name', code: `const load = mod.createRequire(import.meta.url);\nload(\`${BACKEND}\`);`, calls: 1 },
  { name: 'a bound name called above its binding', code: `export function f(): unknown { return load('${BACKEND}'); }\nconst load = createRequire(import.meta.url);`, calls: 1 },
  { name: 'a binding inside a function, called elsewhere by spelling', code: `function g(): void { const load = createRequire(import.meta.url); }\nload('${BACKEND}');`, calls: 1 },
  { name: 'a parenthesized callee and initializer', code: `const load = (createRequire(import.meta.url));\n(load)('${BACKEND}');\n(createRequire)(import.meta.url)('${BACKEND}');`, calls: 2 },
  { name: 'an optional call through the bound name', code: `const load = createRequire(import.meta.url);\nload?.('${BACKEND}');`, calls: 1 },
  { name: 'an optional member continuing its chain', code: `mod?.createRequire(import.meta.url)('${BACKEND}');`, calls: 1 },
  { name: 'an optional member result bound to a name', code: `const load = mod?.createRequire(import.meta.url);\nload('${BACKEND}');`, calls: 0 },
  { name: 'a parenthesized optional member', code: `(mod?.createRequire)(import.meta.url)('${BACKEND}');`, calls: 0 },
  { name: 'renamed by an import from another module', code: `import { createRequire as make } from './loader.js';\nmake(import.meta.url)('${BACKEND}');`, calls: 0 },
  { name: 'renamed inside a declare module body, not top-level', code: `declare module 'x' { import { createRequire as make } from 'node:module'; }\nmake(import.meta.url)('${BACKEND}');`, calls: 0 },
  { name: 'a destructured binding', code: `const { load } = { load: createRequire(import.meta.url) };\nload('${BACKEND}');`, calls: 0 },
  { name: 'an assignment, not a declarator', code: `let load: (id: string) => unknown;\nload = createRequire(import.meta.url);\nload('${BACKEND}');`, calls: 0 },
  { name: 'a computed member', code: `mod['createRequire'](import.meta.url)('${BACKEND}');`, calls: 0 },
  { name: 'a cast result', code: `const load = createRequire(import.meta.url) as (id: string) => unknown;\nload('${BACKEND}');`, calls: 0 },
  { name: 'the factory itself, called with the backend', code: `createRequire('${BACKEND}');`, calls: 0 },
];

describe('createRequire, recognised as the boundary rule recognises it', () => {
  for (const { name, code, calls } of CREATE_REQUIRE_CASES) {
    it(name, () => {
      const reports = ruleReports(code);
      const rows = importsOf(code).filter((row) => row.kind === 'createRequire' && row.specifier === BACKEND);
      expect(reports).toHaveLength(calls);
      expect(rows).toHaveLength(calls);
      expect(rows.map((row) => [row.nodeLine, row.nodeColumn])).toEqual(reports.map((report) => [report.line, report.column]));
      expect(rows.every((row) => row.argumentCount === 1)).toBe(true);
    });
  }

  it('places a `typeof import()` type at its `import`, where the rule reports it, not at `typeof`', () => {
    const code = `type T = typeof\n  import('${BACKEND}');\ntype U = typeof import('${BACKEND}').X;\ntype V = import('${BACKEND}').Y;`;
    const reports = ruleReports(code);
    const rows = importsOf(code).filter((row) => row.kind === 'importType');
    expect(reports).toHaveLength(3);
    expect(rows.map((row) => [row.nodeLine, row.nodeColumn])).toEqual(reports.map((report) => [report.line, report.column]));
  });

  it('rows a call through a bound name spelled `require` as `require`, as the rule reports it', () => {
    const code = `const require = createRequire(import.meta.url);\nrequire('${BACKEND}');`;
    expect(ruleReports(code)).toHaveLength(1);
    expect(importsOf(code)).toMatchObject([{ kind: 'require', specifier: BACKEND }]);
  });
});

/** The vendored module with one property replaced. */
function withProperty(name: string, value: unknown): typeof ts {
  return Object.create(vendoredTypeScript(), { [name]: { value } }) as typeof ts;
}

describe('the internals the import rows read', () => {
  for (const name of ['getResolutionModeOverride', 'isExclusivelyTypeOnlyImportOrExport']) {
    it(`refuses a TypeScript lacking ${name}`, () => {
      expect(() => extractTsRows(withProperty(name, undefined), { text: "import a from 'm';", variant: 'ts' }, DEFAULT_PARSE_LIMITS)).toThrow(name);
    });
  }

  it('accepts the vendored parse, and refuses one that attaches no JSDoc to its hosts', () => {
    expect(() => {
      assertJsDocAttached(vendoredTypeScript());
    }).not.toThrow();
    const typescript = vendoredTypeScript();
    const original = typescript.createSourceFile.bind(typescript);
    const stripped: typeof ts.createSourceFile = (...args) => {
      const file = original(...args);
      for (const statement of file.statements) delete (statement as { jsDoc?: unknown }).jsDoc;
      return file;
    };
    expect(() => {
      assertJsDocAttached(withProperty('createSourceFile', stripped));
    }).toThrow('jsDoc');
  });
});
