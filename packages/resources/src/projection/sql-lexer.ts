/**
 * The one reading of where a SQL statement's comments, string literals and quoted identifiers start
 * and end, shared by the SQL gate and the scan of which relations a statement names, so the two
 * cannot disagree about which text is code.
 *
 * It follows SQLite's own tokenizer, and `sql-lexer-differential.test.ts` holds it to the engine:
 *
 * - `--` runs to the end of the line; `/*` runs to `*\/` or, left unclosed, to the end of the text,
 *   which SQLite accepts as a comment. A `/*` that ends the text is not a comment at all.
 * - `'…'` is a string; `"…"` and backticks quote an identifier; in all three a doubled quote is an
 *   escaped one. `[…]` quotes an identifier up to the first `]`, with no escape.
 * - An unclosed quote runs to the end of the text. SQLite refuses the statement, so nothing after
 *   the opener is code.
 *
 * Every span is found by one forward search from where it opens and the next scan resumes past its
 * end, so a scan is linear in the length of the statement whatever it holds.
 */

/**
 * The characters SQLite's tokenizer reads as part of a name (its `IdChar`): ASCII letters, digits,
 * `_`, `$`, and every character from U+0080 up.
 */
export const SQL_IDENTIFIER_CHAR = /[\w$\u0080-￿]/;

/** What may start a name or number token: a name character other than `$`, which opens a parameter. */
export const SQL_WORD_START_CHAR = /[\w\u0080-￿]/;

/** The characters SQLite skips as space: space, tab, newline, form feed and carriage return. */
export const SQL_WHITESPACE = /[ \t\n\f\r]/;

/** What a span the lexer steps over whole is. */
export type SqlSpanKind = 'comment' | 'string' | 'quotedIdentifier';

/** One comment, string literal or quoted identifier. */
export interface SqlSpan {
  readonly kind: SqlSpanKind;
  /** Index just past the span. */
  readonly end: number;
  /** False for a quote left open, which runs to the end of the text. */
  readonly closed: boolean;
}

/** The character that closes each quote opener. */
const QUOTE_CLOSERS: ReadonlyMap<string, string> = new Map([["'", "'"], ['"', '"'], ['`', '`'], ['[', ']']]);

/**
 * The comment, string literal or quoted identifier opening at `start`, or undefined when none does.
 *
 * @param sql - The statement text
 * @param start - Where to look
 * @returns The span
 */
export function sqlSpanAt(sql: string, start: number): SqlSpan | undefined {
  const opener = sql.charAt(start);
  const next = sql.charAt(start + 1);
  if (opener === '-' && next === '-') {
    const newline = sql.indexOf('\n', start + 2);
    return { kind: 'comment', end: newline === -1 ? sql.length : newline, closed: true };
  }
  // SQLite opens a comment at `/*` only when a character follows it; a bare `/*` at the very end is
  // a slash and a star, which do not compile.
  if (opener === '/' && next === '*' && start + 2 < sql.length) {
    const close = sql.indexOf('*/', start + 2);
    return { kind: 'comment', end: close === -1 ? sql.length : close + 2, closed: true };
  }
  const closer = QUOTE_CLOSERS.get(opener);
  if (closer === undefined) return undefined;
  const end = quotedEnd(sql, start, closer);
  return {
    kind: opener === "'" ? 'string' : 'quotedIdentifier',
    end: end ?? sql.length,
    closed: end !== undefined,
  };
}

/**
 * Where a quoted span ends: past the first closer that is not doubled (`]` is never doubled).
 *
 * @param sql - The statement text
 * @param start - The opening quote
 * @param closer - The character that closes it
 * @returns The index just past the closer, or undefined when it never closes
 */
function quotedEnd(sql: string, start: number, closer: string): number | undefined {
  let from = start + 1;
  for (;;) {
    const close = sql.indexOf(closer, from);
    if (close === -1) return undefined;
    if (closer === ']' || sql.charAt(close + 1) !== closer) return close + 1;
    from = close + 2;
  }
}

/** What one token of a statement is. */
export type SqlTokenKind = 'word' | 'string' | 'quotedIdentifier' | 'punctuation';

/** One token: a name or number, a string, a quoted identifier, or one other character. */
export interface SqlToken {
  readonly kind: SqlTokenKind;
  /** The text it stands for: a quoted span unquoted and unescaped; anything else as written. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
  /** False for a quote left open. */
  readonly closed: boolean;
}

/**
 * A statement's tokens in order, with whitespace and comments dropped.
 *
 * @param sql - The statement text
 * @returns Its tokens
 */
export function sqlTokens(sql: string): readonly SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const found = tokenAt(sql, index);
    if (found !== undefined) tokens.push(found);
    index = found?.end ?? skippedEnd(sql, index);
  }
  return tokens;
}

/**
 * Where the whitespace character or comment at `index` ends.
 *
 * @param sql - The statement text
 * @param index - A position {@link tokenAt} found no token at
 * @returns Index just past it
 */
function skippedEnd(sql: string, index: number): number {
  return sqlSpanAt(sql, index)?.end ?? index + 1;
}

/**
 * The token at `index`, or undefined for whitespace or a comment.
 *
 * @param sql - The statement text
 * @param index - Where to look
 * @returns The token
 */
function tokenAt(sql: string, index: number): SqlToken | undefined {
  const span = sqlSpanAt(sql, index);
  if (span !== undefined) {
    if (span.kind === 'comment') return undefined;
    return { kind: span.kind, value: unquoted(sql, index, span), start: index, end: span.end, closed: span.closed };
  }
  const char = sql.charAt(index);
  if (SQL_WHITESPACE.test(char)) return undefined;
  if (!SQL_WORD_START_CHAR.test(char)) {
    return { kind: 'punctuation', value: char, start: index, end: index + 1, closed: true };
  }
  let end = index + 1;
  while (end < sql.length && SQL_IDENTIFIER_CHAR.test(sql.charAt(end))) end += 1;
  return { kind: 'word', value: sql.slice(index, end), start: index, end, closed: true };
}

/**
 * The text a quoted span stands for: its quotes removed and each doubled closer made single.
 *
 * @param sql - The statement text
 * @param start - The opening quote
 * @param span - The span
 * @returns Its value
 */
function unquoted(sql: string, start: number, span: SqlSpan): string {
  const opener = sql.charAt(start);
  const closer = QUOTE_CLOSERS.get(opener) ?? opener;
  const inner = sql.slice(start + 1, span.closed ? span.end - 1 : span.end);
  return closer === ']' ? inner : inner.replaceAll(closer + closer, closer);
}
