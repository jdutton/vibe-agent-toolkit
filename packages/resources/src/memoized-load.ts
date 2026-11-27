/**
 * The memoizing rule every deferred parser load follows, shared by `parser-loader.ts` and
 * `vendored-typescript.ts`. Its own module because `parser-loader.ts` may be imported by the parse
 * worker alone (`packages/dev-tools/test/parser-import-boundary.test.ts`), and this rule loads
 * nothing. Internal: not exported from the package index.
 */

import type { ParserModuleKind } from './parse-cache.js';

/**
 * Share an in-flight load, and drop a rejected one so a transient failure is retried.
 *
 * Memoizing the PROMISE (not the module) is what makes concurrent first callers share a single
 * import. A rejection is dropped rather than retained: a loader failure can be transient (`EMFILE`
 * under fd pressure), and caching it would turn one bad moment into a dead worker.
 *
 * @param loads - The loader's memo
 * @param kind - The module's kind
 * @param load - Imports it
 * @returns The memoized load
 */
export function memoizedLoad<Kind extends ParserModuleKind, Loaded>(
  loads: Map<Kind, Promise<Loaded>>,
  kind: Kind,
  load: () => Promise<Loaded>,
): Promise<Loaded> {
  const pending = loads.get(kind);
  if (pending !== undefined) return pending;

  const loading = load().catch((error: unknown) => {
    loads.delete(kind);
    throw error;
  });
  loads.set(kind, loading);
  return loading;
}
