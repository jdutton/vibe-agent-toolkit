/**
 * Line-by-line raw-source scanning, shared by the raw-source scanners.
 *
 * Two scanners walk the source text itself rather than the AST —
 * `findReferenceOccurrences` (reference-style link brackets) and
 * `findLexicalReferences` (non-markdown reference tokens). Both need the same
 * traversal and the same pathological-input guard, and both need the line
 * number to come free from the loop rather than from an offset→line index or a
 * binary search. That shared shape lives here so there is one implementation of
 * it, not two that can drift.
 */

/**
 * Maximum line length (characters) scanned at all.
 *
 * An ordinary markdown line is at most a few hundred characters, so a line this
 * long is already pathological input, and skipping it protects against
 * adversarial or corrupted content regardless of *shape* — deeply nested
 * constructs and many sibling constructs on one enormous line are both bounded
 * by it. The skip is silent: no exception, no partial scan, the line simply
 * contributes nothing.
 *
 * In `unresolved-references.ts` this is the second of two independent guards,
 * alongside that module's nesting-depth limit.
 */
export const MAX_SCANNED_LINE_LENGTH = 10_000;

/**
 * Visit every scannable line of `content`, in document order.
 *
 * Lines longer than {@link MAX_SCANNED_LINE_LENGTH} are skipped silently and
 * `visit` is not called for them.
 *
 * @param content - Raw source text
 * @param visit - Called per line with the line's text (no trailing newline),
 *   the absolute offset that line starts at, and its 1-based line number
 */
export function forEachScannableLine(
  content: string,
  visit: (segment: string, lineStart: number, line: number) => void,
): void {
  let lineStart = 0;
  let line = 1;
  while (lineStart <= content.length) {
    const newlineIndex = content.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex;
    if (lineEnd - lineStart <= MAX_SCANNED_LINE_LENGTH) {
      visit(content.slice(lineStart, lineEnd), lineStart, line);
    }
    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
    line++;
  }
}
