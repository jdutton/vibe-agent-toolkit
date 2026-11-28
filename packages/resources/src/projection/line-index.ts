/**
 * The one line index every row-set extractor places its rows with, so a line and a column mean the
 * same thing whichever instance and parser read the bytes.
 *
 * Line and column are 1-based, the column in UTF-16 code units, and CR, LF and CRLF are one break
 * each. U+2028 and U+2029 are NOT breaks: TypeScript's `getLineAndCharacterOfPosition` breaks there,
 * so it is never used for a position.
 */

const CR = 0x0d;
const LF = 0x0a;

/**
 * The offset each line starts at. CR, LF and CRLF are one break each.
 *
 * @param text - The document
 * @returns Line start offsets, ascending, the first 0
 */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    // A code point is read at every code-unit index; CR and LF are never part of a surrogate pair.
    const char = text.codePointAt(index);
    if (char === CR && text.codePointAt(index + 1) === LF) continue;
    if (char === CR || char === LF) starts.push(index + 1);
  }
  return starts;
}

/** A 1-based line and column (UTF-16 code units). */
interface Position {
  readonly line: number;
  readonly column: number;
}

/**
 * @param offset - A UTF-16 offset into the text
 * @param starts - {@link lineStarts} of the text
 * @returns Its 1-based line and column
 */
export function positionOf(offset: number, starts: readonly number[]): Position {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - (starts[low] as number) + 1 };
}
