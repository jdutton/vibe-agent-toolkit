/**
 * Unit tests for `measureContent` and its wiring into the markdown parser.
 *
 * `measureContent` is a pure function of a string and a range list, so it is
 * tested against hand-derived ranges — there is deliberately no exported
 * mdast-tree accessor, and none is to be added. The wiring is observed through
 * `parseMarkdownContent(...).contentMeasures`, which is the only supported way
 * to see the real fence ranges reach it.
 *
 * ⚠️ Every fixture here carries an ASTRAL character on purpose. `proseCodeUnits`
 * is DEFINED as the complement `content.length - codeBlockCodeUnits`, so
 * `prose + code === total` is an algebraic identity that no input can falsify —
 * the only way these tests can catch either column drifting to a code-POINT
 * count (`[...s].length`) is for the fixture to make code units, code points and
 * UTF-8 bytes three DIFFERENT numbers. A BMP character (⭐, é) is one UTF-16 code
 * unit and cannot do that; 🪤 (U+1FAA4) and 𝄞 (U+1D11E) are surrogate pairs and
 * can. The numeric literals below are the pins; do not replace them with
 * expressions computed the way production computes them.
 */

import { describe, expect, it } from 'vitest';

import { parseMarkdownContent } from '../src/link-parser.js';
import { measureContent } from '../src/projection/blob-facts.js';
import type { OffsetRange } from '../src/reference-lexer.js';

/** 19 UTF-16 code units, 18 code points, 21 UTF-8 bytes — all three differ. */
const PROSE = 'Some prose here 🪤.';
const PROSE_CODE_UNITS = 19;
const PROSE_CODE_POINTS = 18;

/** 59 UTF-16 code units, 57 code points, 63 UTF-8 bytes — all three differ. */
const FENCED = ['# Title', '', PROSE, '', '```ts', 'const x = 1; // 𝄞', '```', ''].join('\n');

/**
 * The fence body "```ts\nconst x = 1; // 𝄞\n```" is 28 UTF-16 code units but 27
 * code points, because 𝄞 is a surrogate pair. 28 is what `end - start` on the
 * fence offsets produces and what the column's name promises; 27 is what a
 * code-point count would report, so pinning both is what makes a drift between
 * them observable.
 */
const FENCE_CODE_UNITS = 28;
const FENCE_CODE_POINTS = 27;

/** The prose outside the fence: 31 code units (FENCED's 59, less the fence's 28). */
const FENCED_PROSE_CODE_UNITS = 31;

/** The fenced block's offsets in FENCED, derived rather than hand-counted. */
function fenceRange(): OffsetRange {
  const start = FENCED.indexOf('```ts');
  return [start, FENCED.lastIndexOf('```') + 3];
}

describe('measureContent', () => {
  it('counts prose as the summed code units of the segments outside the fences', () => {
    // Derived by SUMMING the prose segments, which is an independent route to
    // the answer: production reaches `proseCodeUnits` by subtracting
    // `codeBlockCodeUnits` from the total, so the two agree only when
    // `codeBlockCodeUnits` really is a code-unit count. Under a code-point
    // count this sum stays 31 while `proseCodeUnits` drops to 30.
    const [start, end] = fenceRange();
    const summed = [FENCED.slice(0, start), FENCED.slice(end)]
      .reduce((total, segment) => total + segment.length, 0);
    expect(summed).toBe(FENCED_PROSE_CODE_UNITS); // the fixture, sanity-checked

    expect(measureContent(FENCED, [fenceRange()]).proseCodeUnits).toBe(summed);
  });

  it('attributes the fenced block to codeBlockCodeUnits in code units, not code points', () => {
    const [start, end] = fenceRange();
    // The two numbers the fixture exists to separate. The code-point count is
    // asserted here as what the answer is NOT.
    const fenceBody = FENCED.slice(start, end);
    expect(end - start).toBe(FENCE_CODE_UNITS);
    expect([...fenceBody]).toHaveLength(FENCE_CODE_POINTS);

    expect(measureContent(FENCED, [fenceRange()]).codeBlockCodeUnits).toBe(FENCE_CODE_UNITS);
  });

  it('counts zero code units for a fence-free document, and its prose in code units', () => {
    const measures = measureContent(PROSE, []);
    expect([...PROSE]).toHaveLength(PROSE_CODE_POINTS); // what a code-point regression would report
    expect(measures.codeBlockCodeUnits).toBe(0);
    expect(measures.proseCodeUnits).toBe(PROSE_CODE_UNITS);
  });

  it('counts words outside fences only', () => {
    // "# Title" -> 2, "Some prose here 🪤." -> 4. The fence body contributes none.
    expect(measureContent(FENCED, [fenceRange()]).wordCount).toBe(6);
  });

  it('does not double-count overlapping ranges', () => {
    // A range list is a set of spans; the sum is over their UNION, not over
    // their lengths. Nested code nodes make this reachable, not hypothetical.
    const measures = measureContent('abcdef', [[0, 4], [2, 6]]);
    expect(measures.codeBlockCodeUnits).toBe(6);
    expect(measures.proseCodeUnits).toBe(0);
  });

  it('counts UTF-16 code units, not code points', () => {
    // '⭐' (U+2B50) is in the BMP: 1 code point, 1 UTF-16 code unit, 3 UTF-8 bytes.
    // '𝄞' (U+1D11E) is astral: 1 code point, 2 UTF-16 code units (a surrogate
    // pair), 4 UTF-8 bytes.
    const measures = measureContent('a⭐𝄞', []);

    // 4 code units. A code-point count would say 3; a UTF-8 byte count, 8.
    expect(measures.proseCodeUnits).toBe(4);
    expect(measures.codeBlockCodeUnits).toBe(0);
  });

  it('pins the fenced count of a document that is astral on BOTH sides of the fence', () => {
    // The fixture above carries its astral character only inside the fence.
    // This one puts one on each side, so a regression that changed the unit on
    // only one side cannot land on the right total by luck.
    //
    // Fence body: "```\ncode 𝄞\n```" — 15 UTF-16 code units, 14 code points.
    // ⚠️ Prose is 9 in EITHER unit here (the outside-the-fence astral is ⭐,
    // which is BMP), so the code column is the discriminating assertion and the
    // prose one is the partition check.
    const content = 'prose ⭐\n```\ncode 𝄞\n```\n';
    const start = content.indexOf('```');
    const end = content.lastIndexOf('```') + 3;
    // Sliced into a local first: a spread applied straight to `.slice(...)`
    // reads to `unicorn/no-useless-spread` as cloning an array, when it is a
    // string being spread into code points.
    const fenceBody = content.slice(start, end);
    expect([...fenceBody]).toHaveLength(14); // code points, the value this is NOT

    const measures = measureContent(content, [[start, end]]);
    expect(measures.codeBlockCodeUnits).toBe(15); // code units — the value this test pins
    expect(measures.proseCodeUnits).toBe(9); // "prose ⭐\n" (8) + "\n" (1)
  });
});

describe('parseMarkdownContent wiring', () => {
  it('carries contentMeasures whose fenced count is the real fence, in code units', () => {
    const measures = parseMarkdownContent(FENCED, Buffer.byteLength(FENCED)).contentMeasures;
    expect(measures).toBeDefined();
    // Pinned as literals rather than as `total - other`: the two fields are
    // complements of one another, so asserting their sum proves nothing.
    expect(measures?.codeBlockCodeUnits).toBe(FENCE_CODE_UNITS);
    expect(measures?.proseCodeUnits).toBe(FENCED_PROSE_CODE_UNITS);
  });

  it('reports a fence-free document as all prose, counted in code units', () => {
    const result = parseMarkdownContent(PROSE, Buffer.byteLength(PROSE));
    expect(result.contentMeasures?.codeBlockCodeUnits).toBe(0);
    expect(result.contentMeasures?.proseCodeUnits).toBe(PROSE_CODE_UNITS);
  });
});
