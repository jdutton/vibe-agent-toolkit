/**
 * Shared helpers for the `ts` extractor's row tests: the vendored TypeScript loaded once per file,
 * a file's row set run in-process, and a needle's position in a text.
 */

import { beforeAll } from 'vitest';

import { DEFAULT_PARSE_LIMITS } from '../../src/parse-limits.js';
import { extractTsRows, type ExtractedTsRows } from '../../src/projection/ts-extractor.js';
import type { TsVariant } from '../../src/schemas/projection-ts.js';
import type ts from '../../src/vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../../src/vendored-typescript.js';

let loaded: typeof ts | undefined;

/** Load the vendored TypeScript before the calling test file's tests run. */
export function loadTypeScriptBeforeAll(): void {
  beforeAll(async () => {
    loaded = await loadVendoredTypeScript();
  });
}

/** @returns The TypeScript {@link loadTypeScriptBeforeAll} loaded */
export function vendoredTypeScript(): typeof ts {
  if (loaded === undefined) throw new Error('call loadTypeScriptBeforeAll() in the test file first');
  return loaded;
}

/**
 * @param text - The file's text, which must extract to rows
 * @param variant - Its variant
 * @returns Its row set
 */
export function tsRowsOf(text: string, variant: TsVariant = 'ts'): ExtractedTsRows {
  const extraction = extractTsRows(vendoredTypeScript(), { text, variant }, DEFAULT_PARSE_LIMITS);
  if (extraction.outcome !== 'rows') throw new Error(`expected rows, got ${JSON.stringify(extraction)}`);
  return extraction.rows;
}

/** The 1-based line and UTF-16 column of the first `needle` in a text with LF breaks only. */
export function at(text: string, needle: string): { line: number; column: number } {
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`no ${needle}`);
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: (before.at(-1) as string).length + 1 };
}
