/**
 * The `data` instance's extractor, variant `yaml`: one YAML stream's text in,
 * its row set out (spec 5). Every expectation is absolute: a node is named by
 * its pointer (and document) and every column it carries is spelled out.
 */

import { describe, expect, it } from 'vitest';

import { DATA_OUTPUT_CAPS, DEFAULT_PARSE_LIMITS } from '../src/parse-limits.js';
import type { ExtractedDataNode, ExtractedDataRows } from '../src/projection/data-extractor.js';

import { extractUnder, nodeAt, REDEFINED_MEMBER_SHADOWING, rowsOf, scalarOf, shadowingOf } from './helpers/data-rows.js';

/** The rows of a YAML text. */
const yamlRows = (text: string): ExtractedDataRows => rowsOf(text, 'yaml');

/**
 * A row cap the caller names, so each stop walks to the cap the test sets rather than to the data
 * job's default (`DATA_OUTPUT_CAPS`), sixteen times as many rows.
 */
const NAMED_ROW_CAP = 10_000;

/** The extraction of a YAML text under the given caps, a data job's own where none is named. */
const yamlUnder = (text: string, limits: Parameters<typeof extractUnder>[1] = {}): ReturnType<typeof extractUnder> =>
  extractUnder(text, limits, 'yaml');

/** The structural columns of every node, in order. */
function shapeOf(rows: ExtractedDataRows): Pick<ExtractedDataNode, 'doc' | 'ordinal' | 'parent' | 'pointer' | 'key' | 'idx' | 'depth' | 'type' | 'childCount' | 'line' | 'column'>[] {
  return rows.nodes.map(({ doc, ordinal, parent, pointer, key, idx, depth, type, childCount, line, column }) => ({
    doc, ordinal, parent, pointer, key, idx, depth, type, childCount, line, column,
  }));
}

/** Each node's pointer with its `aliasOf`, `line` and `column`. */
function aliasesOf(rows: ExtractedDataRows): [string, number | null, number, number][] {
  return rows.nodes.map(({ pointer, aliasOf, line, column }) => [pointer, aliasOf, line, column]);
}

describe('extractDataRows yaml: scalars (the core schema)', () => {
  const rows = yamlRows([
    '- "1"', '- 1', '- 1.0', '- true', '- ~', '- null', '-', '- 0x1F', '- 0o17', '- +1', '- 1e3',
    '- .inf', '- -.inf', '- .nan', '- 9007199254740993', '- yes', '- on', '- -0',
  ].join('\n'));

  it('types every scalar by its core-schema value and keeps a number\'s source text', () => {
    const scalars = [...Array.from({ length: 18 }).keys()].map((index) => {
      const { type, value, lexeme } = scalarOf(rows, `/${String(index)}`);
      return [type, value, lexeme];
    });
    expect(scalars).toStrictEqual([
      ['string', '1', null], ['number', 1, '1'], ['number', 1, '1.0'], ['boolean', true, null],
      ['null', null, null], ['null', null, null], ['null', null, null],
      ['number', 31, '0x1F'], ['number', 15, '0o17'], ['number', 1, '+1'], ['number', 1000, '1e3'],
      ['number', Infinity, '.inf'], ['number', -Infinity, '-.inf'], ['number', Number.NaN, '.nan'],
      ['number', 9_007_199_254_740_992, '9007199254740993'],
      ['string', 'yes', null], ['string', 'on', null], ['number', 0, '-0'],
    ]);
    expect(Object.is(nodeAt(rows, '/17').value, 0)).toBe(true);
  });

  it('raises DATA_LOSSY_NUMBER at the non-finite numbers and at 2^53+1 only, naming the value each reads as', () => {
    expect(rows.conditions.map(({ seq, node, code, message, line, column }) => ({ seq, node, code, message, line, column }))).toStrictEqual([
      { seq: 0, node: 12, code: 'DATA_LOSSY_NUMBER', message: 'The number .inf is not exactly a double; it reads as Infinity.', line: 12, column: 3 },
      { seq: 1, node: 13, code: 'DATA_LOSSY_NUMBER', message: 'The number -.inf is not exactly a double; it reads as -Infinity.', line: 13, column: 3 },
      { seq: 2, node: 14, code: 'DATA_LOSSY_NUMBER', message: 'The number .nan is not exactly a double; it reads as NaN.', line: 14, column: 3 },
      { seq: 3, node: 15, code: 'DATA_LOSSY_NUMBER', message: 'The number 9007199254740993 is not exactly a double; it reads as 9007199254740992.', line: 15, column: 3 },
    ]);
  });

  it('calls a hex integer lossy exactly when the double does not hold it, and a signed or bare-dot decimal by its value', () => {
    const lossy = yamlRows('- 0x20000000000001\n- 0x20000000000000\n- +0.1\n- .5\n- 1.\n- 0o777777777777777777777');
    expect(lossy.conditions.map((condition) => condition.node)).toStrictEqual([
      nodeAt(lossy, '/0').ordinal,
      nodeAt(lossy, '/5').ordinal,
    ]);
  });
});

describe('extractDataRows yaml: nodes', () => {
  it('lists every node in pre-order with parent, key, idx, depth, childCount and its place', () => {
    const rows = yamlRows('a:\n  - b: 1\nc/~d: x\n');
    expect(shapeOf(rows)).toStrictEqual([
      { doc: 0, ordinal: 0, parent: null, pointer: '', key: null, idx: null, depth: 1, type: 'object', childCount: 2, line: 1, column: 1 },
      { doc: 0, ordinal: 1, parent: 0, pointer: '/a', key: 'a', idx: null, depth: 2, type: 'array', childCount: 1, line: 1, column: 1 },
      { doc: 0, ordinal: 2, parent: 1, pointer: '/a/0', key: null, idx: 0, depth: 3, type: 'object', childCount: 1, line: 2, column: 5 },
      { doc: 0, ordinal: 3, parent: 2, pointer: '/a/0/b', key: 'b', idx: null, depth: 4, type: 'number', childCount: 0, line: 2, column: 5 },
      { doc: 0, ordinal: 4, parent: 0, pointer: '/c~1~0d', key: 'c/~d', idx: null, depth: 2, type: 'string', childCount: 0, line: 3, column: 1 },
    ]);
    expect(rows.files).toStrictEqual([{ documents: 1, bom: false, nodeCount: 5, maxDepth: 3 }]);
    expect(rows.documents).toStrictEqual([{ doc: 0, rootType: 'object', nodeCount: 5, maxDepth: 3 }]);
    expect(rows.nodes.every((node) => node.tag === null && node.aliasOf === null && !node.shadowed)).toBe(true);
  });

  it('gives a key with no value a null node placed at the key', () => {
    const rows = yamlRows('{a, b: }');
    expect(nodeAt(rows, '/a')).toMatchObject({ type: 'null', value: null, line: 1, column: 2 });
    expect(nodeAt(rows, '/b')).toMatchObject({ type: 'null', value: null, line: 1, column: 5 });
  });

  it('counts CRLF, lone CR and LF as one break each, as the JSON variant does', () => {
    const rows = yamlRows('a: 1\r\nb: 2\rc:\n  - 3\r\n');
    expect(aliasesOf(rows).map(([pointer, , line, column]) => [pointer, line, column])).toStrictEqual([
      ['', 1, 1],
      ['/a', 1, 1],
      ['/b', 2, 1],
      ['/c', 3, 1],
      ['/c/0', 4, 5],
    ]);
  });
});

describe('extractDataRows yaml: documents', () => {
  it('numbers documents 0..n-1, each node and condition within its own, and sums the head row', () => {
    const rows = yamlRows('a: .inf\n---\n- x\n- [.nan]\n');
    expect(rows.files).toStrictEqual([{ documents: 2, bom: false, nodeCount: 6, maxDepth: 2 }]);
    expect(rows.documents).toStrictEqual([
      { doc: 0, rootType: 'object', nodeCount: 2, maxDepth: 1 },
      { doc: 1, rootType: 'array', nodeCount: 4, maxDepth: 2 },
    ]);
    expect(rows.nodes.map(({ doc, ordinal, pointer }) => [doc, ordinal, pointer])).toStrictEqual([
      [0, 0, ''], [0, 1, '/a'], [1, 0, ''], [1, 1, '/0'], [1, 2, '/1'], [1, 3, '/1/0'],
    ]);
    expect(rows.conditions.map(({ doc, seq, node, line }) => ({ doc, seq, node, line }))).toStrictEqual([
      { doc: 0, seq: 0, node: 1, line: 1 },
      { doc: 1, seq: 0, node: 3, line: 4 },
    ]);
  });

  it('answers an empty stream with a head row of no documents and nothing else', () => {
    for (const text of ['', '# only a comment\n']) {
      expect(yamlRows(text)).toStrictEqual({
        files: [{ documents: 0, bom: false, nodeCount: 0, maxDepth: 0 }],
        documents: [],
        nodes: [],
        conditions: [],
      });
    }
  });

  it('reads a document marker with no content as one null root', () => {
    const rows = yamlRows('---\n');
    expect(rows.documents).toStrictEqual([{ doc: 0, rootType: 'null', nodeCount: 1, maxDepth: 0 }]);
    expect(nodeAt(rows, '')).toMatchObject({ type: 'null', value: null, depth: 1, parent: null });
  });
});

describe('extractDataRows yaml: anchors and aliases (expanded, each copy marked)', () => {
  it('copies an anchored map at its alias: the alias row at its key, each descendant at its original', () => {
    const rows = yamlRows('base: &b\n  x: 1\n  y: [2]\ncopy: *b\n');
    expect(aliasesOf(rows)).toStrictEqual([
      ['', null, 1, 1],
      ['/base', null, 1, 1],
      ['/base/x', null, 2, 3],
      ['/base/y', null, 3, 3],
      ['/base/y/0', null, 3, 7],
      ['/copy', 1, 4, 1],
      ['/copy/x', 2, 2, 3],
      ['/copy/y', 3, 3, 3],
      ['/copy/y/0', 4, 3, 7],
    ]);
    expect(nodeAt(rows, '/copy')).toMatchObject({ type: 'object', childCount: 2, depth: 2, parent: 0 });
    expect(nodeAt(rows, '/copy/y/0')).toMatchObject({ value: 2, lexeme: '2', depth: 4 });
  });

  it('places an alias element at the alias', () => {
    expect(aliasesOf(yamlRows('- &a 5\n- *a\n'))).toStrictEqual([['', null, 1, 1], ['/0', null, 1, 6], ['/1', 1, 2, 3]]);
  });

  it('marks each row of a copy that holds a copy with the row it corresponds to, not the innermost anchor', () => {
    expect(aliasesOf(yamlRows('a: &x [1]\nb: &y [*x]\nc: *y\n')).map(([pointer, aliasOf]) => [pointer, aliasOf])).toStrictEqual([
      ['', null], ['/a', null], ['/a/0', null], ['/b', null], ['/b/0', 1], ['/b/0/0', 2], ['/c', 3], ['/c/0', 4], ['/c/0/0', 5],
    ]);
  });

  it('stores << literally as a key with its value, never merged', () => {
    const rows = yamlRows('base: &b {x: 1}\nm:\n  <<: *b\n  y: 2\n');
    expect(rows.nodes.map(({ pointer, key, aliasOf }) => [pointer, key, aliasOf])).toStrictEqual([
      ['', null, null], ['/base', 'base', null], ['/base/x', 'x', null], ['/m', 'm', null],
      ['/m/<<', '<<', 1], ['/m/<</x', 'x', 2], ['/m/y', 'y', null],
    ]);
    expect(rows.conditions).toStrictEqual([]);
  });

  it('stops an alias bomb at outputRows the moment its rows pass the cap, without allocating the expansion', () => {
    const levels = ['a0: &a0 [x, x, x, x, x, x, x, x, x]'];
    for (let level = 1; level <= 8; level += 1) {
      const below = `*a${String(level - 1)}`;
      levels.push(`a${String(level)}: &a${String(level)} [${Array.from({ length: 9 }, () => below).join(', ')}]`);
    }
    // Found one past the cap: the walk stopped the moment its rows passed it, never counting the 9^9 expansion.
    expect(yamlUnder(levels.join('\n'), { outputRows: NAMED_ROW_CAP })).toStrictEqual({ outcome: 'breach', limit: 'outputRows', found: NAMED_ROW_CAP + 1 });
  });

  it('stops a self-referencing anchor at outputDepth', () => {
    expect(yamlUnder('a: &a [*a]\n')).toStrictEqual({ outcome: 'breach', limit: 'outputDepth', found: DEFAULT_PARSE_LIMITS.outputDepth + 1 });
  });

  it('refuses an alias that names no anchor before it', () => {
    expect(yamlUnder('x: *nope\ny: &nope 1\n')).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_PARSE_ERROR',
      message: 'The alias *nope names no anchor before it at line 1, column 4',
    });
  });
});

describe('extractDataRows yaml: keys', () => {
  it('keys a member whose key is not a string by its source text, with one DATA_NON_STRING_KEY at it', () => {
    const rows = yamlRows('1: one\ntrue: t\n~: n\n? [a/b, c]\n: s\n');
    expect(rows.nodes.slice(1).map(({ pointer, key, value, line, column }) => ({ pointer, key, value, line, column }))).toStrictEqual([
      { pointer: '/1', key: '1', value: 'one', line: 1, column: 1 },
      { pointer: '/true', key: 'true', value: 't', line: 2, column: 1 },
      { pointer: '/~0', key: '~', value: 'n', line: 3, column: 1 },
      { pointer: '/[a~1b, c]', key: '[a/b, c]', value: 's', line: 4, column: 3 },
    ]);
    expect(rows.conditions).toStrictEqual(['1', 'true', '~', '[a/b, c]'].map((key, seq) => ({
      doc: 0,
      seq,
      node: seq + 1,
      code: 'DATA_NON_STRING_KEY',
      severity: 'warning',
      message: `The key ${JSON.stringify(key)} is not a string; the member is keyed by its source text.`,
      line: seq + 1,
      column: seq === 3 ? 3 : 1,
    })));
  });

  it('keeps every occurrence of a repeated key, shadows the earlier one and its descendants, and raises one condition', () => {
    const rows = yamlRows('a: {x: 1}\na: {y: 2}\n');
    expect(shadowingOf(rows)).toStrictEqual(REDEFINED_MEMBER_SHADOWING);
    expect(rows.conditions).toStrictEqual([{
      doc: 0,
      seq: 0,
      node: 3,
      code: 'DATA_DUPLICATE_KEY',
      severity: 'warning',
      message: 'The key "a" repeats in the object at the document root; the last occurrence wins.',
      line: 2,
      column: 1,
    }]);
  });
});

describe('extractDataRows yaml: tags', () => {
  it('records the explicit tag as yaml resolves it, and null where the source wrote none', () => {
    const rows = yamlRows('a: !!str 1\nb: !foo bar\nc: !!map {x: 1}\nd: plain\n');
    expect(rows.nodes.map(({ pointer, type, value, tag }) => ({ pointer, type, value, tag }))).toStrictEqual([
      { pointer: '', type: 'object', value: null, tag: null },
      { pointer: '/a', type: 'string', value: '1', tag: 'tag:yaml.org,2002:str' },
      { pointer: '/b', type: 'string', value: 'bar', tag: '!foo' },
      { pointer: '/c', type: 'object', value: null, tag: 'tag:yaml.org,2002:map' },
      { pointer: '/c/x', type: 'number', value: 1, tag: null },
      { pointer: '/d', type: 'string', value: 'plain', tag: null },
    ]);
  });

  it('applies no YAML 1.1 reading to a 1.1 tag: each keeps its source as a 1.2 core node, its tag recorded', () => {
    const tagged = (text: string): Pick<ExtractedDataNode, 'pointer' | 'type' | 'value' | 'tag'>[] =>
      yamlRows(text).nodes.slice(1).map(({ pointer, type, value, tag }) => ({ pointer, type, value, tag }));
    const yaml11 = (name: string): string => `tag:yaml.org,2002:${name}`;
    expect(tagged('a: !!binary aGVsbG8=\n')).toStrictEqual([{ pointer: '/a', type: 'string', value: 'aGVsbG8=', tag: yaml11('binary') }]);
    expect(tagged('a: !!timestamp 2001-12-14\n')).toStrictEqual([{ pointer: '/a', type: 'string', value: '2001-12-14', tag: yaml11('timestamp') }]);
    for (const name of ['omap', 'pairs']) {
      expect(tagged(`a: !!${name} [x: 1, x: 2]\n`)).toStrictEqual([
        { pointer: '/a', type: 'array', value: null, tag: yaml11(name) },
        { pointer: '/a/0', type: 'object', value: null, tag: null },
        { pointer: '/a/0/x', type: 'number', value: 1, tag: null },
        { pointer: '/a/1', type: 'object', value: null, tag: null },
        { pointer: '/a/1/x', type: 'number', value: 2, tag: null },
      ]);
    }
    // A set is a map whose values are null, under the tag it was written with; its members are never deduplicated.
    expect(tagged('a: !!set {x, y, x}\n')).toStrictEqual([
      { pointer: '/a', type: 'object', value: null, tag: yaml11('set') },
      { pointer: '/a/x', type: 'null', value: null, tag: null },
      { pointer: '/a/y', type: 'null', value: null, tag: null },
      { pointer: '/a/x', type: 'null', value: null, tag: null },
    ]);
  });
});

describe('extractDataRows yaml: defects', () => {
  it('refuses a %YAML directive naming any version but 1.2, and reads 1.2', () => {
    expect(yamlUnder('%YAML 1.1\n---\na: yes\n')).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_YAML_VERSION',
      message: 'The %YAML 1.1 directive names a version other than 1.2 at line 1, column 1',
    });
    expect(yamlUnder('a: 1\n...\n%YAML 1.1\n---\nb: 2\n')).toMatchObject({ outcome: 'defect', code: 'DATA_YAML_VERSION' });
    expect(scalarOf(yamlRows('%YAML 1.2\n---\na: yes\n'), '/a')).toStrictEqual({ type: 'string', value: 'yes', lexeme: null });
  });

  it('reads a %YAML directive whose version follows a tab, and leaves a reserved directive named %YAMLX to the library', () => {
    expect(scalarOf(yamlRows('%YAML\t1.2\n---\na: yes\n'), '/a')).toStrictEqual({ type: 'string', value: 'yes', lexeme: null });
    expect(yamlUnder('%YAML\t1.1\n---\na: 1\n')).toMatchObject({ outcome: 'defect', code: 'DATA_YAML_VERSION' });
    expect(scalarOf(yamlRows('%YAMLX 1.1\n---\na: yes\n'), '/a')).toStrictEqual({ type: 'string', value: 'yes', lexeme: null });
  });

  it('refuses malformed YAML naming the first error and where it is', () => {
    expect(yamlUnder('a: [1')).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_PARSE_ERROR',
      message: 'BAD_INDENT at line 1, column 6',
    });
    expect(yamlUnder('a: 1\r b: 2\n- c')).toMatchObject({ outcome: 'defect', code: 'DATA_PARSE_ERROR' });
  });

  it('refuses a string or a key holding a lone surrogate escape', () => {
    expect(yamlUnder(String.raw`a: "x\uD800"`)).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_LONE_SURROGATE',
      message: 'A string holds a lone UTF-16 surrogate at line 1, column 4',
    });
    expect(yamlUnder(String.raw`"\uDC00": 1`)).toStrictEqual({
      outcome: 'defect',
      code: 'DATA_LONE_SURROGATE',
      message: 'A key holds a lone UTF-16 surrogate at line 1, column 1',
    });
  });
});

describe('extractDataRows yaml: output caps', () => {
  it('breaches outputDepth one level past the bound, and not at it', () => {
    const nested = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;
    expect(yamlUnder(nested(3), { outputDepth: 3 })).toMatchObject({ outcome: 'rows' });
    expect(yamlUnder(nested(4), { outputDepth: 3 })).toStrictEqual({ outcome: 'breach', limit: 'outputDepth', found: 4 });
  });

  it('breaches outputRows over the whole row set', () => {
    // 3 nodes + 1 file + 1 document = 5 rows.
    expect(yamlUnder('[1, 2]', { outputRows: 5 })).toMatchObject({ outcome: 'rows' });
    expect(yamlUnder('[1, 2]', { outputRows: 4 })).toStrictEqual({ outcome: 'breach', limit: 'outputRows', found: 5 });
  });

  it('breaches outputBytes over the whole row set', () => {
    expect(yamlUnder('[1, 2]', { outputBytes: 64 })).toMatchObject({ outcome: 'breach', limit: 'outputBytes' });
  });

  it('stops a byte-amplifying alias at outputBytes while its rows are produced, never stringifying the expansion', () => {
    // A 10,000-character anchored string aliased 1,000 times: 10 MB of rows from a 15 KB text.
    const small = `a: &a ${'x'.repeat(10_000)}\nb: [${Array.from({ length: 1000 }, () => '*a').join(', ')}]\n`;
    const breach = yamlUnder(small, { outputBytes: 100_000 });
    expect(breach).toMatchObject({ outcome: 'breach', limit: 'outputBytes' });
    // Stopped within one copy of the cap, not at the whole expansion's size.
    expect((breach as { found: number }).found).toBeLessThan(100_000 + 20_000);
  });

  it('stops the 100 KB-string, 6,000-alias byte bomb at the default outputBytes', () => {
    const bomb = `a: &a ${'x'.repeat(100_000)}\nb:\n${'  - *a\n'.repeat(6000)}`;
    const breach = yamlUnder(bomb);
    expect(breach).toMatchObject({ outcome: 'breach', limit: 'outputBytes' });
    // Stopped within one copy of the cap, never at the 600 MB expansion.
    expect((breach as { found: number }).found).toBeLessThan(DATA_OUTPUT_CAPS.outputBytes + 200_000);
  });

  it('stops composing a stream once its documents alone pass outputRows', () => {
    // 500,000 empty documents: each is at least a document row and a node row.
    // Found one past the cap, not the 1,000,001 rows the whole stream would count.
    expect(yamlUnder('---\n'.repeat(500_000), { outputRows: NAMED_ROW_CAP })).toStrictEqual({
      outcome: 'breach',
      limit: 'outputRows',
      found: NAMED_ROW_CAP + 1,
    });
  });

  it('throws the composer\'s own stack exhaustion for the worker to report as the stack breach, never a parse error', () => {
    // Only under a depth cap looser than any run's can the composer meet nesting deep enough to overflow.
    const depth = 200_000;
    expect(() => yamlUnder(`${'['.repeat(depth)}${']'.repeat(depth)}`, { outputDepth: depth + 1 }))
      .toThrow(expect.objectContaining({ name: 'YAMLParseError', code: 'RESOURCE_EXHAUSTION' }));
  });

  it('breaches outputDepth on nesting the composer would recurse past, before composing it', () => {
    const depth = 50_000;
    for (const text of [`${'['.repeat(depth)}${']'.repeat(depth)}`, `${'- '.repeat(depth)}x\n`, `${'{a: '.repeat(depth)}1${'}'.repeat(depth)}`]) {
      expect(yamlUnder(text)).toStrictEqual({ outcome: 'breach', limit: 'outputDepth', found: DEFAULT_PARSE_LIMITS.outputDepth + 1 });
    }
  });
});
