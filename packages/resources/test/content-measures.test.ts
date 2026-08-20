/**
 * Unit tests for `measureContent` and its wiring into the markdown parser.
 *
 * `measureContent` is a pure function of a string and a range list, so it is
 * tested against hand-derived ranges — there is deliberately no exported
 * mdast-tree accessor, and none is to be added. The wiring is observed through
 * `parseMarkdownContent(...).contentMeasures`, which is the only supported way
 * to see the real fence ranges reach it.
 */

import { describe, expect, it } from 'vitest';

import { parseMarkdownContent } from '../src/link-parser.js';
import { measureContent } from '../src/projection/blob-facts.js';
import type { OffsetRange } from '../src/reference-lexer.js';

const PROSE = 'Some prose here.';
const FENCED = ['# Title', '', PROSE, '', '```ts', 'const x = 1;', '```', ''].join('\n');

/** The fenced block's offsets in FENCED, derived rather than hand-counted. */
function fenceRange(): OffsetRange {
  const start = FENCED.indexOf('```ts');
  return [start, FENCED.lastIndexOf('```') + 3];
}

describe('measureContent', () => {
  it('accounts for every character: prose + code === total length', () => {
    const measures = measureContent(FENCED, [fenceRange()]);
    expect(measures.proseCharacters + measures.codeBlockCharacters).toBe(FENCED.length);
  });

  it('attributes the fenced block to codeBlockCharacters and nothing else', () => {
    const [start, end] = fenceRange();
    expect(measureContent(FENCED, [fenceRange()]).codeBlockCharacters).toBe(end - start);
  });

  it('counts zero code characters for a document with no fences', () => {
    const measures = measureContent(PROSE, []);
    expect(measures.codeBlockCharacters).toBe(0);
    expect(measures.proseCharacters).toBe(PROSE.length);
  });

  it('counts words outside fences only', () => {
    // "# Title" -> 2, "Some prose here." -> 3. The fence body contributes none.
    expect(measureContent(FENCED, [fenceRange()]).wordCount).toBe(5);
  });

  it('does not double-count overlapping ranges', () => {
    // A range list is a set of spans; the sum is over their UNION, not over
    // their lengths. Nested code nodes make this reachable, not hypothetical.
    const measures = measureContent('abcdef', [[0, 4], [2, 6]]);
    expect(measures.codeBlockCharacters).toBe(6);
    expect(measures.proseCharacters).toBe(0);
  });

  it('counts CODE POINTS, not UTF-16 code units', () => {
    // '⭐' (U+2B50) is in the BMP: 1 code point, 1 UTF-16 code unit, 3 UTF-8 bytes.
    // '𝄞' (U+1D11E) is astral: 1 code point, 2 UTF-16 code units (a surrogate
    // pair), 4 UTF-8 bytes.
    const measures = measureContent('a⭐𝄞', []);

    // 3 characters. `.length` would say 4 (1 + 1 + 2 code units).
    expect(measures.proseCharacters).toBe(3);
    expect(measures.codeBlockCharacters).toBe(0);
  });

  it('partitions the content exactly, in code points', () => {
    const content = 'prose ⭐\n```\ncode 𝄞\n```\n';
    const start = content.indexOf('```');
    const end = content.lastIndexOf('```') + 3;
    const measures = measureContent(content, [[start, end]]);

    expect(measures.proseCharacters + measures.codeBlockCharacters).toBe([...content].length);
  });

  it('pins the fenced count directly, independent of the prose/total complement', () => {
    // The two tests above both assert `prose + codeBlock === total` (or count
    // only the un-fenced side). That equation holds algebraically no matter
    // what unit codeBlockCharacters is counted in, because proseCharacters is
    // defined as the complement `[...content].length - codeBlockCharacters` —
    // so neither test can ever catch codeBlockCharacters itself reverting to
    // code-unit arithmetic (`end - start`). This test pins the fenced count as
    // a literal, computed independently of measureContent.
    //
    // Fence body: "```\ncode 𝄞\n```" — 𝄞 (U+1D11E) is a surrogate pair, so the
    // body is 15 UTF-16 code units but 14 Unicode code points.
    const content = 'prose ⭐\n```\ncode 𝄞\n```\n';
    const start = content.indexOf('```');
    const end = content.lastIndexOf('```') + 3;
    const fenceBody = content.slice(start, end);
    expect(fenceBody.length).toBe(15); // code units, sanity-checking the fixture itself
    expect([...fenceBody].length).toBe(14); // code points — the value this test pins

    const measures = measureContent(content, [[start, end]]);
    expect(measures.codeBlockCharacters).toBe(14);
  });
});

describe('parseMarkdownContent wiring', () => {
  it('carries contentMeasures whose character split matches the document', () => {
    const measures = parseMarkdownContent(FENCED, FENCED.length).contentMeasures;
    expect(measures).toBeDefined();
    // `?? 0` rather than a non-null assertion (banned repo-wide). An absent
    // field therefore sums to 0, which still fails this assertion.
    expect((measures?.proseCharacters ?? 0) + (measures?.codeBlockCharacters ?? 0)).toBe(FENCED.length);
    expect(measures?.codeBlockCharacters).toBeGreaterThan(0);
  });

  it('reports a fence-free document as all prose', () => {
    const result = parseMarkdownContent(PROSE, PROSE.length);
    expect(result.contentMeasures?.codeBlockCharacters).toBe(0);
    expect(result.contentMeasures?.proseCharacters).toBe(PROSE.length);
  });
});
