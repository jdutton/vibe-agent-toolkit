/**
 * The `data` instance's extractor: one JSON or JSONC document's bytes in, its
 * row set out (spec 4.2, 4.3). Every expectation is absolute: a node is named by
 * its pointer and every column it carries is spelled out.
 */

import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { DEFAULT_PARSE_LIMITS, type ParseLimits } from '../src/parse-limits.js';
import {
  type DataExtraction,
  type ExtractedDataNode,
  type ExtractedDataRows,
  extractDataRows,
} from '../src/projection/data-extractor.js';
import type { DataVariant } from '../src/schemas/projection-data.js';

/** The rows of `text`, failing the test if it was not extracted. */
function rowsOf(text: string, variant: DataVariant = 'json', bom = false): ExtractedDataRows {
  const extraction = extractDataRows({ text, variant, bom }, DEFAULT_PARSE_LIMITS);
  if (extraction.outcome !== 'rows') throw new Error(`expected rows, got ${JSON.stringify(extraction)}`);
  return extraction.rows;
}

/** The node at `pointer`, failing when there is not exactly one. */
function nodeAt(rows: ExtractedDataRows, pointer: string): ExtractedDataNode {
  const found = rows.nodes.filter((node) => node.pointer === pointer);
  expect(found).toHaveLength(1);
  return found[0] as ExtractedDataNode;
}

/** The scalar columns of the node at `pointer`. */
function scalarOf(rows: ExtractedDataRows, pointer: string): Pick<ExtractedDataNode, 'type' | 'value' | 'lexeme'> {
  const { type, value, lexeme } = nodeAt(rows, pointer);
  return { type, value, lexeme };
}

/** The extraction of `text` under `limits` over the defaults. */
function extractUnder(text: string, limits: Partial<ParseLimits>, variant: DataVariant = 'json'): DataExtraction {
  return extractDataRows({ text, variant, bom: false }, { ...DEFAULT_PARSE_LIMITS, ...limits });
}

describe('extractDataRows: scalars (the absolute table)', () => {
  const rows = rowsOf('["1", 1, 1.0, true, 9007199254740993, -0, null, 0.1]');

  it('keeps type, value and lexeme for every class', () => {
    expect(scalarOf(rows, '/0')).toStrictEqual({ type: 'string', value: '1', lexeme: null });
    expect(scalarOf(rows, '/1')).toStrictEqual({ type: 'number', value: 1, lexeme: '1' });
    expect(scalarOf(rows, '/2')).toStrictEqual({ type: 'number', value: 1, lexeme: '1.0' });
    expect(scalarOf(rows, '/3')).toStrictEqual({ type: 'boolean', value: true, lexeme: null });
    expect(scalarOf(rows, '/4')).toStrictEqual({ type: 'number', value: 9_007_199_254_740_992, lexeme: '9007199254740993' });
    expect(scalarOf(rows, '/6')).toStrictEqual({ type: 'null', value: null, lexeme: null });
    expect(scalarOf(rows, '/7')).toStrictEqual({ type: 'number', value: 0.1, lexeme: '0.1' });
  });

  it('keeps the sign of -0 only in the lexeme', () => {
    const negativeZero = scalarOf(rows, '/5');
    expect(negativeZero.lexeme).toBe('-0');
    expect(Object.is(negativeZero.value, 0)).toBe(true);
  });

  it('raises one DATA_LOSSY_NUMBER, at 2^53+1 only', () => {
    expect(rows.conditions).toStrictEqual([
      {
        doc: 0,
        seq: 0,
        node: nodeAt(rows, '/4').ordinal,
        code: 'DATA_LOSSY_NUMBER',
        severity: 'warning',
        message: 'The number 9007199254740993 is not exactly a double; it reads as 9007199254740992.',
        line: 1,
        column: 21,
      },
    ]);
  });

  it('calls a number past the double range lossy, and an exact exponent form exact', () => {
    const lossy = rowsOf('[1e400, 1e-400, 1E2, 100e-2, 0e99999, 12.50]');
    expect(lossy.conditions.map((condition) => condition.node)).toStrictEqual([
      nodeAt(lossy, '/0').ordinal,
      nodeAt(lossy, '/1').ordinal,
    ]);
  });
});

describe('extractDataRows: nodes', () => {
  it('lists every node in pre-order, containers included, with parent, key, idx, depth and childCount', () => {
    const rows = rowsOf('{"a": [{"b": 1}], "c/~d": "x"}');
    expect(rows.nodes.map(({ ordinal, parent, pointer, key, idx, depth, type, childCount, shadowed }) => ({
      ordinal, parent, pointer, key, idx, depth, type, childCount, shadowed,
    }))).toStrictEqual([
      { ordinal: 0, parent: null, pointer: '', key: null, idx: null, depth: 1, type: 'object', childCount: 2, shadowed: false },
      { ordinal: 1, parent: 0, pointer: '/a', key: 'a', idx: null, depth: 2, type: 'array', childCount: 1, shadowed: false },
      { ordinal: 2, parent: 1, pointer: '/a/0', key: null, idx: 0, depth: 3, type: 'object', childCount: 1, shadowed: false },
      { ordinal: 3, parent: 2, pointer: '/a/0/b', key: 'b', idx: null, depth: 4, type: 'number', childCount: 0, shadowed: false },
      { ordinal: 4, parent: 0, pointer: '/c~1~0d', key: 'c/~d', idx: null, depth: 2, type: 'string', childCount: 0, shadowed: false },
    ]);
    expect(rows.nodes.every((node) => node.doc === 0)).toBe(true);
  });

  it('measures the deepest container: /a/0/b is depth 4 and the document maxDepth 3', () => {
    const rows = rowsOf('{"a": [{"b": 1}]}');
    expect(rows.files).toStrictEqual([{ documents: 1, bom: false, nodeCount: 4, maxDepth: 3 }]);
    expect(rows.documents).toStrictEqual([{ doc: 0, rootType: 'object', nodeCount: 4, maxDepth: 3 }]);
  });

  it('gives a scalar root maxDepth 0 and its one node depth 1', () => {
    const rows = rowsOf('42');
    expect(rows.files).toStrictEqual([{ documents: 1, bom: false, nodeCount: 1, maxDepth: 0 }]);
    expect(rows.documents).toStrictEqual([{ doc: 0, rootType: 'number', nodeCount: 1, maxDepth: 0 }]);
    expect(nodeAt(rows, '')).toMatchObject({ depth: 1, parent: null, value: 42, lexeme: '42', line: 1, column: 1 });
  });

  it('carries the BOM flag it is given into the file row, and nothing else changes', () => {
    const text = '{"a": 1}';
    const withBom = rowsOf(text, 'json', true);
    const without = rowsOf(text, 'json', false);
    expect(withBom.files[0]?.bom).toBe(true);
    expect({ ...withBom, files: [] }).toStrictEqual({ ...without, files: [] });
  });

  it('answers the same rows for the same bytes under json and jsonc', () => {
    const text = '{"a": [1, 2.5, "x"], "b": {"c": null}}';
    expect(rowsOf(text, 'jsonc')).toStrictEqual(rowsOf(text, 'json'));
  });
});

describe('extractDataRows: positions', () => {
  it('counts CRLF, lone CR and LF as one break each, and places a member at its key', () => {
    const rows = rowsOf('{\r\n"a": 1,\r"b":\n2,\n  "c": [\r\n3]}');
    expect(nodeAt(rows, '')).toMatchObject({ line: 1, column: 1 });
    expect(nodeAt(rows, '/a')).toMatchObject({ line: 2, column: 1 });
    expect(nodeAt(rows, '/b')).toMatchObject({ line: 3, column: 1 });
    expect(nodeAt(rows, '/c')).toMatchObject({ line: 5, column: 3 });
    expect(nodeAt(rows, '/c/0')).toMatchObject({ line: 6, column: 1 });
  });

  it('counts columns in UTF-16 code units: an astral key is two', () => {
    const rows = rowsOf('{"\u{1F600}": 1, "b": 2}');
    expect(nodeAt(rows, '/\u{1F600}')).toMatchObject({ line: 1, column: 2 });
    expect(nodeAt(rows, '/b')).toMatchObject({ line: 1, column: 11 });
  });
});

describe('extractDataRows: duplicate keys (last occurrence wins)', () => {
  it('keeps both /name nodes, shadows the first and raises one condition at the second', () => {
    const rows = rowsOf('{"name": "a",\n "name": "b"}');
    const names = rows.nodes.filter((node) => node.pointer === '/name');
    expect(names.map(({ value, shadowed }) => ({ value, shadowed }))).toStrictEqual([
      { value: 'a', shadowed: true },
      { value: 'b', shadowed: false },
    ]);
    expect(rows.conditions).toStrictEqual([
      {
        doc: 0,
        seq: 0,
        node: names[1]?.ordinal,
        code: 'DATA_DUPLICATE_KEY',
        severity: 'warning',
        message: 'The key "name" repeats in the object at the document root; the last occurrence wins.',
        line: 2,
        column: 2,
      },
    ]);
  });

  it('shadows every descendant of an earlier occurrence', () => {
    const rows = rowsOf('{"a": {"x": 1}, "a": {"y": 2}}');
    expect(rows.nodes.map(({ pointer, shadowed }) => [pointer, shadowed])).toStrictEqual([
      ['', false],
      ['/a', true],
      ['/a/x', true],
      ['/a', false],
      ['/a/y', false],
    ]);
    expect(rows.conditions.map((condition) => condition.code)).toStrictEqual(['DATA_DUPLICATE_KEY']);
  });

  it('shadows every grandchild of an earlier occurrence, under an array and under an object', () => {
    const shadowing = (text: string): (string | boolean)[][] =>
      rowsOf(text).nodes.map(({ pointer, shadowed }) => [pointer, shadowed]);
    expect(shadowing('{"a": [1, [2]], "a": 2}')).toStrictEqual([
      ['', false],
      ['/a', true],
      ['/a/0', true],
      ['/a/1', true],
      ['/a/1/0', true],
      ['/a', false],
    ]);
    expect(shadowing('{"a": {"b": {"c": 1}}, "a": 2}')).toStrictEqual([
      ['', false],
      ['/a', true],
      ['/a/b', true],
      ['/a/b/c', true],
      ['/a', false],
    ]);
  });

  it('names the object a nested key repeats in', () => {
    const rows = rowsOf('{"o": {"p": {"k": 1, "k": 2}}}');
    expect(rows.conditions.map(({ message }) => message)).toStrictEqual([
      'The key "k" repeats in the object at /o/p; the last occurrence wins.',
    ]);
  });

  it('raises one condition per occurrence after the first, numbered in pre-order with the other codes', () => {
    const rows = rowsOf('{"k": 1, "k": 9007199254740993, "o": {"k": 1}, "k": 3}');
    expect(rows.conditions.map(({ seq, code, node }) => ({ seq, code, node }))).toStrictEqual([
      { seq: 0, code: 'DATA_DUPLICATE_KEY', node: 2 },
      { seq: 1, code: 'DATA_LOSSY_NUMBER', node: 2 },
      { seq: 2, code: 'DATA_DUPLICATE_KEY', node: 5 },
    ]);
    expect(rows.nodes.filter((node) => node.pointer === '/k').map((node) => node.shadowed)).toStrictEqual([true, true, false]);
    expect(nodeAt(rows, '/o/k').shadowed).toBe(false);
  });
});

describe('extractDataRows: defects', () => {
  it('refuses a comment in a strict file and accepts it as jsonc', () => {
    const text = '{\n  // why\n  "a": 1,\n}';
    expect(extractUnder(text, {})).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_PARSE_ERROR',
      message: 'InvalidCommentToken at line 2, column 3',
    });
    expect(extractUnder(text, {}, 'jsonc')).toMatchObject({ outcome: 'rows' });
  });

  it('refuses a trailing comma in a strict file', () => {
    expect(extractUnder('[1,]', {})).toMatchObject({ outcome: 'defect', code: 'DATA_PARSE_ERROR' });
    expect(extractUnder('[1,]', {}, 'jsonc')).toMatchObject({ outcome: 'rows' });
  });

  it('refuses malformed input naming the first error and where it is', () => {
    expect(extractUnder('{"a": }', {})).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_PARSE_ERROR',
      message: 'ValueExpected at line 1, column 7',
    });
    expect(extractUnder('', {})).toMatchObject({ outcome: 'defect', code: 'DATA_PARSE_ERROR' });
  });

  it('refuses a closer that does not match the open container, before the parse recurses', () => {
    // Each `}` closes nothing a `[` opened: a count-only depth scan reads this as depth 1, while the
    // parser's error recovery skips the `}` and nests once per `[`, deep enough to overflow its stack.
    expect(extractUnder('[},'.repeat(100_000), {})).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_PARSE_ERROR',
      message: 'CloseBracketExpected at line 1, column 2',
    });
    expect(extractUnder('{"a": [1}', {})).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_PARSE_ERROR',
      message: 'CloseBracketExpected at line 1, column 9',
    });
    expect(extractUnder('{"a": 1]', {})).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_PARSE_ERROR',
      message: 'CloseBraceExpected at line 1, column 8',
    });
  });

  it('refuses a closer with nothing open', () => {
    expect(extractUnder('[]]', {})).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_PARSE_ERROR',
      message: 'EndOfFileExpected at line 1, column 3',
    });
    expect(extractUnder('}', {})).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_PARSE_ERROR',
      message: 'ValueExpected at line 1, column 1',
    });
  });
});

describe('extractDataRows: lone surrogates (no UTF-8 text holds them)', () => {
  it('refuses two keys that differ only by a lone surrogate, rather than storing two keys that collide as text', () => {
    expect(extractUnder(String.raw`{"name":"a","engines":{"node":">=22"},"\uD800":1,"\uD801":2}`, {})).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_LONE_SURROGATE',
      message: 'A key holds a lone UTF-16 surrogate at line 1, column 39',
    });
  });

  it('refuses a string value holding a lone surrogate, at the value', () => {
    expect(extractUnder(String.raw`{"a": "x\uDC00"}`, {})).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_LONE_SURROGATE',
      message: 'A string holds a lone UTF-16 surrogate at line 1, column 7',
    });
    expect(extractUnder(String.raw`["\uD83D"]`, {}, 'jsonc')).toMatchObject({ outcome: 'defect', code: 'DATA_LONE_SURROGATE' });
  });

  it('accepts an escaped surrogate pair, which is one well-formed code point', () => {
    // Built, not typed: an escaped pair typed into this file is normalized into the character itself.
    const slash = String.fromCodePoint(0x5c);
    const pair = `["${slash}uD83D${slash}uDE00"]`;
    expect(scalarOf(rowsOf(pair), '/0')).toStrictEqual({ type: 'string', value: '\u{1F600}', lexeme: null });
  });
});

describe('extractDataRows: output caps', () => {
  it('breaches outputRows over the whole row set', () => {
    // 3 nodes + 1 file + 1 document = 5 rows.
    expect(extractUnder('[1, 2]', { outputRows: 5 })).toMatchObject({ outcome: 'rows' });
    expect(extractUnder('[1, 2]', { outputRows: 4 })).toStrictEqual({ outcome: 'breach', limit: 'outputRows', found: 5 });
  });

  it('breaches outputBytes over the whole row set', () => {
    expect(extractUnder('[1, 2]', { outputBytes: 64 })).toMatchObject({ outcome: 'breach', limit: 'outputBytes' });
  });

  it('breaches outputDepth one level past the bound, and not at it', () => {
    const nested = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;
    expect(extractUnder(nested(3), { outputDepth: 3 })).toMatchObject({ outcome: 'rows' });
    expect(extractUnder(nested(4), { outputDepth: 3 })).toStrictEqual({ outcome: 'breach', limit: 'outputDepth', found: 4 });
  });

  it('measures depth before parsing: a 100k-deep array stops at outputDepth, closed or not, without recursing', () => {
    const depth = 100_000;
    const open = '['.repeat(depth);
    expect(extractUnder(`${open}${']'.repeat(depth)}`, {})).toStrictEqual({ outcome: 'breach', limit: 'outputDepth', found: depth });
    // Unclosed: a parse would report an error; the depth scan answers first.
    expect(extractUnder(open, {})).toStrictEqual({ outcome: 'breach', limit: 'outputDepth', found: depth });
    // Brackets inside a string or a comment are not nesting.
    expect(extractUnder(`/* ${open} */ "${open}"`, {}, 'jsonc')).toMatchObject({ outcome: 'rows' });
  });
});

describe('jsonc-parser', () => {
  it('is the pinned version, resolved from the extractor', () => {
    const fromExtractor = createRequire(new URL('../src/projection/data-extractor.ts', import.meta.url));
    expect((fromExtractor('jsonc-parser/package.json') as { version: string }).version).toBe('3.3.1');
  });
});
