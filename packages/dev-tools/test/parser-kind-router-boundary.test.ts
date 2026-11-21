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
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { importIsTypeOnly, nodesOf, shippingImporters, sourceOf } from './typescript-ast.js';

/** The two names that, composed, decide a path's parser kind. */
const GUARDED: ReadonlySet<string> = new Set(['parserKindForMimeType', 'mimeTypeForPath']);

/** What a whole-module load (namespace, `export *`, dynamic import) is reported as. */
const WHOLE_MODULE = '*';

/** The files that may value-import a guarded name. */
const ALLOWED: readonly string[] = ['packages/resources/src/projection/router.ts'];

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
