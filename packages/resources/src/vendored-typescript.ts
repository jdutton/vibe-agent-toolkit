/**
 * The one loader of VAT's vendored TypeScript, and the only route by which any shipped code
 * reaches `./vendor/typescript.cjs`.
 *
 * ## Why a vendored copy, not the project's `typescript`
 *
 * Per-file rows are keyed by content alone, so the parser that produced them must be VAT code: a
 * TypeScript loaded from the adopter's tree would make rows depend on that tree's version. The copy
 * is `lib/typescript.js` of this package's exact-pinned `typescript` devDependency, written by
 * `build` (`packages/dev-tools/src/vendor-typescript.ts`) and shipped as a plain file in `dist/vendor/`.
 * It is never resolvable as `typescript`, so no hoist or override can swap it, and it ships inside
 * the package whose version the cache namespace reads (`cache-namespace.ts`): the TypeScript that
 * answered is identified by the VAT version. The project's own `typescript` is never loaded.
 *
 * ## Why `.cjs`
 *
 * `lib/typescript.js` is CommonJS and this package is `"type": "module"`, so under a `.js` name it
 * would import as an EMPTY module (no exports, no error). The `.cjs` extension states the format
 * wherever the file is copied, packed or unpacked; its `default` is `module.exports`, which is all
 * this loader reads. The committed `vendor/typescript.d.cts` types it.
 *
 * ## Threads
 *
 * TypeScript's parsers recurse on nesting, so a call over DOCUMENT bytes runs only in a parse worker,
 * at the worker's configured stack. The main thread may load it later for module resolution, which
 * reads strings and options only. Each thread loads it at most once.
 *
 * ## Deferred
 *
 * Importing this module loads no TypeScript (it imports only `parse-cache.js`): the `import()` is inside {@link loadVendoredTypeScript}, so a
 * run that needs no TypeScript never pays its load. Nothing imports this module yet; the parse
 * worker and module resolution are its intended callers.
 */

import { ParserUnavailableError } from './parse-cache.js';
import type ts from './vendor/typescript.cjs';

/** The vendored file, for the error message only; the `import()` below stays a static literal. */
const VENDORED_TYPESCRIPT_SPECIFIER = './vendor/typescript.cjs';

/** This thread's in-flight or settled load. Memoizing the PROMISE makes concurrent first callers share one import. */
let typescriptLoad: Promise<typeof ts> | undefined;

/**
 * Load VAT's vendored TypeScript, once per thread.
 *
 * A rejected load is dropped rather than retained, as `parser-loader.ts` does: a loader failure can
 * be transient (`EMFILE` under fd pressure), and caching it would make one bad moment permanent.
 *
 * @returns The TypeScript compiler API
 * @throws {ParserUnavailableError} If the vendored file cannot be imported (an install or build that
 *   never wrote it). The loader's own error is carried on `loaderError`.
 */
export function loadVendoredTypeScript(): Promise<typeof ts> {
  typescriptLoad ??= importVendoredTypeScript().catch((error: unknown) => {
    typescriptLoad = undefined;
    throw error;
  });
  return typescriptLoad;
}

/**
 * The `import()` of the vendored file, and nothing else. The `default` read is inside the `try`: a
 * module that throws while it evaluates fails there too.
 *
 * @returns The module's `default` (its `module.exports`)
 * @throws {ParserUnavailableError} If the file cannot be imported
 */
async function importVendoredTypeScript(): Promise<typeof ts> {
  try {
    return (await import('./vendor/typescript.cjs')).default;
  } catch (error) {
    throw new ParserUnavailableError('typescript', VENDORED_TYPESCRIPT_SPECIFIER, error);
  }
}
