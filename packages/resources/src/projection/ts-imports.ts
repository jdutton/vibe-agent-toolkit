/**
 * The pure string rules behind the derived `ts_imports` relation: the facts of an import that depend on
 * the file's path or on the running Node, so they cannot be stored with the per-file rows. Posix string
 * folding only: no host, no cwd, no filesystem.
 */

import { isBuiltin } from 'node:module';

import { TS_INSTANCE, type TsImportRow, type TsImportsRow, type TsRouteRow } from '../schemas/projection-ts.js';

import { rowSetIdText, type RowSetIdText } from './row-set-id.js';

/** A posix separator. Specifiers are authored module text, never host paths: a backslash is not one. */
const SLASH = /\//;

/** `scheme:` prefix (RFC 3986 scheme). A drive letter reads as a scheme, so `C:/x` is not bare. */
const SCHEME_PREFIX = /^[A-Za-z][\d+.A-Za-z-]*:/;

/**
 * The npm package a bare specifier names: its first segment, or its first two when it starts with `@`.
 * A specifier is bare when it starts with none of `.`, `/`, `#` or a `scheme:`; NULL otherwise, `node:`
 * specifiers included. A drive letter (`C:/x`) reads as a scheme, so its package is NULL: no npm name
 * contains `:`, so the result still equals the dependency name for every string that can be one.
 */
export function bareSpecifierPackage(specifier: string): string | null {
  if (specifier === '' || '.#/'.includes(specifier.charAt(0)) || SCHEME_PREFIX.test(specifier)) {
    return null;
  }
  const segments = specifier.split(SLASH);
  const count = specifier.startsWith('@') ? 2 : 1;
  return segments.slice(0, count).join('/');
}

/** 1 when the specifier starts with `node:` or the running Node says it is a built-in module. */
export function isBuiltinSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:') || isBuiltin(specifier);
}

/**
 * A relative specifier (`.`, `..`, or starting `./` or `../`) folded against the importing file's
 * directory, by `.` and `..` segments only, on the posix string. A fold that climbs above the root keeps
 * its leading `..` segments (`../../x` from `a/b.ts` gives `../x`). An empty result is `.`. NULL for a
 * specifier that is not relative.
 */
export function lexicalTargetOf(path: string, specifier: string): string | null {
  const relative =
    specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
  if (!relative) {
    return null;
  }
  const folded = path.split(SLASH).slice(0, -1);
  for (const segment of specifier.split(SLASH)) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (folded.length > 0 && folded.at(-1) !== '..') {
        folded.pop();
      } else {
        folded.push('..');
      }
    } else {
      folded.push(segment);
    }
  }
  return folded.length === 0 ? '.' : folded.join('/');
}

/**
 * Build `ts_imports`: for each route whose pair is `facts`, in route order, its row set's
 * `ts__imports` rows in the order given (primary-key order), each with the facts its path and the
 * running Node decide. Pure: the stage hands it the routes and the imports it read through the run's
 * reader (store on) or holds in hand (store off), so both backings build it identically.
 *
 * @param routes - The run's `ts__routes` rows
 * @param imports - The `ts__imports` rows of the routed `facts` pairs
 * @returns The relation's rows
 */
export function tsImportsRows(routes: readonly TsRouteRow[], imports: readonly TsImportRow[]): TsImportsRow[] {
  const byPair = new Map<RowSetIdText, TsImportRow[]>();
  for (const row of imports) {
    const text = rowSetIdText({ contentKey: row.blob, instance: TS_INSTANCE, variant: row.variant });
    const held = byPair.get(text);
    if (held === undefined) byPair.set(text, [row]);
    else held.push(row);
  }
  return routes.flatMap((route) => {
    if (route.state !== 'facts' || route.blob === null) return [];
    const pairRows = byPair.get(rowSetIdText({ contentKey: route.blob, instance: TS_INSTANCE, variant: route.variant })) ?? [];
    return pairRows.map(({ blob: _blob, ...row }): TsImportsRow => ({
      root: route.root,
      path: route.path,
      ...row,
      package: row.specifier === null ? null : bareSpecifierPackage(row.specifier),
      builtin: row.specifier !== null && isBuiltinSpecifier(row.specifier),
      lexicalTarget: row.specifier === null ? null : lexicalTargetOf(route.path, row.specifier),
    }));
  });
}
