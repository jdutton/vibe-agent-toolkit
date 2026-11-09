/**
 * The one way a message shows text it did not write. Every case is a character a terminal acts on
 * or a reader cannot see, and the assertion is both halves: the escape is there, and the raw
 * character is not. Escapes are spelled after a backslash built at run time, never in `String.raw`,
 * whose `\u` a transform may cook.
 */

import { describe, expect, it } from 'vitest';

import { shownName, visibleText } from '../src/shown-text.js';

const bs = '\\';

describe('visibleText', () => {
  it.for([
    ['ESC', 0x1b, 'u001b'],
    ['DEL', 0x7f, 'u007f'],
    ['a C1 CSI', 0x9b, 'u009b'],
    ['a soft hyphen', 0xad, 'u00ad'],
    ['a combining grapheme joiner', 0x3_4f, 'u034f'],
    ['a Hangul filler', 0x31_64, 'u3164'],
    ['a zero-width space', 0x20_0b, 'u200b'],
    ['a right-to-left override', 0x20_2e, 'u202e'],
    ['a line separator', 0x20_28, 'u2028'],
    ['a word joiner', 0x20_60, 'u2060'],
    ['an unassigned code point', 0x20_65, 'u2065'],
    ['a variation selector', 0xfe_0f, 'ufe0f'],
    ['a byte-order mark', 0xfe_ff, 'ufeff'],
    ['a private-use character', 0xe0_00, 'ue000'],
    ['a tag character', 0xe_00_41, 'u{e0041}'],
    ['a supplementary variation selector', 0xe_01_00, 'u{e0100}'],
    ['a no-break space', 0xa0, 'u00a0'],
    ['an en space', 0x20_02, 'u2002'],
    ['a Khmer inherent vowel', 0x17_b4, 'u17b4'],
    ['a braille pattern blank', 0x28_00, 'u2800'],
    ['a musical null notehead', 0x1_d1_59, 'u{1d159}'],
    ['a lone high surrogate', 0xd8_00, 'ud800'],
    ['a lone low surrogate', 0xdc_00, 'udc00'],
  ] as const)('shows %s by its escape', ([, code, spelled]) => {
    const character = String.fromCodePoint(code);
    const shown = visibleText(`a${character}b`);
    expect(shown).toBe(`a${bs}${spelled}b`);
    expect(shown).not.toContain(character);
  });

  it('shows at most 8192 characters of a flood, and counts the rest', () => {
    expect(visibleText(`${'c'.repeat(9000)}${String.fromCodePoint(0x1b)}`)).toBe(`${'c'.repeat(8192)}…[809 more characters]`);
  });

  it('leaves printable text, quotes and backslashes as they are', () => {
    expect(visibleText(String.raw`C:\Users\"é" 名前 🙂`)).toBe(String.raw`C:\Users\"é" 名前 🙂`);
  });
});

describe('shownName', () => {
  it('quotes a name, escaping its quotes and backslashes', () => {
    expect(shownName(String.raw`a"b\c`)).toBe(String.raw`"a\"b\\c"`);
  });

  it('shows bytes that are UTF-8 as the text they spell', () => {
    expect(shownName(Buffer.from('é.md'))).toBe('"é.md"');
  });

  it('shows bytes that are not UTF-8 byte for byte, valid sequences among them included', () => {
    expect(shownName(Buffer.from([0x61, 0xc3, 0xa9, 0xff, 0x22]))).toBe(`"a${bs}xc3${bs}xa9${bs}xff${bs}""`);
  });

  // A repository can make a link's text or a path megabytes long; the message stays bounded, and
  // says how much it left out.
  it.for([
    ['text', 'a'.repeat(1_000_000), `"${'a'.repeat(8192)}"…[991808 more characters]`],
    ['controls', String.fromCodePoint(1).repeat(1_000_000), `"${(bs + 'u0001').repeat(8192)}"…[991808 more characters]`],
    ['bytes that are not UTF-8', Buffer.alloc(1_000_000, 0xff), `"${(bs + 'xff').repeat(8192)}"…[991808 more bytes]`],
  ] as const)('shows at most 8192 of a flood of %s, and counts the rest', ([, flood, expected]) => {
    expect(shownName(flood)).toBe(expected);
  });

  it('shows a name of exactly 8192 characters whole', () => {
    expect(shownName('b'.repeat(8192))).toBe(`"${'b'.repeat(8192)}"`);
  });

  it('escapes what visibleText escapes', () => {
    expect(shownName(`x${String.fromCodePoint(0x1b)}`)).toBe(`"x${bs}u001b"`);
  });
});
