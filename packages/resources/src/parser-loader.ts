/**
 * The parse worker's loader of the two parser modules — and the only route by
 * which any shipped code reaches them.
 *
 * ## Why this is its own module, imported by the worker alone
 *
 * A parse on the run's own thread cannot be stopped at a limit (ADR I8), so no
 * shipped code outside the worker's closure may load a parser at all (ADR I11:
 * one contract, the old path deleted). This module holds the `import()`s of
 * `link-parser.js` and `html-link-parser.js`, and of each harness's memory-file
 * reader (`projection/claude-memory.js`, the `marked` lexer and a frontmatter
 * decode), and of the `data` instance's extractor (`projection/data-extractor.js`,
 * which loads `jsonc-parser`), and of the tsconfig parse (`projection/tsconfig-parse.js`,
 * which loads the vendored TypeScript); `parse-worker.ts` is its only importer. `packages/dev-tools/test/parser-import-boundary.test.ts` holds that
 * from the tree, both ways.
 *
 * ## Why the load is DEFERRED
 *
 * The worker loads a kind's parser once it has been handed a document of that
 * kind — never at start-up — and a pool is built only on a parse-cache miss
 * (`parse-dispatcher.ts`). A fully warm run therefore starts no worker and
 * loads no parser: the remark stack costs ~730 ms of module load on Windows.
 * `packages/cli/test/integration/module-load-budget.integration.test.ts` is what
 * fails if a parser load reaches the parent thread again.
 *
 * ## How a load failure is kept off the documents
 *
 * Loading a parser is an INSTALL-level operation; parsing is a DOCUMENT-level
 * one. A per-document catch would otherwise blame a broken install on each
 * innocent file in turn (measured: 8 × `RESOURCE_UNREADABLE`, `filesScanned: 0`,
 * on `chmod 000` of the built parser). The import is wrapped in
 * `ParserUnavailableError` (`parse-cache.ts`), which wears a code no errno
 * allow-list holds; the worker sends that code back over the wire, and every
 * per-document catch rethrows it via `isParserUnavailable`.
 */

import type { ParseResult } from './link-parser.js';
import { memoizedLoad } from './memoized-load.js';
import type { DocumentParserKind } from './mime-type.js';
import { type ParserModuleKind, ParserUnavailableError } from './parse-cache.js';
import type { extractDataRows } from './projection/data-extractor.js';
import type { HarnessContentFacts, HarnessId } from './projection/harness/profile.js';
import type { TsconfigParse } from './projection/tsconfig-parse.js';

/**
 * The one thing a parser module contributes: content of a known byte length in,
 * parse facts out.
 */
interface LoadedParser {
  /**
   * @param content - The decoded document
   * @param sizeBytes - The RAW byte count of what was read, never a length
   *   derived from `content` — decoding is lossy on malformed UTF-8
   * @returns The parse facts for those bytes
   */
  parseContent(content: string, sizeBytes: number): ParseResult;
}

/** A harness's memory-file reader: what the harness does with one file's bytes. */
type HarnessReader = (raw: string) => HarnessContentFacts;

/**
 * In-flight or settled loads, one per kind. Memoizing the PROMISE (not the
 * module) is what makes concurrent first callers share a single import.
 */
const parserLoads = new Map<DocumentParserKind, Promise<LoadedParser>>();

/** In-flight or settled harness reader loads, one per harness, on {@link parserLoads}' terms. */
const harnessReaderLoads = new Map<HarnessId, Promise<HarnessReader>>();

/** The `data` instance's extractor: one JSON, JSONC or YAML file's text in, its row set out. */
type DataExtractor = typeof extractDataRows;

/** The in-flight or settled extractor load, on {@link parserLoads}' terms. */
const dataExtractorLoads = new Map<'data', Promise<DataExtractor>>();

/** The in-flight or settled tsconfig parse load, on {@link parserLoads}' terms. */
const tsconfigParseLoads = new Map<'typescript', Promise<TsconfigParse>>();

/** The tsconfig parse's module specifier, for the error message only. */
const TSCONFIG_PARSE_SPECIFIER = './projection/tsconfig-parse.js';

/**
 * The module specifier {@link importParser} loads for each kind, for the error
 * message only. The `import()` specifiers themselves must stay static literals —
 * a computed specifier is invisible to a bundler and to module mocking.
 * Compile-exhaustive over the kinds that HAVE a parser here; `typescript` is
 * loaded by `vendored-typescript.ts`, which owns its own specifier.
 */
const PARSER_MODULE_SPECIFIERS: Record<Exclude<ParserModuleKind, 'typescript'>, string> = {
  html: './html-link-parser.js',
  markdown: './link-parser.js',
  'claude-code': './projection/claude-memory.js',
  data: './projection/data-extractor.js',
};

/**
 * Load the parser for one kind, once per thread.
 *
 * A rejected load is dropped from the memo rather than retained: a loader
 * failure can be transient (`EMFILE` under fd pressure), and caching the
 * rejection would turn one bad moment into a dead worker.
 *
 * @param kind - Which parser to load
 * @returns The parser for that kind
 * @throws {ParserUnavailableError} If the parser module cannot be imported. The
 *   loader's own error is carried on `loaderError`, never re-thrown bare.
 */
export function loadParser(kind: DocumentParserKind): Promise<LoadedParser> {
  return memoizedLoad(parserLoads, kind, () => importParser(kind));
}

/**
 * Load a harness's memory-file reader, once per thread — the harness facts
 * lane's {@link loadParser}: the worker resolves the reader by the harness's
 * id, because a function cannot cross the thread boundary.
 *
 * @param harness - The harness whose reader to load
 * @returns Its reader
 * @throws {ParserUnavailableError} If the reader's module cannot be imported
 */
export function loadHarnessReader(harness: HarnessId): Promise<HarnessReader> {
  return memoizedLoad(harnessReaderLoads, harness, () => importHarnessReader(harness));
}

/**
 * Load the `data` instance's extractor, once per thread — the data job's
 * {@link loadParser}.
 *
 * @returns The extractor
 * @throws {ParserUnavailableError} If its module, or `jsonc-parser` under it, cannot be loaded
 */
export function loadDataExtractor(): Promise<DataExtractor> {
  return memoizedLoad(dataExtractorLoads, 'data', importDataExtractor);
}

/**
 * Load the tsconfig parse with the vendored TypeScript under it, once per thread — the tsconfig
 * job's {@link loadParser}.
 *
 * @returns The job, TypeScript loaded
 * @throws {ParserUnavailableError} If its module or the vendored TypeScript cannot be loaded, or
 *   TypeScript lacks an internal the parse calls
 */
export function loadTsconfigParser(): Promise<TsconfigParse> {
  return memoizedLoad(tsconfigParseLoads, 'typescript', importTsconfigParse);
}

/**
 * The `import()` of the tsconfig parse, then its own load of the vendored TypeScript, which throws
 * its own {@link ParserUnavailableError}.
 *
 * @returns The job
 * @throws {ParserUnavailableError} If either cannot be loaded
 */
async function importTsconfigParse(): Promise<TsconfigParse> {
  let loadTsconfigParse: () => Promise<TsconfigParse>;
  try {
    ({ loadTsconfigParse } = await import('./projection/tsconfig-parse.js'));
  } catch (error) {
    throw new ParserUnavailableError('typescript', TSCONFIG_PARSE_SPECIFIER, error);
  }
  return loadTsconfigParse();
}

/**
 * The `import()` of a harness's reader. One harness exists, so one static
 * specifier; a second harness adds its branch here, and {@link PARSER_MODULE_SPECIFIERS}
 * fails to compile until it does.
 *
 * @param harness - The harness whose reader to load
 * @returns Its reader
 * @throws {ParserUnavailableError} If the module cannot be imported
 */
async function importHarnessReader(harness: HarnessId): Promise<HarnessReader> {
  try {
    return (await import('./projection/claude-memory.js')).claudeMemoryFactsOf;
  } catch (error) {
    throw new ParserUnavailableError(harness, PARSER_MODULE_SPECIFIERS[harness], error);
  }
}

/**
 * The `import()` of the data extractor. The module loads `jsonc-parser` as it
 * evaluates, so a missing library fails here too, inside the `try`.
 *
 * @returns The extractor
 * @throws {ParserUnavailableError} If the module cannot be imported
 */
async function importDataExtractor(): Promise<DataExtractor> {
  try {
    return (await import('./projection/data-extractor.js')).extractDataRows;
  } catch (error) {
    throw new ParserUnavailableError('data', PARSER_MODULE_SPECIFIERS.data, error);
  }
}

/**
 * The `import()`s of a parser, and nothing else.
 *
 * The export read is INSIDE the callback, and so inside the `try`, deliberately:
 * a module can fail by throwing while it evaluates, which surfaces at the
 * destructure rather than at the `import()` itself.
 *
 * @param kind - Which parser to load
 * @returns The parser for that kind
 * @throws {ParserUnavailableError} If the module cannot be imported
 */
async function importParser(kind: DocumentParserKind): Promise<LoadedParser> {
  try {
    if (kind === 'html') return { parseContent: (await import('./html-link-parser.js')).parseHtmlContent };
    return { parseContent: (await import('./link-parser.js')).parseMarkdownContent };
  } catch (error) {
    throw new ParserUnavailableError(kind, PARSER_MODULE_SPECIFIERS[kind], error);
  }
}
