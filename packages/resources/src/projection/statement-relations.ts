/**
 * Which relations a SQL statement NAMES, read off its text: the one scan the hydration planner and
 * the SQL gate share, so what a run hydrates for a statement and what the gate lets that statement
 * read cannot disagree.
 *
 * A relation is named when the statement spells it as an identifier — bare, or quoted as `"x"`,
 * `[x]` or a backticked name — outside comments, string literals and `AS` aliases. A single-quoted
 * `'x'` is a string here, though SQLite reads it as a table name when one exists: the gate refuses
 * that statement rather than letting it read a relation it did not name.
 *
 * 🚨 The scan over-selects on purpose: a relation it misses is ABSENT from the run database, so the
 * statement is refused rather than answered from an empty table.
 */

/**
 * The relations among `relations` that one statement names, by the same scan the lens selector
 * runs — comments, literals and `AS` aliases stripped, whole words, case-folded.
 *
 * @param sql - One statement
 * @param relations - SQL relation names to look for
 * @returns Those it names, in `relations` order
 */
export function relationsNamedBy(sql: string, relations: Iterable<string>): string[] {
  const words = wordsIn(withoutAliases(withoutCommentsAndLiterals(sql)));
  return [...relations].filter((relation) => namesRelation(words, relation));
}

/** Identifier runs and the punctuation a CTE definition is read from, in statement order. */
const CTE_TOKENS = /[a-z0-9_]+|[(),]/gi;

/**
 * Whether a statement defines a common table expression named `relation` — `WITH relation AS (`
 * or `, relation AS (`, with an optional `RECURSIVE`, column list, quoting and `[NOT]
 * MATERIALIZED`. Read from the statement's tokens once comments and literals are blanked, so a
 * literal or comment spelling one defines nothing.
 *
 * @param sql - One statement
 * @param relation - A SQL relation name
 * @returns True when the statement defines a CTE of that name
 */
export function definesCteNamed(sql: string, relation: string): boolean {
  const tokens = (withoutCommentsAndLiterals(sql).match(CTE_TOKENS) ?? []).map((token) => token.toLowerCase());
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

/** `AS`, then the identifier it names — bare or opened by a quote — as one run. */
const ALIAS_AFTER_AS = /\bas(\s+["[`]?)([a-z0-9_]+)/gi;

/**
 * Blank the identifier directly after every `AS` (case-insensitive): a column or table ALIAS is a
 * name the statement gives, never a relation it reads, so `SELECT COUNT(*) AS changed_files FROM
 * resources` must not be refused for naming `changed_files`. A statement that also reads the
 * relation still names it elsewhere, so this never hides a read. `WITH x AS (` names `x` BEFORE
 * the `AS`, and is untouched.
 *
 * @param sql - One statement, comments and literals already blanked
 * @returns The statement with each alias blanked to spaces
 */
function withoutAliases(sql: string): string {
  return sql.replaceAll(ALIAS_AFTER_AS, (_match, gap: string, alias: string) => `as${gap}${' '.repeat(alias.length)}`);
}

/**
 * Blank out the parts of a statement that cannot name a table: line comments,
 * block comments and single-quoted string literals. Quoted IDENTIFIERS
 * (`"edges"`, `[edges]`, backticked) are deliberately left alone — those ARE
 * table references, spelled differently. Replaced with spaces rather than
 * removed, so a block comment between `FROM` and `edges` cannot let the two run
 * together.
 *
 * @param sql - The statement
 * @returns The statement with every non-code span blanked
 */
function withoutCommentsAndLiterals(sql: string): string {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const end = spanEnd(sql, index);
    if (end === undefined) {
      out += sql.charAt(index);
      index += 1;
      continue;
    }
    const span = sql.slice(index, end);
    out += QUOTED_IDENTIFIER_CLOSERS.has(span.charAt(0)) ? span : ' '.repeat(span.length);
    index = end;
  }
  return out;
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

/** Every quoted span's opener and closer: the identifiers, plus `'` for a literal. */
const QUOTE_CLOSERS: ReadonlyMap<string, string> = new Map([...QUOTED_IDENTIFIER_CLOSERS, ["'", "'"]]);

/**
 * Where a span starting at `start` ends: a line comment, a block comment, a
 * single-quoted literal — or a quoted IDENTIFIER, consumed only so it can be
 * handed back unblanked.
 *
 * ⛔ Quoted identifiers MUST be consumed by this same scan even though their
 * contents stay code, and the reason is the whole of this function. SQLite gives
 * `'`, `--` and `/*` no meaning inside `"…"`, `[…]` or `` `…` ``. A scanner that
 * skips those spans lets a character inside one open a literal or a comment that
 * SQLite never opened, desynchronises, and blanks a span of REAL SQL — taking the
 * relation name with it. The statement then reads an EMPTY relation and answers 0
 * instead of being refused, which for a declared check is a silent exit 0: a gate
 * that cannot fail.
 *
 * Scanning left to right is what keeps the spans mutually exclusive: a comment
 * marker inside a literal is never looked at, nor a quote inside a comment.
 *
 * @param sql - The statement
 * @param start - Where to look
 * @returns The index just past the span, or undefined when none opens here
 */
function spanEnd(sql: string, start: number): number | undefined {
  const pair = sql.slice(start, start + 2);
  if (pair === '--') {
    const newline = sql.indexOf('\n', start);
    return newline === -1 ? sql.length : newline;
  }
  if (pair === '/*') {
    const close = sql.indexOf('*/', start + 2);
    return close === -1 ? undefined : close + 2;
  }
  const closer = QUOTE_CLOSERS.get(sql.charAt(start));
  return closer === undefined ? undefined : quotedEnd(sql, start, closer);
}

/**
 * Where a quoted span ends. A doubled closer (`''`, `""`, two backticks) is an
 * escaped one; `[…]` has no escape. Left unterminated, the span ends at the last
 * doubled closer instead — what the single pattern this replaced did by
 * backtracking.
 *
 * @param sql - The statement
 * @param start - The opening quote
 * @param closer - The character that closes it
 * @returns The index just past the span, or undefined when it never closes
 */
function quotedEnd(sql: string, start: number, closer: string): number | undefined {
  let fallback: number | undefined;
  let from = start + 1;
  for (;;) {
    const close = sql.indexOf(closer, from);
    if (close === -1) return fallback;
    if (closer === ']' || sql.charAt(close + 1) !== closer) return close + 1;
    fallback = close + 1;
    from = close + 2;
  }
}

/**
 * Every whole word in a statement, lowercased.
 *
 * Relation names are `[a-z_]` only and `_` is a word character, so membership in
 * this set answers exactly what a `\b`-anchored search would: `my_edges`
 * tokenizes whole and never answers for `edges`. One pass per statement, rather
 * than one pattern per relation, and no `RegExp` built from a variable.
 *
 * @param sql - The statement, already stripped of comments and literals
 * @returns Its identifier-character runs, lowercased
 */
function wordsIn(sql: string): ReadonlySet<string> {
  return new Set((sql.match(IDENTIFIER_RUNS) ?? []).map((word) => word.toLowerCase()));
}

/** Runs of identifier characters — SQL's word boundaries, the `\b` equivalent. */
const IDENTIFIER_RUNS = /[a-z0-9_]+/gi;

/**
 * Does a statement's word set name this relation?
 *
 * Case-folds the relation as well as the words: a registry name spelled with an
 * uppercase letter would otherwise miss every statement silently.
 *
 * @param words - The statement's words, from {@link wordsIn}
 * @param relation - The relation's SQL name
 * @returns True when the statement could be reading that relation
 */
function namesRelation(words: ReadonlySet<string>, relation: string): boolean {
  return words.has(relation.toLowerCase());
}
