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
 * Importing this module loads no TypeScript (it imports only `parse-cache.js`, `memoized-load.js` and `node:url`): the `import()` is inside {@link loadVendoredTypeScript}, so a
 * run that needs no TypeScript never pays its load. Its one importer is the tsconfig parse
 * (`projection/tsconfig-parse.ts`), which the parse worker loads through `parser-loader.ts`;
 * `parser-import-boundary.test.ts` holds that list, both ways.
 */

import { fileURLToPath } from 'node:url';

import { memoizedLoad } from './memoized-load.js';
import { ParserUnavailableError } from './parse-cache.js';
import type ts from './vendor/typescript.cjs';

/** The vendored file, relative to this module, for the error message only; the `import()` below stays a static literal. */
const VENDORED_TYPESCRIPT_SPECIFIER = './vendor/typescript.cjs';

/**
 * The load failure, naming the vendored file by its ABSOLUTE path, so the message says where the file
 * should have been. Resolved only here, when the error is built: a load that succeeds never pays it.
 *
 * @param loaderError - The import's own failure, or one describing a wrong shape
 * @returns The error to throw
 */
function vendoredTypeScriptUnavailable(loaderError: unknown): ParserUnavailableError {
  const file = fileURLToPath(new URL(VENDORED_TYPESCRIPT_SPECIFIER, import.meta.url));
  return new ParserUnavailableError('typescript', file, loaderError);
}

/** This thread's in-flight or settled load, on `memoizedLoad`'s terms (one entry: the one kind). */
const typescriptLoads = new Map<'typescript', Promise<typeof ts>>();

/**
 * Load VAT's vendored TypeScript, once per thread.
 *
 * A rejected load is dropped rather than retained (`memoizedLoad`), so a transient failure is retried.
 *
 * @returns The TypeScript compiler API
 * @throws {ParserUnavailableError} If the vendored file cannot be imported (an install or build that
 *   never wrote it), or imports as something that is not TypeScript. The loader's own error, or one
 *   describing the shape, is carried on `loaderError`.
 */
export function loadVendoredTypeScript(): Promise<typeof ts> {
  return memoizedLoad(typescriptLoads, 'typescript', importVendoredTypeScript);
}

/**
 * The `import()` of the vendored file, and a check that what it held is TypeScript. The `default`
 * read is inside the `try`: a module that throws while it evaluates fails there too.
 *
 * The shape check is what keeps a broken file off the documents: a 0-byte or wrong-format file
 * imports WITHOUT error, as `{ default: {} }`, and the first caller's `ts.createSourceFile` would
 * then throw a `TypeError` inside a per-document catch, blaming each document in turn.
 *
 * @returns The module's `default` (its `module.exports`)
 * @throws {ParserUnavailableError} If the file cannot be imported, or its `default` lacks a
 *   `createSourceFile` function or a string `version`
 */
async function importVendoredTypeScript(): Promise<typeof ts> {
  let loaded: unknown;
  try {
    loaded = (await import('./vendor/typescript.cjs')).default;
  } catch (error) {
    throw vendoredTypeScriptUnavailable(error);
  }
  if (!isTypeScriptModule(loaded)) {
    const shapeError = new Error(
      'the file imported, but its default export has no createSourceFile function and string version ' +
        '(an empty, truncated or wrong-format file)',
    );
    throw vendoredTypeScriptUnavailable(shapeError);
  }
  return loaded;
}

/**
 * Whether an imported `default` is the TypeScript compiler API, by the two members every caller
 * relies on first.
 *
 * @param loaded - The module's `default`
 * @returns True when it has a `createSourceFile` function and a string `version`
 */
function isTypeScriptModule(loaded: unknown): loaded is typeof ts {
  const candidate = loaded as Partial<Record<'createSourceFile' | 'version', unknown>> | null | undefined;
  return typeof candidate?.createSourceFile === 'function' && typeof candidate.version === 'string';
}
