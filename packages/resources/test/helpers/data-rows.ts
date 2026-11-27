/**
 * The `data` extractor's test accessors, shared by `data-extractor.test.ts`
 * (variants `json`, `jsonc`) and `data-yaml.test.ts` (variant `yaml`): every
 * expectation names a node by its pointer and spells out its columns.
 */

import { expect } from 'vitest';

import { DEFAULT_PARSE_LIMITS, type ParseLimits, resolveDataOutputCaps } from '../../src/parse-limits.js';
import {
  type DataExtraction,
  type ExtractedDataNode,
  type ExtractedDataRows,
  extractDataRows,
} from '../../src/projection/data-extractor.js';
import type { DataVariant } from '../../src/schemas/projection-data.js';

/**
 * The extraction of `text` under the caps a data job runs under when its caller names `limits`: a
 * named cap as named, an unnamed row or byte cap the data job's own (`resolveDataOutputCaps`).
 */
export function extractUnder(text: string, limits: Partial<ParseLimits>, variant: DataVariant = 'json'): DataExtraction {
  // Unvalidated, so a test can name a depth past the store's ceiling to reach the composer's stack.
  return extractDataRows({ text, variant, bom: false }, resolveDataOutputCaps(limits, { ...DEFAULT_PARSE_LIMITS, ...limits }));
}

/** The rows of `text`, failing the test if it was not extracted. */
export function rowsOf(text: string, variant: DataVariant = 'json', bom = false): ExtractedDataRows {
  const extraction = extractDataRows({ text, variant, bom }, resolveDataOutputCaps(undefined));
  if (extraction.outcome !== 'rows') throw new Error(`expected rows, got ${JSON.stringify(extraction)}`);
  return extraction.rows;
}

/** The node at `pointer` (in document `doc`), failing when there is not exactly one. */
export function nodeAt(rows: ExtractedDataRows, pointer: string, doc = 0): ExtractedDataNode {
  const found = rows.nodes.filter((node) => node.pointer === pointer && node.doc === doc);
  expect(found).toHaveLength(1);
  return found[0] as ExtractedDataNode;
}

/** Each node's pointer and whether it is shadowed, in order. */
export function shadowingOf(rows: ExtractedDataRows): [string, boolean][] {
  return rows.nodes.map(({ pointer, shadowed }) => [pointer, shadowed]);
}

/**
 * {@link shadowingOf} a root object whose member `a` is `{x: 1}` and then
 * `{y: 2}`: the earlier `/a` and its descendant are shadowed, the later not.
 */
export const REDEFINED_MEMBER_SHADOWING: readonly [string, boolean][] = [
  ['', false],
  ['/a', true],
  ['/a/x', true],
  ['/a', false],
  ['/a/y', false],
];

/** The scalar columns of the node at `pointer`. */
export function scalarOf(rows: ExtractedDataRows, pointer: string): Pick<ExtractedDataNode, 'type' | 'value' | 'lexeme'> {
  const { type, value, lexeme } = nodeAt(rows, pointer);
  return { type, value, lexeme };
}
