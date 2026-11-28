/**
 * The one line index every row-set extractor places its rows with: CR, LF and CRLF are one break each,
 * the column counts UTF-16 code units, and U+2028 / U+2029 are not breaks.
 */

import { describe, expect, it } from 'vitest';

import { lineStarts, positionOf } from '../src/projection/line-index.js';
import { loadVendoredTypeScript } from '../src/vendored-typescript.js';

/** The 1-based position of the first `needle` in `text`, by the shared index. */
function placeOf(text: string, needle: string): { line: number; column: number } {
  return positionOf(text.indexOf(needle), lineStarts(text));
}

describe('lineStarts', () => {
  it.each([
    ['LF', 'a\nb', [0, 2]],
    ['CR', 'a\rb', [0, 2]],
    ['CRLF as one break', 'a\r\nb', [0, 3]],
    ['a lone CR before LF-less text', 'a\r\r\nb', [0, 2, 4]],
    ['no break', 'abc', [0]],
    ['empty text', '', [0]],
    ['a trailing break', 'a\n', [0, 2]],
  ])('%s', (_name, text, expected) => {
    expect(lineStarts(text)).toEqual(expected);
  });

  it('does not break at U+2028 or U+2029', () => {
    expect(lineStarts('a b c')).toEqual([0]);
  });
});

describe('positionOf', () => {
  it('is 1-based on the first line', () => {
    expect(placeOf('abc', 'a')).toEqual({ line: 1, column: 1 });
  });

  it('places a character after each kind of break on the next line', () => {
    expect(placeOf('a\nb', 'b')).toEqual({ line: 2, column: 1 });
    expect(placeOf('a\rb', 'b')).toEqual({ line: 2, column: 1 });
    expect(placeOf('a\r\nb', 'b')).toEqual({ line: 2, column: 1 });
  });

  it('counts an astral character as two UTF-16 columns', () => {
    expect(placeOf('\u{1F600}x', 'x')).toEqual({ line: 1, column: 3 });
  });

  it('keeps the line across U+2028 and U+2029 and counts them as one column each', () => {
    expect(placeOf('a b c', 'b')).toEqual({ line: 1, column: 3 });
    expect(placeOf('a b c', 'c')).toEqual({ line: 1, column: 5 });
  });

  it('disagrees with TypeScript on U+2028 and U+2029, which is why TypeScript is not used', async () => {
    const typescript = await loadVendoredTypeScript();
    const text = 'a b c';
    const source = typescript.createSourceFile('x.ts', text, typescript.ScriptTarget.Latest);
    const theirs = source.getLineAndCharacterOfPosition(text.indexOf('c'));
    expect(theirs.line).toBe(2);
    expect(placeOf(text, 'c').line).toBe(1);
  });
});
