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
    expect(measures.proseBytes + measures.codeBlockBytes).toBe(FENCED.length);
  });

  it('attributes the fenced block to codeBlockBytes and nothing else', () => {
    const [start, end] = fenceRange();
    expect(measureContent(FENCED, [fenceRange()]).codeBlockBytes).toBe(end - start);
  });

  it('counts zero code bytes for a document with no fences', () => {
    const measures = measureContent(PROSE, []);
    expect(measures.codeBlockBytes).toBe(0);
    expect(measures.proseBytes).toBe(PROSE.length);
  });

  it('counts words outside fences only', () => {
    // "# Title" -> 2, "Some prose here." -> 3. The fence body contributes none.
    expect(measureContent(FENCED, [fenceRange()]).wordCount).toBe(5);
  });

  it('does not double-count overlapping ranges', () => {
    // A range list is a set of spans; the sum is over their UNION, not over
    // their lengths. Nested code nodes make this reachable, not hypothetical.
    const measures = measureContent('abcdef', [[0, 4], [2, 6]]);
    expect(measures.codeBlockBytes).toBe(6);
    expect(measures.proseBytes).toBe(0);
  });
});

describe('parseMarkdownContent wiring', () => {
  it('carries contentMeasures whose byte split matches the document', () => {
    const measures = parseMarkdownContent(FENCED, FENCED.length).contentMeasures;
    expect(measures).toBeDefined();
    // `?? 0` rather than a non-null assertion (banned repo-wide). An absent
    // field therefore sums to 0, which still fails this assertion.
    expect((measures?.proseBytes ?? 0) + (measures?.codeBlockBytes ?? 0)).toBe(FENCED.length);
    expect(measures?.codeBlockBytes).toBeGreaterThan(0);
  });

  it('reports a fence-free document as all prose', () => {
    const result = parseMarkdownContent(PROSE, PROSE.length);
    expect(result.contentMeasures?.codeBlockBytes).toBe(0);
    expect(result.contentMeasures?.proseBytes).toBe(PROSE.length);
  });
});
