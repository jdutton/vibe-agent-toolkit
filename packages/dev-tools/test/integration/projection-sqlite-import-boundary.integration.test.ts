/**
 * Only the CLI imports the storage backend, `@vibe-agent-toolkit/projection-sqlite`: the rule
 * `local/projection-sqlite-import-boundary` says so at desk time, everywhere but the files
 * `PROJECTION_SQLITE_IMPORTERS` in `eslint.config.js` names.
 *
 * Two halves. The rule fires, through the repo's own config, on every import shape a file in
 * `resources` could use. And the exemption list is held both ways against the tree: every file
 * that imports the backend is exempt, and every exempt glob matches a file that imports it, so
 * a stale exemption fails here instead of standing open. Imports are found by parsing each file
 * (a comment or a string naming the package is not an import), never by matching text, and a
 * relative specifier counts when it resolves, against the importing file, into the backend's
 * package directory.
 *
 * Integration tier: it loads the repo's whole ESLint config and parses the tree.
 */

import { readFileSync } from 'node:fs';

import { resolveFromImportMeta, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { crawlDirectorySync } from '@vibe-agent-toolkit/utils/crawl';
import picomatch from 'picomatch';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { PROJECTION_SQLITE_IMPORTERS } from '../../../../eslint.config.js';
import { syntaxRuleLinter } from '../eslint-clean-files.js';

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..', '..');
const BACKEND = '@vibe-agent-toolkit/projection-sqlite';
/** The backend's package directory, repo-relative, as a resolved relative import lands in it. */
const BACKEND_DIRECTORY = 'packages/projection-sqlite/';
const RULE = 'local/projection-sqlite-import-boundary';

/** The extensions the rule is enabled for in `eslint.config.js`. */
const SCRIPT_EXTENSIONS = '{ts,cts,mts,js,cjs,mjs}';

const lint = syntaxRuleLinter(REPO_ROOT, [RULE]);

/** Every shape a module can name the backend in. */
const SHAPES: ReadonlyArray<readonly [shape: string, code: string]> = [
  ['a static import', `import { openSqliteFactStore } from '${BACKEND}';\nexport const open = openSqliteFactStore;\n`],
  ['an import type', `import type { RunDatabase } from '${BACKEND}';\nexport type Handle = RunDatabase;\n`],
  ['an import()', `export const load = (): Promise<unknown> => import('${BACKEND}');\n`],
  ['a type-position import', `export type Handle = import('${BACKEND}').RunDatabase;\n`],
  ['an export-from', `export { openRunDatabase } from '${BACKEND}';\n`],
  ['a relative import of its source', "import { openRunDatabase } from '../../../projection-sqlite/src/run-database.js';\nexport const open = openRunDatabase;\n"],
  ['a relative import type of its barrel', "import type { RunDatabase } from '../../../projection-sqlite/src/index.js';\nexport type Handle = RunDatabase;\n"],
];

/** The module specifier of every import, re-export, `import()`, `import('…').T` and `require('…')` in `text`. */
function specifiersOf(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteralLike(argument)) found.push(argument.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Whether `specifier`, imported from the repo-relative `file`, names the backend: by its package
 * name, or by a relative path that resolves into the backend's package directory.
 */
function namesBackend(file: string, specifier: string): boolean {
  if (specifier === BACKEND || specifier.startsWith(`${BACKEND}/`)) return true;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  const resolved = safePath.relative(REPO_ROOT, safePath.resolve(REPO_ROOT, file, '..', specifier));
  return toForwardSlash(resolved).startsWith(BACKEND_DIRECTORY);
}

/** Every script under a package's `src` or `test` that imports the backend, repo-relative. */
function backendImporters(): string[] {
  const files = crawlDirectorySync({
    outputs: [],
    baseDir: REPO_ROOT,
    include: [`packages/*/src/**/*.${SCRIPT_EXTENSIONS}`, `packages/*/test/**/*.${SCRIPT_EXTENSIONS}`],
    includeUntracked: true,
    absolute: false,
    unreadable: { refuse: { root: REPO_ROOT, remedy: 'Fix the directory permissions and re-run.', side: 'source' } },
  });
  return files
    .map((file) => toForwardSlash(file))
    .filter((file) => {
      const text = readFileSync(safePath.join(REPO_ROOT, file), 'utf-8');
      // A file that never spells the package's name, scoped or as a directory, cannot import it;
      // the parse decides for the rest.
      return text.includes('projection-sqlite') && specifiersOf(file, text).some((specifier) => namesBackend(file, specifier));
    });
}

describe('the projection-sqlite import boundary', () => {
  it.each(SHAPES)('fires on %s in resources', async (_shape, code) => {
    const findings = await lint('packages/resources/src/projection/second-backend.ts', code);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(`${RULE}: `);
  });

  it('is silent in the one CLI module that injects the backend', async () => {
    const [, code] = SHAPES[0] ?? ['', ''];
    expect(await lint('packages/cli/src/utils/projection-store.ts', code)).toEqual([]);
  });

  it('exempts exactly the files that import the backend, both ways', () => {
    const importers = backendImporters();
    const matchers = PROJECTION_SQLITE_IMPORTERS.map((glob) => [glob, picomatch(glob)] as const);

    // Every importer is exempt (the lint says the same from the other side).
    expect(importers.filter((file) => !matchers.some(([, matches]) => matches(file)))).toEqual([]);
    // Every exemption is in use: a glob that matches no importer is a stale hole.
    expect(matchers.filter(([, matches]) => !importers.some((file) => matches(file))).map(([glob]) => glob)).toEqual([]);
  });

  it('finds imports by parsing, not by matching text', () => {
    const text = [
      `// import { x } from '${BACKEND}';`,
      `export const name = '${BACKEND}';`,
      `import type { A } from '${BACKEND}';`,
      `export const load = () => import('${BACKEND}');`,
      `export type B = import('${BACKEND}').RunDatabase;`,
    ].join('\n');
    expect(specifiersOf('probe.ts', text)).toEqual([BACKEND, BACKEND, BACKEND]);
  });

  it('counts a relative path into the backend, and nothing beside it', () => {
    const file = 'packages/resources/src/projection/merge.ts';
    expect(namesBackend(file, '../../../projection-sqlite/src/run-database.js')).toBe(true);
    expect(namesBackend(file, '../../../projection-sqlite-extras/src/index.js')).toBe(false);
    expect(namesBackend(file, './projection-sqlite.js')).toBe(false);
  });
});
