/**
 * Which relations a SQL statement NAMES, read off its tokens: the one scan the hydration planner and
 * the SQL gate share, so what a run hydrates for a statement and what the gate lets that statement
 * read cannot disagree. Comments, literals and quoted identifiers are where `sql-lexer.ts` says
 * they are, as SQLite reads them.
 *
 * A relation is named when the statement spells it as an identifier: bare, or quoted as `"x"`,
 * `[x]` or a backticked name, and not as the alias directly after an `AS`. A single-quoted `'x'` is
 * a string here, though SQLite reads it as a table name when one exists: the gate refuses any
 * statement that reaches a relation that way.
 *
 * 🚨 The scan over-selects on purpose: a relation it misses is ABSENT from the run database, so the
 * statement is refused rather than answered from an empty table.
 */

import { type SqlToken, sqlTokens } from './sql-lexer.js';

/**
 * The relations among `relations` that one statement names: an identifier token spelling it,
 * case-folded, that is not the alias after an `AS`.
 *
 * @param sql - One statement
 * @param relations - SQL relation names to look for
 * @returns Those it names, in `relations` order
 */
export function relationsNamedBy(sql: string, relations: Iterable<string>): string[] {
  const names = namedIdentifiers(sqlTokens(sql));
  return [...relations].filter((relation) => names.has(relation.toLowerCase()));
}

/**
 * Every identifier a statement spells, lower-cased, leaving out each alias directly after `AS`: a
 * column or table ALIAS is a name the statement gives, never a relation it reads, so `SELECT
 * COUNT(*) AS changed_files FROM resources` does not name `changed_files`. A statement that also
 * reads the relation names it elsewhere. `WITH x AS (` names `x` BEFORE the `AS`, and keeps it.
 *
 * @param tokens - The statement's tokens
 * @returns The names
 */
function namedIdentifiers(tokens: readonly SqlToken[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [at, token] of tokens.entries()) {
    if (isIdentifier(token) && !isAsKeyword(tokens[at - 1])) names.add(token.value.toLowerCase());
  }
  return names;
}

/**
 * Whether a token spells an identifier: a bare word or a quoted identifier.
 *
 * @param token - The token
 * @returns True for either
 */
function isIdentifier(token: SqlToken): boolean {
  return token.kind === 'word' || token.kind === 'quotedIdentifier';
}

/**
 * Whether a token is the keyword `AS`, written bare.
 *
 * @param token - The token, or undefined before the first
 * @returns True for `AS` in any case
 */
function isAsKeyword(token: SqlToken | undefined): boolean {
  return token?.kind === 'word' && token.value.toLowerCase() === 'as';
}

/** The punctuation a CTE definition is read from. */
const CTE_PUNCTUATION: ReadonlySet<string> = new Set(['(', ')', ',']);

/**
 * Whether a statement defines a common table expression named `relation` — `WITH relation AS (`
 * or `, relation AS (`, with an optional `RECURSIVE`, column list, quoting and `[NOT]
 * MATERIALIZED`. Read from the statement's tokens, so a literal or comment spelling one defines
 * nothing.
 *
 * @param sql - One statement
 * @param relation - A SQL relation name
 * @returns True when the statement defines a CTE of that name
 */
export function definesCteNamed(sql: string, relation: string): boolean {
  const tokens = sqlTokens(sql)
    .filter((token) => isIdentifier(token) || (token.kind === 'punctuation' && CTE_PUNCTUATION.has(token.value)))
    .map((token) => token.value.toLowerCase());
  const wanted = relation.toLowerCase();
  return tokens.some((token, at) => token === wanted && opensCte(tokens[at - 1]) && isCteBody(tokens, at + 1));
}

/** Whether the token before a name opens a CTE definition: `WITH`, `RECURSIVE` or a comma. */
function opensCte(previous: string | undefined): boolean {
  return previous === 'with' || previous === 'recursive' || previous === ',';
}

/** Whether the tokens from `at` read `[(columns)] AS [NOT] [MATERIALIZED] (`. */
function isCteBody(tokens: readonly string[], at: number): boolean {
  let next = at;
  if (tokens[next] === '(') {
    const close = tokens.indexOf(')', next);
    if (close === -1) return false;
    next = close + 1;
  }
  if (tokens[next] !== 'as') return false;
  next += 1;
  if (tokens[next] === 'not') next += 1;
  if (tokens[next] === 'materialized') next += 1;
  return tokens[next] === '(';
}

/** The characters that open a quoted identifier, and the one that closes each. */
const QUOTED_IDENTIFIER_CLOSERS: ReadonlyMap<string, string> = new Map([['"', '"'], ['[', ']'], ['`', '`']]);

/**
 * Every spelling of a relation name the scan reads as naming it: plain, then each quoted
 * identifier form. A single-quoted name is not among them — the planner reads it as a string.
 *
 * @param relation - A SQL relation name
 * @returns Its spellings, plain first
 */
export function identifierSpellings(relation: string): readonly string[] {
  return [relation, ...[...QUOTED_IDENTIFIER_CLOSERS].map(([open, close]) => `${open}${relation}${close}`)];
}
