/**
 * A check's `with:` — CTE definitions, without the WITH keyword, that VAT prepends to the check's
 * `sql` and its `examined`, so a derived population both statements range over is written once.
 *
 * 🔑 **Composed once, when the config is parsed** (`ResourceCheckSchema`), and the composed text is
 * the check's `sql` and `examined` from then on. The SQL gate, the compile probe, the reserved-name
 * CTE refusal and the scan of which relations a statement names all read that one text, so none of
 * them can see a statement without the definitions it runs with.
 *
 * Read with the shared lexer (`sql-lexer.ts`), so a comment or string spelling `WITH` or a paren is
 * never mistaken for structure.
 *
 * - A statement with no leading WITH becomes `WITH <with>` + newline + the statement.
 * - A statement with its own leading WITH is MERGED: `WITH <with>` + newline + `, <its CTEs> ...`.
 *   A CTE name both define is refused (SQLite would refuse it too, as "duplicate WITH table name",
 *   without saying that half of it came from `with:`).
 * - The result is `WITH RECURSIVE` when either side is: `with:` may begin with `RECURSIVE`.
 *
 * The newline after `<with>` is load-bearing: a `with:` ending in a `--` comment would otherwise
 * comment out the statement after it.
 */

import { type SqlToken, sqlTokens } from './sql-lexer.js';

/** The composed statement, or why `with:` cannot be composed with it. */
type CteComposition =
  | { readonly ok: true; readonly sql: string }
  | { readonly ok: false; readonly message: string };

/** The leading CTE list read: the names it defines and the index of the first token past it. */
type CteList =
  | { readonly ok: true; readonly names: readonly string[]; readonly end: number }
  | { readonly ok: false; readonly at: SqlToken | undefined; readonly expected: string };

/** How `with:` must be written, for the refusals. */
const WITH_SHAPE = '`name [(columns)] AS [NOT] [MATERIALIZED] (SELECT ...)`, comma-separated, optionally led by RECURSIVE';

/**
 * Compose a check's `with:` with one of its statements.
 *
 * @param withCtes - The check's `with:` text
 * @param statement - Its `sql` or `examined` statement
 * @param statementKey - The statement's config key, for the clash refusal
 * @returns The composed statement, or the refusal
 */
export function composeWithCtes(withCtes: string, statement: string, statementKey = 'sql'): CteComposition {
  const parsed = parseWithCtes(withCtes);
  if (!parsed.ok) return parsed;
  const tokens = sqlTokens(statement);
  const own = leadingWith(tokens);
  if (own === undefined) {
    return { ok: true, sql: `WITH ${parsed.recursive ? 'RECURSIVE ' : ''}${parsed.body}\n${statement}` };
  }
  const list = cteList(tokens, own.listStart);
  // A malformed leading list cannot be read for names; SQLite refuses it when the check runs.
  const ownNames = new Set(list.ok ? list.names : []);
  const clash = parsed.names.find((name) => ownNames.has(name));
  if (clash !== undefined) {
    return {
      ok: false,
      message: `The CTE "${clash}" is defined both in \`with\` and in the statement's own WITH in \`${statementKey}\`;`
        + ' rename one of them, or define it only in `with`.',
    };
  }
  const recursive = parsed.recursive || own.recursive;
  const rest = statement.slice(tokens[own.listStart]?.start ?? statement.length);
  return { ok: true, sql: `WITH ${recursive ? 'RECURSIVE ' : ''}${parsed.body}\n, ${rest}` };
}

/** `with:` read: its definitions' text without a leading RECURSIVE, the names, and whether it was recursive. */
type ParsedWith =
  | { readonly ok: true; readonly body: string; readonly names: readonly string[]; readonly recursive: boolean }
  | { readonly ok: false; readonly message: string };

/**
 * Read `with:` as CTE definitions only.
 *
 * @param withCtes - The check's `with:` text
 * @returns Its body, names and recursiveness, or the refusal
 */
function parseWithCtes(withCtes: string): ParsedWith {
  const tokens = sqlTokens(withCtes);
  const [first] = tokens;
  if (first !== undefined && isWord(first, 'with')) {
    return {
      ok: false,
      message: '`with` begins with the keyword WITH, which VAT writes itself: remove it and keep the definitions'
        + ` (${WITH_SHAPE}).`,
    };
  }
  const recursive = first !== undefined && isWord(first, 'recursive');
  const from = recursive ? 1 : 0;
  if (tokens.length <= from) {
    return { ok: false, message: `\`with\` holds no CTE definition: write one or more (${WITH_SHAPE}), or remove the key.` };
  }
  const list = cteList(tokens, from);
  const stop = list.ok ? tokens[list.end] : list.at;
  if (!list.ok || stop !== undefined) {
    const where = stop === undefined ? 'it ends' : `at \`${stop.value}\``;
    const expected = list.ok ? 'a comma or the end' : list.expected;
    return {
      ok: false,
      message: `\`with\` must hold only CTE definitions (${WITH_SHAPE}), and ${where} where ${expected} was expected.`,
    };
  }
  const body = recursive ? withCtes.slice(first.end).trimStart() : withCtes;
  return { ok: true, body, names: list.names, recursive };
}

/**
 * The statement's own leading WITH: where its CTE list starts and whether it is RECURSIVE.
 *
 * @param tokens - The statement's tokens
 * @returns Undefined when the statement does not begin with WITH
 */
function leadingWith(tokens: readonly SqlToken[]): { readonly listStart: number; readonly recursive: boolean } | undefined {
  const [first, second] = tokens;
  if (first === undefined || !isWord(first, 'with')) return undefined;
  const recursive = second !== undefined && isWord(second, 'recursive');
  return { listStart: recursive ? 2 : 1, recursive };
}

/**
 * Read a CTE list from `from`: `name [(columns)] AS [NOT] [MATERIALIZED] (...)`, comma-separated.
 *
 * @param tokens - The tokens
 * @param from - The first name's index
 * @returns The names, lower-cased, and the index past the list, or where it stopped reading
 */
function cteList(tokens: readonly SqlToken[], from: number): CteList {
  const names: string[] = [];
  let at = from;
  for (;;) {
    const one = oneCte(tokens, at);
    if (!one.ok) return one;
    names.push(one.name);
    if (!isPunctuation(tokens[one.end], ',')) return { ok: true, names, end: one.end };
    at = one.end + 1;
  }
}

/** One CTE definition read: its name, lower-cased, and the index past its closing `)`. */
type OneCte =
  | { readonly ok: true; readonly name: string; readonly end: number }
  | Extract<CteList, { ok: false }>;

/**
 * Read one CTE definition at `at`: `name [(columns)] AS [NOT] [MATERIALIZED] (...)`.
 *
 * @param tokens - The tokens
 * @param at - The name's index
 * @returns The definition, or where it stopped reading
 */
function oneCte(tokens: readonly SqlToken[], at: number): OneCte {
  const name = tokens[at];
  if (name === undefined || (name.kind !== 'word' && name.kind !== 'quotedIdentifier')) {
    return { ok: false, at: name, expected: 'a CTE name' };
  }
  let next = at + 1;
  if (isPunctuation(tokens[next], '(')) {
    const close = closingParen(tokens, next);
    if (close === undefined) return { ok: false, at: undefined, expected: 'the column list\'s `)`' };
    next = close + 1;
  }
  if (!isWord(tokens[next], 'as')) return { ok: false, at: tokens[next], expected: '`AS`' };
  next += 1;
  if (isWord(tokens[next], 'not')) next += 1;
  if (isWord(tokens[next], 'materialized')) next += 1;
  if (!isPunctuation(tokens[next], '(')) return { ok: false, at: tokens[next], expected: '`(`' };
  const close = closingParen(tokens, next);
  if (close === undefined) return { ok: false, at: undefined, expected: 'the definition\'s `)`' };
  return { ok: true, name: name.value.toLowerCase(), end: close + 1 };
}

/**
 * The index of the `)` closing the `(` at `open`.
 *
 * @param tokens - The tokens
 * @param open - An opening paren's index
 * @returns Its closer's index, or undefined when it never closes
 */
function closingParen(tokens: readonly SqlToken[], open: number): number | undefined {
  let depth = 0;
  for (let at = open; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (isPunctuation(token, '(')) depth += 1;
    else if (isPunctuation(token, ')')) {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return undefined;
}

/** Whether a token is the bare word `word`, in any case. */
function isWord(token: SqlToken | undefined, word: string): boolean {
  return token?.kind === 'word' && token.value.toLowerCase() === word;
}

/** Whether a token is the punctuation `char`. */
function isPunctuation(token: SqlToken | undefined, char: string): boolean {
  return token?.kind === 'punctuation' && token.value === char;
}
