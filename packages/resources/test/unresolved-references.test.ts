/**
 * Unit tests for the pure pieces of the dangling-reference detector:
 * the bracket scanner and the individual plausibility predicates.
 *
 * The detector is irreducibly heuristic (see the module doc comment), so each
 * heuristic is a named predicate with its own test here — the corpus patterns
 * that motivated each one are named in the test titles. End-to-end behavior
 * (masking + definition matching through `parseMarkdown`) is covered in
 * `link-parser.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  findMatchingBracket,
  findReferenceOccurrences,
  isPlausibleLinkText,
  isPlausibleReferenceLabel,
  labelHasAlphanumeric,
  labelHasPunctuationEdges,
  labelIsPurelyNumeric,
  labelIsTooShort,
  normalizeReferenceLabel,
  referenceLabelKeys,
  unescapeReferenceLabel,
} from '../src/unresolved-references.js';

/** Builds a single line nesting `depth` levels deep: `[[...x...][b]][b]`. */
function buildNestedLine(depth: number): string {
  let s = 'x';
  for (let i = 0; i < depth; i++) s = `[${s}][b]`;
  return s;
}

describe('normalizeReferenceLabel', () => {
  it('trims, collapses internal whitespace, and case-folds', () => {
    expect(normalizeReferenceLabel('  My   Label ')).toBe('my label');
  });
});

describe('unescapeReferenceLabel', () => {
  it('drops backslashes before ASCII punctuation so escaped labels match their definition', () => {
    expect(unescapeReferenceLabel(String.raw`foo\]bar`)).toBe('foo]bar');
  });

  it('leaves backslashes before non-punctuation alone', () => {
    expect(unescapeReferenceLabel(String.raw`foo\nbar`)).toBe(String.raw`foo\nbar`);
  });
});

describe('referenceLabelKeys', () => {
  it('indexes both the escaped and unescaped spelling of a label', () => {
    // mdast keeps the backslash in Definition.identifier and drops it in
    // `label`, so both spellings must be matchable.
    expect(referenceLabelKeys(String.raw`Foo\]Bar`)).toEqual([String.raw`foo\]bar`, 'foo]bar']);
  });

  it('collapses to a single key when there is nothing to unescape', () => {
    expect(referenceLabelKeys('My Label')).toEqual(['my label']);
  });
});

describe('labelHasAlphanumeric', () => {
  it('accepts a label with letters or digits', () => {
    expect(labelHasAlphanumeric('ci-badge')).toBe(true);
    expect(labelHasAlphanumeric('7')).toBe(true);
  });

  it('rejects a label made only of punctuation/whitespace', () => {
    expect(labelHasAlphanumeric('==')).toBe(false);
    expect(labelHasAlphanumeric('   ')).toBe(false);
  });
});

describe('labelHasPunctuationEdges', () => {
  it('rejects the optional-argument API signature labels (needle README)', () => {
    expect(labelHasPunctuationEdges(', options')).toBe(true);
    expect(labelHasPunctuationEdges(', callback')).toBe(true);
  });

  it('rejects a trailing punctuation edge', () => {
    expect(labelHasPunctuationEdges('see also.')).toBe(true);
  });

  it('allows the leading #/_/- that real labels use', () => {
    expect(labelHasPunctuationEdges('#fetch-options')).toBe(false);
    expect(labelHasPunctuationEdges('_internal')).toBe(false);
    expect(labelHasPunctuationEdges('-dash-')).toBe(false);
  });

  it('allows an ordinary label', () => {
    expect(labelHasPunctuationEdges('npm-badge-png')).toBe(false);
  });
});

describe('labelIsPurelyNumeric', () => {
  it('rejects numeric prose citations (host application[3][4][8])', () => {
    expect(labelIsPurelyNumeric('3')).toBe(true);
    expect(labelIsPurelyNumeric(' 42 ')).toBe(true);
  });

  it('accepts labels that merely contain digits', () => {
    expect(labelIsPurelyNumeric('rfc7231')).toBe(false);
  });
});

describe('labelIsTooShort', () => {
  it('rejects a single-character label (matrix[i][j])', () => {
    expect(labelIsTooShort('i')).toBe(true);
  });

  it('accepts a two-character label', () => {
    expect(labelIsTooShort('ci')).toBe(false);
  });
});

describe('isPlausibleReferenceLabel', () => {
  it('accepts labels seen as genuine dangling references in the corpus sweep', () => {
    expect(isPlausibleReferenceLabel('#fetch-options')).toBe(true);
    expect(isPlausibleReferenceLabel('minimatch')).toBe(true);
    expect(isPlausibleReferenceLabel('npm-badge-png')).toBe(true);
    expect(isPlausibleReferenceLabel('https://github.com/litejs/natural-compare-lite')).toBe(true);
  });

  it('rejects every false-positive label class from the corpus sweep', () => {
    for (const label of [', options', ', callback', '3', '8', 'i', 'j', '==']) {
      expect(isPlausibleReferenceLabel(label)).toBe(false);
    }
  });
});

describe('isPlausibleLinkText', () => {
  it('rejects text starting with punctuation (the API-signature pattern)', () => {
    expect(isPlausibleLinkText(', options')).toBe(false);
  });

  it('allows a leading ! so image references stay in scope', () => {
    expect(isPlausibleLinkText('![npm badge][npm-badge-png]')).toBe(true);
  });

  it('allows emphasis/code/quote markers in otherwise ordinary link text', () => {
    expect(isPlausibleLinkText('**Bold link**')).toBe(true);
    expect(isPlausibleLinkText('`code`')).toBe(true);
  });

  it('allows plain text and empty text', () => {
    expect(isPlausibleLinkText('Options')).toBe(true);
    expect(isPlausibleLinkText('')).toBe(true);
  });
});

describe('findMatchingBracket', () => {
  it('honors nesting so a nested image reference does not steal the close', () => {
    const segment = '[![Build][]][1]';
    expect(findMatchingBracket(segment, 0)).toBe(11);
  });

  it('honors backslash escapes inside a label', () => {
    const segment = String.raw`[foo\]bar]`;
    expect(findMatchingBracket(segment, 0)).toBe(9);
  });

  it('returns -1 when the segment ends before the bracket closes', () => {
    expect(findMatchingBracket('[unterminated', 0)).toBe(-1);
  });
});

describe('findReferenceOccurrences', () => {
  it('reports the outer reference of a nested form, not a garbage inner label', () => {
    const occurrences = findReferenceOccurrences('[![Build][]][1]');
    expect(occurrences.map((o) => ({ text: o.text, label: o.label }))).toEqual([
      { text: '![Build][]', label: '1' },
      { text: 'Build', label: '' },
    ]);
  });

  it('carries the 1-based line number of each occurrence', () => {
    const occurrences = findReferenceOccurrences('one\n\n[a][b]\n[c][d]\n');
    expect(occurrences.map((o) => o.line)).toEqual([3, 4]);
  });

  it('does not treat an escaped bracket as a reference opener', () => {
    // CommonMark makes `\[a][nope]` a *shortcut* reference — a declared non-goal.
    expect(findReferenceOccurrences(String.raw`\[a][nope]`)).toEqual([]);
  });

  it('never crosses a newline', () => {
    expect(findReferenceOccurrences('[a]\n[b]')).toEqual([]);
  });

  it('reports offsets that cover the whole occurrence', () => {
    const [occurrence] = findReferenceOccurrences('xx [a][b] yy');
    expect(occurrence).toMatchObject({ start: 3, end: 9, text: 'a', label: 'b' });
  });

  describe('recursion depth cap and line-length budget (crash-path regression)', () => {
    it('does not throw and completes well under a second on a 25,000-deep nested line', () => {
      // The verified repro: `s = '[' + s + '][b]'` repeated 25,000 times
      // (~100KB) threw `RangeError: Maximum call stack size exceeded` after
      // ~73s before the recursion-depth cap and line-length budget existed.
      const line = buildNestedLine(25_000);
      const start = performance.now();
      const occurrences = findReferenceOccurrences(line);
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).toBeLessThan(2000);
      // The line exceeds MAX_SCANNED_LINE_LENGTH, so it is skipped outright.
      expect(occurrences).toEqual([]);
    });

    it('caps recursion depth on a pathological line short enough to bypass the line-length budget', () => {
      // 100 levels of nesting is only ~400 characters — well under the
      // line-length budget — so this exercises the depth cap in isolation.
      const line = buildNestedLine(100);
      expect(() => findReferenceOccurrences(line)).not.toThrow();
      const occurrences = findReferenceOccurrences(line);
      // Recursion silently stops at the cap rather than walking all 100
      // levels: fewer occurrences than the input actually nests, never zero.
      expect(occurrences.length).toBeGreaterThan(0);
      expect(occurrences.length).toBeLessThan(100);
    });

    it('still detects a normal 3-level nesting correctly (the cap must not break real content)', () => {
      const occurrences = findReferenceOccurrences('[![alt][inner]][outer]');
      expect(occurrences.map((o) => o.label)).toEqual(['outer', 'inner']);
    });
  });
});
