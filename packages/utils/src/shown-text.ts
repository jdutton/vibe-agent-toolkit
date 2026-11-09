/**
 * THE one way a refusal shows text it did not write — a path, a link's text, a name a repository
 * or an archive supplied, what a child process said — so the text can neither act on the
 * operator's terminal nor hide characters from whoever, human or model, reads the message.
 * (A grader's model-facing text is sanitized by `grader-text` in agent-skills — a different job:
 * it neutralizes what a model wrote for a model to read, and keeps the joiners an emoji needs.)
 * Each message site calls this itself, and no check finds one that forgets: see
 * `docs/contributing/known-defects.md`.
 *
 * Two spellings of one classification ({@link unshowable}):
 *
 * - {@link visibleText} — unquoted: each unshowable character as its escape, everything else
 *   (`"` and `\` included) as itself. For text already set off in a message, and for prose a
 *   process wrote.
 * - {@link shownName} — quoted, `"` and `\` escaped too, and bytes that are not UTF-8 spelled byte
 *   by byte. Unambiguous: two different names never show the same.
 */

import { decodeUtf8Exactly } from './text-content.js';

/** The backslash, which opens every escape. */
const BACKSLASH = '\\';

/**
 * The categories of character that must not reach a message as themselves, named by Unicode rather
 * than by a hand-kept list: a control (`Cc` — a terminal acts on C0, C1 and DEL), a format character
 * (`Cf` — bidirectional marks, zero-width and invisible characters, the tag characters that carry
 * hidden text to a model reading the message), a lone surrogate (`Cs` — it prints as U+FFFD, the
 * same as a real one), a line or paragraph separator, a private-use character, an unassigned code
 * point or noncharacter (`Cn` — what a later Unicode may make invisible). {@link UNSHOWABLE_RANGES}
 * adds the invisibles outside them.
 */
const UNSHOWABLE_CATEGORY = /^[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Co}\p{Cn}]$/u;

/** The invisibles {@link UNSHOWABLE_CATEGORY} does not name, as inclusive code-point ranges. */
const UNSHOWABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3_4f, 0x3_4f], // combining grapheme joiner
  [0x11_5f, 0x11_60], // Hangul choseong and jungseong fillers
  [0x31_64, 0x31_64], // Hangul filler
  [0xff_a0, 0xff_a0], // halfwidth Hangul filler
  [0xfe_00, 0xfe_0f], // variation selectors
  [0xe_01_00, 0xe_01_ef], // variation selectors supplement
];

/** Whether a character must not reach a message as itself — see {@link UNSHOWABLE_CATEGORY}. */
function unshowable(character: string, code: number): boolean {
  return UNSHOWABLE_CATEGORY.test(character) || UNSHOWABLE_RANGES.some(([low, high]) => code >= low && code <= high);
}

/** One character as itself, or — when {@link unshowable} — `\uHHHH` (`\u{HHHHH}` past the BMP). */
function visibleCharacter(character: string): string {
  const code = character.codePointAt(0) ?? 0;
  if (!unshowable(character, code)) return character;
  return code > 0xff_ff ? `${BACKSLASH}u{${code.toString(16)}}` : `${BACKSLASH}u${code.toString(16).padStart(4, '0')}`;
}

/** One character of {@link shownName}: `"` and `\` escaped, else {@link visibleCharacter}. */
function quotedCharacter(character: string): string {
  return character === '"' || character === BACKSLASH ? BACKSLASH + character : visibleCharacter(character);
}

/** One byte of {@link shownName}'s spelling of bytes that are not UTF-8: ASCII as {@link quotedCharacter}, the rest `\xHH`. */
function quotedByte(byte: number): string {
  return byte < 0x80 ? quotedCharacter(String.fromCodePoint(byte)) : `${BACKSLASH}x${byte.toString(16).padStart(2, '0')}`;
}

/**
 * Text as a message shows it unquoted: every character a terminal would act on, or a reader would
 * not see, as its escape (`\uHHHH`); every other character — `"` and `\` included — as itself.
 *
 * @param text - Text the message did not write
 * @returns The text, safe to print
 */
export function visibleText(text: string): string {
  return [...text].map((character) => visibleCharacter(character)).join('');
}

/**
 * A name as a message shows it: quoted, `"` and `\` escaped, every character {@link visibleText}
 * escapes escaped the same way. Given bytes, the text they spell when they are UTF-8; when they are
 * not, every byte at or above 0x80 as `\xHH` (valid sequences among them included), so the bytes
 * can be read back exactly.
 *
 * @param value - The name, as text or as the bytes it was read as
 * @returns The name, quoted and safe to print
 */
export function shownName(value: string | Uint8Array): string {
  if (typeof value === 'string') return `"${[...value].map((character) => quotedCharacter(character)).join('')}"`;
  const text = decodeUtf8Exactly(value);
  return text === undefined ? `"${[...value].map((byte) => quotedByte(byte)).join('')}"` : shownName(text);
}
