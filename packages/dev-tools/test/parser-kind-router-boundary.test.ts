/**
 * One module answers "which parser reads this path": the projection router.
 *
 * ADR I4 (one router): the decision "path -> mime -> parser kind" was composed
 * at every site that needed it, each with its own override and null handling,
 * so a new parser instance had to be taught to each one. This test closes the
 * class from the tree: no `src` file of a shipping package VALUE-imports
 * `parserKindForMimeType` or `mimeTypeForPath` from `mime-type.ts`, except the
 * router in {@link ALLOWED}.
 *
 * A namespace import, `export *` or dynamic import of `mime-type` reaches both
 * names, so it counts as importing them. An `import type` (or a `type` name in
 * a specifier list) loads nothing at runtime and is never an importer;
 * `mime-type.ts` defines the two names and imports nothing from itself.
 *
 * {@link ALLOWED} is asserted both ways: every importer is listed, and every
 * listed file exists and still imports at least one of the two names.
 *
 * The private packages (`dev-tools`, `lab`) are out of scope, as in the parser
 * import boundary: they ship to no user.
 *
 * Each row-set instance's static routes are the router's too: the `data`
 * routes (`dataRoutingFor`, `dataRouteFor`) and the `ts` routes and its `dts`
 * rule (`tsRoutingFor`, `tsRouteDecision`, `tsVariantOf`, `isDeclarationName`)
 * are DEFINED only in the router (a function, a variable, a class or object
 * member, or an export renaming something else to one of those names), so a
 * caller can only import them from it. Asserted both ways like {@link ALLOWED}.
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { importIsTypeOnly, nodesOf, shippingImporters, sourceOf } from './typescript-ast.js';

/** The two names that, composed, decide a path's parser kind. */
const GUARDED: ReadonlySet<string> = new Set(['parserKindForMimeType', 'mimeTypeForPath']);

/** What a whole-module load (namespace, `export *`, dynamic import) is reported as. */
const WHOLE_MODULE = '*';

/** The projection router, the one module that composes a parser kind and the one that defines the data routes. */
const ROUTER = 'packages/resources/src/projection/router.ts';

/** The files that may value-import a guarded name. */
const ALLOWED: readonly string[] = [ROUTER];

/** The row-set instances' routing functions, which only {@link ROUTER} may define. */
const ROUTER_DEFINED: ReadonlySet<string> = new Set([
  'dataRoutingFor',
  'dataRouteFor',
  'tsRoutingFor',
  'tsRouteDecision',
  'tsVariantOf',
  'isDeclarationName',
]);

/** The identifier text of a declaration's name, or undefined for a computed or destructured one. */
function identifierName(name: ts.Node | undefined): string | undefined {
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

/** The name one node defines, when it is a definition: a declaration, a member, or an export renaming another binding. */
function definedName(node: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isClassDeclaration(node) ||
    ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)
  ) {
    return identifierName(node.name);
  }
  if (ts.isExportSpecifier(node) && node.propertyName !== undefined && node.propertyName.text !== node.name.text) {
    return identifierName(node.name);
  }
  return undefined;
}

/** The router-only names `body` defines, in source order. */
function routerOnlyDefinitions(body: string): string[] {
  return nodesOf(sourceOf(body)).map((node) => definedName(node)).filter((name) => name !== undefined && ROUTER_DEFINED.has(name)) as string[];
}

/** Whether `specifier` reaches resources' `mime-type` module: relatively, or by the package subpath. */
function isMimeTypeModule(specifier: string): boolean {
  if (!specifier.startsWith('.') && !specifier.startsWith('@vibe-agent-toolkit/resources/')) return false;
  return /(?:^|\/)mime-type(?:\.js)?$/.test(specifier);
}

/** The guarded names a list of import or export specifiers value-binds, by their name in `mime-type`. */
function guardedNamesOf(elements: ReadonlyArray<ts.ImportSpecifier | ts.ExportSpecifier>): string[] {
  return elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => (element.propertyName ?? element.name).text)
    .filter((name) => GUARDED.has(name));
}

/** The guarded names an import declaration from `mime-type` value-loads. */
function importedNames(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (clause === undefined || importIsTypeOnly(clause)) return [];
  const bindings = clause.namedBindings;
  if (bindings === undefined) return [];
  return ts.isNamespaceImport(bindings) ? [WHOLE_MODULE] : guardedNamesOf(bindings.elements);
}

/** The guarded names a re-export from `mime-type` value-loads. */
function reExportedNames(node: ts.ExportDeclaration): string[] {
  if (node.isTypeOnly) return [];
  const clause = node.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return [WHOLE_MODULE];
  return guardedNamesOf(clause.elements);
}

/** The literal text of a module specifier expression, or undefined. */
function literalText(expression: ts.Expression | undefined): string | undefined {
  return expression !== undefined && ts.isStringLiteralLike(expression) ? expression.text : undefined;
}

/** The guarded names one node value-loads from `mime-type`. */
function guardedLoads(node: ts.Node): string[] {
  if (ts.isImportDeclaration(node)) {
    return isMimeTypeModule(literalText(node.moduleSpecifier) ?? '') ? importedNames(node) : [];
  }
  if (ts.isExportDeclaration(node)) {
    return isMimeTypeModule(literalText(node.moduleSpecifier) ?? '') ? reExportedNames(node) : [];
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return isMimeTypeModule(literalText(node.arguments[0]) ?? '') ? [WHOLE_MODULE] : [];
  }
  return [];
}

/** The guarded names `body` value-loads from `mime-type`, in source order. */
function routerImports(body: string): string[] {
  return nodesOf(sourceOf(body)).flatMap((node) => guardedLoads(node));
}

describe('only the projection router composes a parser kind from a path', () => {
  const { files, importers } = shippingImporters(routerImports);

  it('every file that value-imports parserKindForMimeType or mimeTypeForPath is the router', () => {
    const unlisted = [...importers].filter(([file]) => !ALLOWED.includes(file)).map(([file, found]) => `${file} -> ${found.join(', ')}`);
    expect(unlisted).toEqual([]);
  });

  it('every listed file exists and still imports one of the two names', () => {
    const stale = ALLOWED.filter((file) => !importers.has(file)).map((file) => `${file} (${files.has(file) ? 'imports neither name' : 'does not exist'})`);
    expect(stale).toEqual([]);
  });
});

describe('only the projection router defines the row-set routes', () => {
  const { importers: definers } = shippingImporters(routerOnlyDefinitions);

  it('no file but the router defines a row-set route function', () => {
    const elsewhere = [...definers].filter(([file]) => file !== ROUTER).map(([file, found]) => `${file} -> ${found.join(', ')}`);
    expect(elsewhere).toEqual([]);
  });

  it('the router defines each, once', () => {
    expect([...(definers.get(ROUTER) ?? [])].sort((a, b) => a.localeCompare(b))).toEqual([...ROUTER_DEFINED].sort((a, b) => a.localeCompare(b)));
  });
});

describe('the router-only definition detector', () => {
  it('sees functions, variables, class and object members, and renaming exports', () => {
    const body = [
      'export function dataRouteFor() {}',
      'const dataRoutingFor = () => undefined;',
      'class R { dataRouteFor() {} static dataRoutingFor = 1; }',
      "const o = { dataRouteFor: () => undefined, 'dataRoutingFor': 1 };",
      'export { mine as dataRouteFor };',
    ].join('\n');
    expect(routerOnlyDefinitions(body)).toEqual(['dataRouteFor', 'dataRoutingFor', 'dataRouteFor', 'dataRoutingFor', 'dataRouteFor', 'dataRoutingFor', 'dataRouteFor']);
  });

  it('ignores imports, re-exports from the router, calls, shorthand uses, other names and comments', () => {
    const body = [
      "import { dataRouteFor, dataRoutingFor as routing } from './projection/router.js';",
      "export { dataRouteFor, dataRoutingFor } from './projection/router.js';",
      'const variant = dataRouteFor(path, routing(config));',
      'const o = { dataRouteFor };',
      'function parseRoutingFor() {}',
      '// export function dataRouteFor() {}',
      "const s = 'function dataRoutingFor() {}';",
    ].join('\n');
    expect(routerOnlyDefinitions(body)).toEqual([]);
  });
});

describe('the router-import detector', () => {
  it('sees value imports, aliases, re-exports, namespace and dynamic loads of mime-type', () => {
    const body = [
      "import { parserKindForMimeType } from './mime-type.js';",
      "import { mimeTypeForPath as typeOf, isTextMimeType } from '../mime-type.js';",
      "export { parserKindForMimeType } from '../mime-type.js';",
      "import * as mime from './mime-type.js';",
      "const m = await import('../../mime-type.js');",
    ].join('\n');
    expect(routerImports(body)).toEqual(['parserKindForMimeType', 'mimeTypeForPath', 'parserKindForMimeType', WHOLE_MODULE, WHOLE_MODULE]);
  });

  it('ignores type-only imports, other names, other modules and comments', () => {
    const body = [
      "import type { DocumentParserKind } from './mime-type.js';",
      "import { type DocumentParserKind as K, isTextMimeType } from '../mime-type.js';",
      "import { parserKindForMimeType } from './not-mime-type-at-all.js';",
      "// import { parserKindForMimeType } from './mime-type.js';",
      "/** import { mimeTypeForPath } from '../mime-type.js' */",
      "const s = \"import { parserKindForMimeType } from './mime-type.js'\";",
    ].join('\n');
    expect(routerImports(body)).toEqual([]);
  });
});
