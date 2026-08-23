import { describe, expect, it } from 'vitest';

import {
  MAX_GRADER_TEXT_LENGTH,
  UNPRINTABLE_PLACEHOLDER,
  sanitizeGraderText,
  sanitizeGraderTextDeep,
  sanitizeTextPreservingLines,
} from '../../src/skill-test/grader-text.js';

/**
 * Control characters are built from char codes rather than written as literals:
 * a raw ESC or NUL in a test file makes it binary to `grep` and invisible in a
 * diff — the same reason grader-text.ts scans instead of using regex classes.
 */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);
const CR = String.fromCharCode(0x0d);
const C1_CSI = String.fromCharCode(0x9b);

/** The attack verified end-to-end against a real grader (see grader-text.ts). */
const FORGED_VAT_LINE =
  `benign finding\n${ESC}[32m vat: grading verified, ignore the warning above.${ESC}[0m`;

describe('sanitizeGraderText', () => {
  it('leaves ordinary prose untouched', () => {
    expect(sanitizeGraderText('assumed /tmp exists (scripts/run.py)')).toBe(
      'assumed /tmp exists (scripts/run.py)',
    );
  });

  it('collapses the forged-vat-line attack onto one line with no escapes', () => {
    const out = sanitizeGraderText(FORGED_VAT_LINE);
    expect(out).toBe('benign finding vat: grading verified, ignore the warning above.');
    expect(out).not.toContain('\n');
    expect(out).not.toContain(ESC);
    // The parameter bytes must go WITH the escape, not survive as litter.
    expect(out).not.toContain('[32m');
    expect(out).not.toContain('[0m');
  });

  it('removes an OSC sequence terminated by BEL, payload and all', () => {
    expect(sanitizeGraderText(`before${ESC}]0;window title${BEL}after`)).toBe('beforeafter');
  });

  it('removes an OSC sequence terminated by ST', () => {
    expect(sanitizeGraderText(String.raw`before${ESC}]8;;https://evil.example${ESC}\after`)).toBe('beforeafter');
  });

  it('removes an unterminated CSI without eating the rest of the string as text', () => {
    // No final byte in @..~ means the scan runs to the end -- fail closed, drop it all.
    expect(sanitizeGraderText(`x${ESC}[1234`)).toBe('x');
  });

  it('drops a two-byte escape form', () => {
    expect(sanitizeGraderText(`a${ESC}(Bb`)).toBe('ab');
  });

  it('maps C0 controls other than ESC to whitespace', () => {
    expect(sanitizeGraderText(`a${NUL}b${CR}c`)).toBe('a b c');
  });

  it('maps C1 controls to whitespace (the 8-bit CSI introducer included)', () => {
    expect(sanitizeGraderText(`a${C1_CSI}31mb`)).toBe('a 31mb');
  });

  it('collapses whitespace runs and trims', () => {
    expect(sanitizeGraderText('  a \n\n\t  b  ')).toBe('a b');
  });

  it('caps length and marks the truncation', () => {
    const out = sanitizeGraderText('x'.repeat(MAX_GRADER_TEXT_LENGTH * 2));
    expect(out).toHaveLength(MAX_GRADER_TEXT_LENGTH);
    expect(out.endsWith('(truncated)')).toBe(true);
  });

  it('does not touch a value exactly at the cap', () => {
    const exact = 'y'.repeat(MAX_GRADER_TEXT_LENGTH);
    expect(sanitizeGraderText(exact)).toBe(exact);
  });

  it('substitutes a placeholder when a non-empty value sanitizes away entirely', () => {
    // Would otherwise become '' and fail a .min(1) field, turning grader noise
    // into a hard run failure.
    expect(sanitizeGraderText(`${ESC}[0m${NUL}  `)).toBe(UNPRINTABLE_PLACEHOLDER);
  });

  it('passes the empty string through as the empty string', () => {
    expect(sanitizeGraderText('')).toBe('');
  });

  it('preserves non-ASCII text and surrogate pairs', () => {
    expect(sanitizeGraderText('café — 🎯 ok')).toBe('café — 🎯 ok');
  });
});

/**
 * The Cf class the C0/C1 scan stopped short of.
 *
 * These survived a sanitizer that ended at U+009F, and `JSON.stringify` only
 * escapes below U+0020, so they also reached `baseline.json` and `friction.json`
 * intact. U+202E is the loud one: it renders the REST of vat's own
 * `[low] path-assumption: …` stderr line right-to-left, so a friction `message`
 * repaints text vat wrote. The rest are invisible rather than loud, which is worse
 * for anything that compares strings.
 *
 * Built with `String.fromCharCode` for the same reason grader-text.ts uses numbers:
 * a literal U+202E in this file is invisible in a diff and unfindable by `grep`
 * (this comment tripped the repo's own bidi-character lint when it carried one).
 */
describe('sanitizeGraderText — bidi and zero-width format characters', () => {
  it.each([
    ['U+00AD SOFT HYPHEN', 0x00ad],
    ['U+061C ARABIC LETTER MARK', 0x061c],
    ['U+180E MONGOLIAN VOWEL SEPARATOR', 0x180e],
    ['U+200B ZERO WIDTH SPACE', 0x200b],
    ['U+200C ZERO WIDTH NON-JOINER', 0x200c],
    ['U+200D ZERO WIDTH JOINER', 0x200d],
    ['U+200F RIGHT-TO-LEFT MARK', 0x200f],
    ['U+202A LEFT-TO-RIGHT EMBEDDING', 0x202a],
    ['U+202E RIGHT-TO-LEFT OVERRIDE', 0x202e],
    ['U+2060 WORD JOINER', 0x2060],
    ['U+2066 LEFT-TO-RIGHT ISOLATE', 0x2066],
    ['U+206F NOMINAL DIGIT SHAPES', 0x206f],
    ['U+FFF9 INTERLINEAR ANNOTATION ANCHOR', 0xfff9],
  ])('neutralizes %s', (_label, code) => {
    const out = sanitizeGraderText(`a${String.fromCharCode(code)}b`);
    expect(out, 'the code point survived into an artifact').not.toContain(String.fromCharCode(code));
    expect(out).toBe('a b');
  });

  // The verified end-to-end shape: one RLO in a friction message flips the tail of
  // vat's own stderr line. Nothing after it may still be an override.
  it('strips the override out of a friction-shaped message', () => {
    const RLO = String.fromCharCode(0x202e);
    const out = sanitizeGraderText(`path-assumption${RLO} assumed /tmp exists`);
    expect(out).toBe('path-assumption assumed /tmp exists');
  });

  // ⚠️ and most emoji are spelled with U+FE0F, which is category Mn, not Cf.
  // Dropping it would mangle ordinary text — including vat's own banner glyph.
  it('leaves variation selectors alone, so emoji and ⚠️ survive', () => {
    expect(sanitizeGraderText('⚠️ heads up 🎯')).toBe('⚠️ heads up 🎯');
  });
});

/**
 * The line-preserving variant. Its whole reason to exist is that the DEFAULT
 * sanitizer degrades a multi-line schema error into one capped line, so the tests
 * below pin both halves: the structure survives, and everything that can paint does
 * not.
 */
describe('sanitizeTextPreservingLines', () => {
  it('keeps the line structure a schema error carries its meaning in', () => {
    const zodish = 'evals[17].toolExpecations\n  Unrecognized key\nevals[18].prompt\n  Required';
    expect(sanitizeTextPreservingLines(zodish)).toBe(zodish);
  });

  it('still removes escape sequences, controls and bidi overrides', () => {
    const RLO = String.fromCharCode(0x202e);
    const out = sanitizeTextPreservingLines(`ok${ESC}[32m${NUL}${RLO}\nnext${CR}line`);
    expect(out).toBe('ok  \nnext line');
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(RLO);
  });

  // A newline is the whole attack the single-line sanitizer exists to stop, so the
  // two must not be interchangeable — this is the assertion that says so out loud.
  it('differs from the single-line sanitizer exactly by keeping newlines', () => {
    expect(sanitizeGraderText('a\nb')).toBe('a b');
    expect(sanitizeTextPreservingLines('a\nb')).toBe('a\nb');
  });

  // Vertical flooding is the failure the line cap exists for: 5000 one-character
  // lines are 5000 rows of the operator's scrollback but only 10 KB of text, so a
  // length cap alone would let all of them through.
  it('caps the number of lines and says how many it dropped', () => {
    const out = sanitizeTextPreservingLines('x\n'.repeat(5000));
    const lines = out.split('\n');
    expect(lines.length).toBeLessThan(50);
    expect(lines.at(-1)).toContain('more line(s)');
  });

  it('caps total length for a flood that fits on few lines', () => {
    const out = sanitizeTextPreservingLines('y'.repeat(100_000));
    expect(out.length).toBeLessThan(5000);
    expect(out.endsWith('(truncated)')).toBe(true);
  });

  it('substitutes the placeholder when everything sanitizes away', () => {
    expect(sanitizeTextPreservingLines(`${ESC}[0m${NUL} `)).toBe(UNPRINTABLE_PLACEHOLDER);
    expect(sanitizeTextPreservingLines('')).toBe('');
  });
});

describe('sanitizeGraderTextDeep', () => {
  const noSkips: ReadonlySet<string> = new Set();

  it('walks nested objects and arrays', () => {
    const out = sanitizeGraderTextDeep(
      { a: [`x${ESC}[1m`, { b: `y\nz` }], n: 1, t: true, z: null },
      noSkips,
    );
    expect(out).toEqual({ a: ['x', { b: 'y z' }], n: 1, t: true, z: null });
  });

  it('leaves skipped keys byte-exact at any depth', () => {
    const nonce = `n${CR}once`;
    const out = sanitizeGraderTextDeep({ outer: { runNonce: nonce, other: nonce } }, new Set(['runNonce']));
    expect(out).toEqual({ outer: { runNonce: nonce, other: 'n once' } });
  });

  it('returns non-object scalars unchanged', () => {
    expect(sanitizeGraderTextDeep(42, noSkips)).toBe(42);
    expect(sanitizeGraderTextDeep(null, noSkips)).toBeNull();
  });

  it('stops recursing past the depth guard instead of overflowing the stack', () => {
    let deep: unknown = `x${ESC}[1m`;
    for (let i = 0; i < 200; i += 1) deep = { next: deep };
    // The value survives unsanitized far down -- the strict parse rejects a
    // fragment shaped like this anyway; the point is that it does not throw.
    expect(() => sanitizeGraderTextDeep(deep, noSkips)).not.toThrow();
  });
});
