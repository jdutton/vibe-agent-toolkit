/**
 * Every markdown and HTML parse in a shipping package runs in the parse worker.
 *
 * ADR I11 (one contract) and I8 (termination): a parse on the run's own thread
 * cannot be stopped at a limit, so a pathological document hangs, exhausts the
 * heap or overflows the stack of the command itself. Every review round of the
 * bounded-parse work found one more such path — a direct `parseMarkdown`, a
 * frontmatter `yaml.parse`, a sync `parseHtml` — each a caller that reached a
 * parser module without the pool. This test closes the class from the tree: no
 * `src` file of a shipping package VALUE-imports a parser module, except the
 * files listed in {@link ALLOWED} with why.
 *
 * Parser modules are:
 *
 * - the parser libraries themselves ({@link isParserLibrary}), the npm
 *   `typescript` among them: VAT's one TypeScript is the vendored copy, so a
 *   second load path to the project's own `typescript` is red;
 * - this repository's own parser modules in `resources` ({@link isParserModule}),
 *   reached by a relative import or a package subpath, the vendored TypeScript
 *   file (`vendor/typescript.cjs`) and its one loader among them;
 * - `yaml`, in a module that decodes a `---` frontmatter block
 *   ({@link searchesForFence}). `yaml` everywhere else is configuration,
 *   manifests and output — the repository's one YAML library — and is not a
 *   parse of a document.
 *
 * An `import type` (or a specifier list of only `type` names) is erased at
 * runtime and loads nothing, so it is never a parse path.
 *
 * {@link ALLOWED} is asserted both ways: every listed file must still import a
 * parser module (a stale entry is a hole waiting for the next importer), and
 * every importer must be listed.
 *
 * The private packages (`dev-tools`, `lab`) are out of scope: they ship to no
 * user, and the parser bake-off legitimately runs a parser in-process.
 */


import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { shippingCodeSources } from './package-sources.js';
import { importIsTypeOnly, nodesOf, shippingImporters, sourceOf } from './typescript-ast.js';

/** Parser libraries named exactly. */
const PARSER_LIBRARY_NAMES: ReadonlySet<string> = new Set(['remark', 'unified', 'marked', 'jsonc-parser', 'ini', 'typescript']);

/** Prefixes of parser libraries and their parts (`remark-parse`, `mdast-util-…`, `micromark/lib/…`, `typescript/lib/…`). */
const PARSER_LIBRARY_PREFIXES = ['remark-', 'mdast-', 'micromark', 'parse5', 'markdown-it', 'typescript/'] as const;

/** This repository's own parser modules in `resources`, by base name. */
const PARSER_MODULES: ReadonlySet<string> = new Set([
  'link-parser',
  'remark-parser',
  'html-link-parser',
  'markdown-processor',
  'frontmatter-source',
  'parser-loader',
  'parse-tokenize-probe',
  'parse-conformance',
  'claude-memory',
  'data-extractor',
  'data-yaml',
  'data-ini',
  'vendored-typescript',
  'tsconfig-parse',
]);

/** The vendored TypeScript's path ending; with {@link isVendoredTypeScript}'s relative-path test, never a bare `typescript`. */
const VENDORED_TYPESCRIPT = /\/vendor\/typescript(?:\.cjs)?$/;

/** Whether `specifier` reaches the vendored TypeScript: a relative path into a `vendor/` directory. */
function isVendoredTypeScript(specifier: string): boolean {
  return specifier.startsWith('.') && VENDORED_TYPESCRIPT.test(specifier);
}

/** A module specifier's base name without its runtime extension (`.js` or `.cjs`). */
function baseName(specifier: string): string {
  return specifier.slice(specifier.lastIndexOf('/') + 1).replace(/\.c?js$/, '');
}

/** Whether `specifier` names a markdown or HTML parser library, or a part of one. */
function isParserLibrary(specifier: string): boolean {
  return PARSER_LIBRARY_NAMES.has(specifier) || PARSER_LIBRARY_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

/** Whether `specifier` reaches one of resources' own parser modules: relatively, or by the package subpath. */
function isParserModule(specifier: string): boolean {
  if (isVendoredTypeScript(specifier)) return true;
  if (!specifier.startsWith('.') && !specifier.startsWith('@vibe-agent-toolkit/resources/')) return false;
  return PARSER_MODULES.has(baseName(specifier));
}

/** Whether a re-export loads nothing at runtime: `export type`, or `{ type A, type B }`. */
function exportIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  );
}

/** Whether `node` is a `createRequire(…)` call (or `module.createRequire(…)`): it returns a CommonJS `require`. */
function isCreateRequireCall(node: ts.Node | undefined): node is ts.CallExpression {
  if (node === undefined || !ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  return ts.isIdentifier(name) && name.text === 'createRequire';
}

/**
 * The names a body calls as a CommonJS `require`: the bare `require` itself (a
 * `.cjs` or `.cts` module's own), and every `const`/`let` bound to a
 * `createRequire(…)` result — `const require = createRequire(import.meta.url)`.
 */
function requireNames(nodes: readonly ts.Node[]): ReadonlySet<string> {
  const names = new Set(['require']);
  for (const node of nodes) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isCreateRequireCall(node.initializer)) {
      names.add(node.name.text);
    }
  }
  return names;
}

/** A call's first argument when it is a string literal, or undefined. */
function literalArgument(node: ts.CallExpression): string | undefined {
  const [argument] = node.arguments;
  return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

/**
 * The specifier a CommonJS load evaluates, or undefined: `createRequire(…)('x')`
 * on the spot (how a module reaches a library with no `exports` map,
 * `jsonc-parser`), or `<name>('x')` for a {@link requireNames} name.
 *
 * `require.resolve('x')` is NOT a load: it finds the file and evaluates nothing,
 * so its callee — a property access, not one of the names — never matches.
 */
function requiredSpecifier(node: ts.CallExpression, names: ReadonlySet<string>): string | undefined {
  const callee = node.expression;
  const loads = isCreateRequireCall(callee) || (ts.isIdentifier(callee) && names.has(callee.text));
  return loads ? literalArgument(node) : undefined;
}

/** The specifier an `import x = require('m')` loads, or undefined for `import type x = require('m')` and a namespace alias. */
function importEqualsSpecifier(node: ts.ImportEqualsDeclaration): string | undefined {
  const reference = node.moduleReference;
  if (node.isTypeOnly || !ts.isExternalModuleReference(reference)) return undefined;
  return ts.isStringLiteralLike(reference.expression) ? reference.expression.text : undefined;
}

/**
 * The specifier a node value-loads — a value import, a re-export, a dynamic
 * import, an import-equals `require`, or a CommonJS `require` call (see
 * {@link requiredSpecifier}) — or undefined.
 */
function valueSpecifier(node: ts.Node, names: ReadonlySet<string>): string | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    return importIsTypeOnly(node.importClause) ? undefined : node.moduleSpecifier.text;
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    return exportIsTypeOnly(node) ? undefined : node.moduleSpecifier.text;
  }
  if (ts.isImportEqualsDeclaration(node)) return importEqualsSpecifier(node);
  if (!ts.isCallExpression(node)) return undefined;
  return node.expression.kind === ts.SyntaxKind.ImportKeyword ? literalArgument(node) : requiredSpecifier(node, names);
}

/** Calls that SEARCH a string for a literal. */
const SEARCHES: ReadonlySet<string> = new Set(['startsWith', 'indexOf', 'includes', 'split']);

/** `text` without its leading line endings. */
function withoutLeadingNewlines(text: string): string {
  let start = 0;
  while (text[start] === '\n' || text[start] === '\r') start++;
  return text.slice(start);
}

/** Whether `node` searches for a `---` delimiter: a string search for it, or a regular expression spelling it. */
function searchesForFence(node: ts.Node): boolean {
  if (ts.isRegularExpressionLiteral(node)) return node.text.includes('---');
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    SEARCHES.has(node.expression.name.text) &&
    node.arguments.some((argument) => ts.isStringLiteralLike(argument) && withoutLeadingNewlines(argument.text).startsWith('---'))
  );
}

/**
 * The parser modules `body` value-imports, parsed by `file`'s extension (a
 * `.cjs` body as JavaScript). `yaml` counts only in a module that splits a
 * `---` frontmatter block off a document — one that SEARCHES for the
 * delimiter. A module that only WRITES `---` (a YAML document's opener on
 * output) does not.
 */
function parserImports(body: string, file = 'module.ts'): string[] {
  const nodes = nodesOf(sourceOf(body, file));
  const frontmatter = nodes.some((node) => searchesForFence(node));
  const names = requireNames(nodes);
  return nodes
    .map((node) => valueSpecifier(node, names))
    .filter((specifier): specifier is string => specifier !== undefined)
    .filter((specifier) => isParserLibrary(specifier) || isParserModule(specifier) || (frontmatter && specifier === 'yaml'));
}

/** Why the `resource-compiler` transformer may import the npm `typescript`. */
const PROJECT_TYPESCRIPT =
  'NOT VAT\'s parse: the transformer plugin runs inside the project\'s own compiler and uses the project\'s `typescript`.';

/**
 * The files that may value-import a parser module, and why.
 *
 * The worker's closure is the parse worker, the loader only it imports, and
 * the modules the loader reaches. Everything else on this list is NOT a fact
 * parse, and says what it is instead.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'packages/resources/src/parse-worker.ts':
    'the parse worker: the one thread a parse runs on, under its limits (I8). The only importer of the parser loader.',
  'packages/resources/src/parser-loader.ts':
    'the worker\'s lazy loader of the two parser modules; imported by the parse worker alone.',
  'packages/resources/src/link-parser.ts':
    'the markdown composer the worker runs (worker closure).',
  'packages/resources/src/remark-parser.ts':
    'the markdown parser behind the composer (worker closure).',
  'packages/resources/src/markdown-processor.ts':
    'the unified/remark processor the markdown parser builds (worker closure).',
  'packages/resources/src/parse-tokenize-probe.ts':
    'the tokenize-phase timing probe remark-parser runs inside the parse (worker closure).',
  'packages/resources/src/html-link-parser.ts':
    'the HTML parser the worker runs (worker closure).',
  'packages/resources/src/parse-conformance.ts':
    'the conformance harness that runs a parser-under-test in-process; its subpath is for private dev tooling only, and no shipped src imports it (asserted below).',
  'packages/resources/src/html-transform.ts':
    'NOT a fact parse: an EDIT path. `rewriteHtmlLinks` parses an HTML file being packaged to rewrite its links in place; it files no facts and answers no check.',
  'packages/resources/src/frontmatter-editor.ts':
    'NOT a fact parse: an EDIT path. It decodes a frontmatter block to rewrite it with comments preserved; it files no facts and answers no check.',
  'packages/resources/src/projection/claude-memory.ts':
    'Claude Code\'s memory-file reader (`marked` lexer and its `gB` frontmatter split), the harness facts lane the worker runs (worker closure); imported by the parser loader alone.',
  'packages/resources/src/projection/data-extractor.ts':
    'the `data` instance\'s extractor (`jsonc-parser`, by `createRequire`, the YAML variant\'s `data-yaml` and the `.npmrc` variant\'s `data-ini`), the data job the worker runs (worker closure); imported by the parser loader alone.',
  'packages/resources/src/projection/data-ini.ts':
    'the `.npmrc` variant\'s extractor (npm\'s `ini`, by `createRequire`), reached only through the data extractor (worker closure); imported by the data extractor alone.',
  'packages/resources/src/vendored-typescript.ts':
    'the one loader of the vendored TypeScript (`vendor/typescript.cjs`), deferred inside its load function; the only importer of that file, and imported by the tsconfig parse alone.',
  'packages/resources/src/projection/tsconfig-parse.ts':
    'the tsconfig parse (the vendored TypeScript through its loader, and the data extractor\'s nesting pre-scan), the tsconfig job the worker runs (worker closure); imported by the parser loader alone.',
  'packages/resource-compiler/src/transformer/ast-helpers.ts': PROJECT_TYPESCRIPT,
  'packages/resource-compiler/src/transformer/import-detector.ts': PROJECT_TYPESCRIPT,
  'packages/resource-compiler/src/transformer/module-generator.ts': PROJECT_TYPESCRIPT,
  'packages/resource-compiler/src/transformer/path-resolver.ts': PROJECT_TYPESCRIPT,
  'packages/resource-compiler/src/transformer/transformer.ts': PROJECT_TYPESCRIPT,
};

describe('only the parse worker\'s closure imports a parser', () => {
  const { files, importers } = shippingImporters(parserImports, shippingCodeSources());
  const importersOf = (pattern: RegExp): string[] => [...importers]
    .filter(([, found]) => found.some((specifier) => pattern.test(specifier)))
    .map(([file]) => file);

  it('reads every shipped code file: CommonJS and ESM variants in src, and the ESLint rules, never the generated vendored copy', () => {
    expect([...files.keys()]).toEqual(expect.arrayContaining([
      'packages/resources/src/vendor/typescript.d.cts',
      'packages/utils/eslint/index.cjs',
      'packages/utils/eslint/rules/safe-import.cjs',
    ]));
    expect(files.has('packages/resources/src/vendor/typescript.cjs')).toBe(false);
  });

  it('finds the importers — at least the worker and the markdown composer', () => {
    expect([...importers.keys()]).toEqual(expect.arrayContaining([
      'packages/resources/src/parse-worker.ts',
      'packages/resources/src/link-parser.ts',
    ]));
  });

  it('every file that value-imports a parser module is listed, with why', () => {
    const unlisted = [...importers].filter(([file]) => ALLOWED[file] === undefined).map(([file, found]) => `${file} → ${found.join(', ')}`);
    expect(unlisted).toEqual([]);
  });

  it('every listed file still imports a parser module', () => {
    const stale = Object.keys(ALLOWED).filter((file) => !importers.has(file));
    expect(stale).toEqual([]);
  });

  it('no shipped src imports the conformance harness or the parser loader, but the worker the loader', () => {
    const harness = [...importers]
      .filter(([, found]) => found.some((specifier) => /parse-conformance(?:\.js)?$/.test(specifier)))
      .map(([file]) => file);
    expect(harness).toEqual([]);
    const loader = [...importers]
      .filter(([, found]) => found.some((specifier) => /parser-loader(?:\.js)?$/.test(specifier)))
      .map(([file]) => file);
    expect(loader).toEqual(['packages/resources/src/parse-worker.ts']);
  });

  it('no shipped src imports the harness memory reader but the parser loader', () => {
    const readers = [...importers]
      .filter(([, found]) => found.some((specifier) => /claude-memory(?:\.js)?$/.test(specifier)))
      .map(([file]) => file);
    expect(readers).toEqual(['packages/resources/src/parser-loader.ts']);
  });

  it('no shipped src imports the data extractor but the parser loader and the tsconfig parse, nor jsonc-parser or the YAML or .npmrc extractor but the extractor, nor ini but the .npmrc extractor', () => {
    expect(importersOf(/data-extractor(?:\.js)?$/).sort((left, right) => left.localeCompare(right))).toEqual([
      'packages/resources/src/parser-loader.ts',
      'packages/resources/src/projection/tsconfig-parse.ts',
    ]);
    expect(importersOf(/^jsonc-parser$/)).toEqual(['packages/resources/src/projection/data-extractor.ts']);
    expect(importersOf(/data-yaml(?:\.js)?$/)).toEqual(['packages/resources/src/projection/data-extractor.ts']);
    expect(importersOf(/data-ini(?:\.js)?$/)).toEqual(['packages/resources/src/projection/data-extractor.ts']);
    expect(importersOf(/^ini$/)).toEqual(['packages/resources/src/projection/data-ini.ts']);
  });

  it('no shipped src imports the vendored TypeScript but its loader, nor the loader but the tsconfig parse, nor the tsconfig parse but the parser loader', () => {
    expect(importersOf(VENDORED_TYPESCRIPT)).toEqual(['packages/resources/src/vendored-typescript.ts']);
    expect(importersOf(/vendored-typescript(?:\.js)?$/)).toEqual(['packages/resources/src/projection/tsconfig-parse.ts']);
    expect(importersOf(/tsconfig-parse(?:\.js)?$/)).toEqual(['packages/resources/src/parser-loader.ts']);
  });
});

describe('the detector', () => {
  it('sees value imports, re-exports and dynamic imports, and ignores type-only ones', () => {
    const body = [
      "import { parse } from 'parse5';",
      "import type { Root } from 'mdast';",
      "import { type ParseResult } from './link-parser.js';",
      "export { remarkParser } from './remark-parser.js';",
      "const m = await import('./html-link-parser.js');",
      "import 'micromark';",
    ].join('\n');
    expect(parserImports(body)).toEqual(['parse5', './remark-parser.js', './html-link-parser.js', 'micromark']);
  });

  it('sees a createRequire load, and ignores a type-only import of the same library', () => {
    const body = [
      "import type * as JsoncParser from 'jsonc-parser';",
      "const jsonc = createRequire(import.meta.url)('jsonc-parser') as typeof JsoncParser;",
      "const other = createRequire(import.meta.url)('semver');",
    ].join('\n');
    expect(parserImports(body)).toEqual(['jsonc-parser']);
  });

  it('sees a createRequire result bound to a name and called later, and ignores a call of any other name', () => {
    const body = [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "let load = createRequire(__filename);",
      "const ts = require('typescript');",
      "const md = load('markdown-it');",
      "const other = somethingElse('parse5');",
    ].join('\n');
    expect(parserImports(body)).toEqual(['typescript', 'markdown-it']);
  });

  it('sees a bare require and an import-equals require in a CommonJS body, but not require.resolve', () => {
    const cjs = [
      "const ts = require('typescript');",
      "const where = require.resolve('parse5');",
      "const path = require('node:path');",
    ].join('\n');
    expect(parserImports(cjs, 'rule.cjs')).toEqual(['typescript']);
    const cts = [
      "import ts = require('typescript');",
      "import type md = require('markdown-it');",
    ].join('\n');
    expect(parserImports(cts, 'loader.cts')).toEqual(['typescript']);
  });

  it('sees the vendored TypeScript and its loader, and the npm typescript, but no other relative typescript', () => {
    const body = [
      "const ts = (await import('./vendor/typescript.cjs')).default;",
      "const { loadVendoredTypeScript } = await import('./vendored-typescript.js');",
      "import { loadVendoredTypeScript as load } from '../vendored-typescript.js';",
      "import ts2 from 'typescript';",
      "import type ts3 from './vendor/typescript.cjs';",
      "import { a } from './typescript.js';",
      "import { b } from './docs/typescript.js';",
      "import eslint from 'typescript-eslint';",
    ].join('\n');
    expect(parserImports(body)).toEqual([
      './vendor/typescript.cjs',
      './vendored-typescript.js',
      '../vendored-typescript.js',
      'typescript',
    ]);
  });

  it('flags yaml only in a module that splits a --- block', () => {
    expect(parserImports("import yaml from 'yaml';\nconst c = yaml.stringify(x);")).toEqual([]);
    expect(parserImports("import yaml from 'yaml';\nwrite(`---\\n${yaml.stringify(x)}`);")).toEqual([]);
    expect(parserImports("import yaml from 'yaml';\nconst FENCE = /^---\\r?\\n/;")).toEqual(['yaml']);
    expect(parserImports("import yaml from 'yaml';\nif (s.startsWith('---\\n')) yaml.parse(s);")).toEqual(['yaml']);
  });
});
