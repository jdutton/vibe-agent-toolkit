/**
 * A skill-text match's text as the store holds it, and back.
 *
 * A match's text is a slice of a line, and a slice can end (or, for a pattern
 * that matches code units, start) inside a surrogate pair: the imperative
 * family's 80-code-unit sample cuts a line whose 80th code unit is an emoji's
 * high surrogate, and the message built from it carries that lone surrogate.
 * SQLite stores TEXT as UTF-8, which has no encoding for a lone surrogate, so
 * `node:sqlite` writes it as U+FFFD and a warm message would differ from the
 * cold one. The store therefore holds the text well-formed (each lone surrogate
 * as U+FFFD, the SQL view unchanged) beside the position and code unit of each
 * lone surrogate it replaced, and the reader puts them back: the record read
 * from the store is the record the core computed, code unit for code unit.
 */

/** The lone surrogates a text held: each one's index and code unit, in index order. */
type LoneSurrogates = [index: number, codeUnit: number][];

/** U+FFFD, what `String#toWellFormed` writes for a lone surrogate. */
const REPLACEMENT = 0xff_fd;
const SURROGATE_FIRST = 0xd8_00;
const SURROGATE_LAST = 0xdf_ff;
/** The last code point one UTF-16 code unit spells. */
const BMP_LAST = 0xff_ff;

/**
 * @param unit - A UTF-16 code unit
 * @returns True for a surrogate of either half
 */
function isSurrogate(unit: number): boolean {
  return unit >= SURROGATE_FIRST && unit <= SURROGATE_LAST;
}

/**
 * The text's well-formed spelling and the lone surrogates it replaced.
 *
 * @param text - A match's text, as the core emitted it
 * @returns The text to store and its lone surrogates, `null` when there are none
 */
export function storedMatchText(text: string): { matchText: string; loneSurrogates: LoneSurrogates | null } {
  if (text.isWellFormed()) return { matchText: text, loneSurrogates: null };
  const lone: [number, number][] = [];
  let index = 0;
  while (index < text.length) {
    // A pair reads as one code point past the BMP; a lone surrogate reads as itself.
    const point = text.codePointAt(index) ?? REPLACEMENT;
    if (isSurrogate(point)) lone.push([index, point]);
    index += point > BMP_LAST ? 2 : 1;
  }
  return { matchText: text.toWellFormed(), loneSurrogates: lone };
}

/**
 * The text the core emitted, from its stored spelling: each lone surrogate put
 * back where the store wrote U+FFFD for it.
 *
 * @param matchText - The stored, well-formed text
 * @param loneSurrogates - The lone surrogates it replaced, or `null`
 * @returns The text, or `undefined` when the two cannot be what the writer wrote
 */
export function restoredMatchText(matchText: string, loneSurrogates: readonly (readonly [number, number])[] | null): string | undefined {
  if (loneSurrogates === null) return matchText;
  if (loneSurrogates.length === 0) return undefined;
  let restored = '';
  let from = 0;
  for (const [index, unit] of loneSurrogates) {
    if (index < from || !isSurrogate(unit) || matchText.codePointAt(index) !== REPLACEMENT) return undefined;
    restored += matchText.slice(from, index) + String.fromCodePoint(unit);
    from = index + 1;
  }
  return restored + matchText.slice(from);
}
