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
 * - the parser libraries themselves ({@link isParserLibrary});
 * - this repository's own parser modules in `resources` ({@link isParserModule}),
 *   reached by a relative import or a package subpath;
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


import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { packageSources } from './package-sources.js';

/** Packages that ship nothing to a user, so run no user's parse. */
const PRIVATE_PACKAGES = ['packages/dev-tools/', 'packages/lab/'] as const;

/** Parser libraries named exactly. */
const PARSER_LIBRARY_NAMES: ReadonlySet<string> = new Set(['remark', 'unified', 'marked']);

/** Prefixes of parser libraries and their parts (`remark-parse`, `mdast-util-…`, `micromark/lib/…`). */
const PARSER_LIBRARY_PREFIXES = ['remark-', 'mdast-', 'micromark', 'parse5', 'markdown-it'] as const;

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
]);

/** Whether `specifier` names a markdown or HTML parser library, or a part of one. */
function isParserLibrary(specifier: string): boolean {
  return PARSER_LIBRARY_NAMES.has(specifier) || PARSER_LIBRARY_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

/** Whether `specifier` reaches one of resources' own parser modules: relatively, or by the package subpath. */
function isParserModule(specifier: string): boolean {
  if (!specifier.startsWith('.') && !specifier.startsWith('@vibe-agent-toolkit/resources/')) return false;
  const base = specifier.slice(specifier.lastIndexOf('/') + 1);
  return PARSER_MODULES.has(base.endsWith('.js') ? base.slice(0, -'.js'.length) : base);
}

/** `body` as a TypeScript AST. Comments are trivia, so a JSDoc example is never an import. */
function sourceOf(body: string): ts.SourceFile {
  return ts.createSourceFile('module.ts', body, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
}

/** Every node of `source`, depth first. */
function nodesOf(source: ts.SourceFile): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
}

/** Whether an import clause loads nothing at runtime: `import type`, or `{ type A, type B }`. */
function importIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
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

/** The specifier a node value-loads — a value import, a re-export or a dynamic import — or undefined. */
function valueSpecifier(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    return importIsTypeOnly(node.importClause) ? undefined : node.moduleSpecifier.text;
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    return exportIsTypeOnly(node) ? undefined : node.moduleSpecifier.text;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const [argument] = node.arguments;
    return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
  }
  return undefined;
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
 * The parser modules `body` value-imports. `yaml` counts only in a module that
 * splits a `---` frontmatter block off a document — one that SEARCHES for the
 * delimiter. A module that only WRITES `---` (a YAML document's opener on
 * output) does not.
 */
function parserImports(body: string): string[] {
  const nodes = nodesOf(sourceOf(body));
  const frontmatter = nodes.some((node) => searchesForFence(node));
  return nodes
    .map((node) => valueSpecifier(node))
    .filter((specifier): specifier is string => specifier !== undefined)
    .filter((specifier) => isParserLibrary(specifier) || isParserModule(specifier) || (frontmatter && specifier === 'yaml'));
}

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
};

describe('only the parse worker\'s closure imports a parser', () => {
  const files = new Map(
    [...packageSources()]
      .filter(([file]) => !PRIVATE_PACKAGES.some((prefix) => toForwardSlash(file).startsWith(prefix)))
  );
  const importers = new Map([...files].map(([file, body]) => [file, parserImports(body)]).filter(([, found]) => found.length > 0) as Array<[string, string[]]>);

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

  it('flags yaml only in a module that splits a --- block', () => {
    expect(parserImports("import yaml from 'yaml';\nconst c = yaml.stringify(x);")).toEqual([]);
    expect(parserImports("import yaml from 'yaml';\nwrite(`---\\n${yaml.stringify(x)}`);")).toEqual([]);
    expect(parserImports("import yaml from 'yaml';\nconst FENCE = /^---\\r?\\n/;")).toEqual(['yaml']);
    expect(parserImports("import yaml from 'yaml';\nif (s.startsWith('---\\n')) yaml.parse(s);")).toEqual(['yaml']);
  });
});
