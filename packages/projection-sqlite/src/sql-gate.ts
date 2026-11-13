/**
 * The gate every caller statement passes before it reaches SQLite: one
 * statement, a query by its first keyword, exactly one value per placeholder,
 * compiled on a read-only connection with every foreign schema detached after.
 *
 * Shared by the two handles that take a caller's SQL — the run database, which
 * runs it, and the compile probe, which only compiles it — so the two cannot
 * disagree on what is admitted. The storage port takes no SQL and never reaches
 * this module.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { PROJECTION_STATEMENT_REFUSED_CODE } from '@vibe-agent-toolkit/resources';
import { VatError } from '@vibe-agent-toolkit/utils';

import type { SqliteValue } from './values.js';

/** One whitespace character, for the space-and-comment skip. */
const WHITESPACE = /\s/;

/** The leading run of letters, which is the only thing the statement-kind gate reads. */
const LEADING_KEYWORD = /^[a-z]+/i;

/**
 * The statement kinds this surface runs.
 *
 * ⚠️ A gate on statement KIND, not an inspection of the SQL. Read-only-ness is
 * enforced by `PRAGMA query_only` and by nothing else — see the run database's
 * `query` — and this does not second-guess it: it decides
 * whether the caller submitted a *query* at all, from one token, without knowing
 * anything about what follows. `WITH c(a) AS (VALUES (1)) DELETE FROM x` passes
 * this and is refused by the engine, which is the arrangement working as
 * intended rather than a hole in it.
 *
 * 🚫 `EXPLAIN` is deliberately absent even though it is genuinely side-effect
 * free — measured on Node 24.13.1, `EXPLAIN ATTACH DATABASE '/tmp/x.db' AS x`
 * returns eight opcode rows and creates no file. It is out because it is a
 * PREFIX: admitting it would mean any statement can wear a token this gate
 * accepts, and deciding safety would then require looking *past* the first
 * token, which is the SQL inspection this project has settled against. Its rows
 * are SQLite bytecode rather than projection facts, and the schema-diagnostic
 * path reads `PROJECTION_TABLES` in-process instead — so nothing wants it yet,
 * and pre-1.0 there is no cost to adding it the day something does.
 */
const QUERY_STATEMENT_KEYWORDS: readonly string[] = ['SELECT', 'WITH', 'VALUES'];

/**
 * Walk past a quoted run starting at `start`, honouring SQL's doubled-quote
 * escape (`'it''s'` is one string, not two).
 *
 * @param sql - The statement text
 * @param start - Index of the opening quote
 * @param quote - The quote character that opened it
 * @returns Index just past the closing quote, or the end for an unterminated run
 */
function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== quote) {
      index += 1;
    } else if (sql[index + 1] === quote) {
      index += 2;
    } else {
      return index + 1;
    }
  }
  return sql.length;
}

/**
 * Walk past a comment beginning at `index`.
 *
 * Split out from {@link skipLiteralOrComment} rather than inlined there because
 * two callers need *only* this half: what may follow a terminating `;`, and what
 * may precede the first keyword, are both "whitespace and comments" — a string
 * literal in either position is trailing text SQLite would discard, not
 * decoration. One comment scanner serves all three, which is the point: a second
 * one is how the four-quoting-forms bug below got in.
 *
 * @param sql - The statement text
 * @param index - Where to look
 * @returns Index just past the comment, or `index` unchanged when none starts here
 */
function skipComment(sql: string, index: number): number {
  const pair = sql.slice(index, index + 2);
  if (pair === '--') {
    const end = sql.indexOf('\n', index);
    return end < 0 ? sql.length : end + 1;
  }
  if (pair === '/*') {
    const end = sql.indexOf('*/', index + 2);
    return end < 0 ? sql.length : end + 2;
  }
  return index;
}

/**
 * Walk past a string literal or quoted identifier beginning at `index`.
 *
 * @param sql - The statement text
 * @param index - Where to look
 * @returns Index just past it, or `index` unchanged when none starts here
 */
function skipQuotedRun(sql: string, index: number): number {
  const quote = sql[index];
  // 🚨 FOUR quoting forms, not two. SQLite accepts `'…'` (string), `"…"`,
  // `` `…` `` (MySQL-style) and `[…]` (MS-style) as quoted IDENTIFIERS, and a
  // scanner that knows only the first two DESYNCHRONISES on the others: given
  // ``SELECT 1 AS `a'b`; DELETE FROM blobs``, it walks into the backticks
  // unaware, treats the apostrophe inside as opening a string, and swallows the
  // real `;` — so the guard passed and SQLite silently discarded the `DELETE`.
  // Verified end to end before the fix; that is exactly the intent-loss this
  // function exists to refuse, arriving through the function itself.
  //
  // It also failed in the other direction: a legitimate `SELECT 1 AS [a;b]` was
  // rejected as multi-statement, because the `;` inside the identifier was read
  // as a separator.
  if (quote === "'" || quote === '"' || quote === '`') return skipQuoted(sql, index, quote);
  // `[` is the odd one: its terminator is a DIFFERENT character and, unlike the
  // other three, SQLite gives it no doubling escape — the first `]` ends it.
  if (quote === '[') {
    const end = sql.indexOf(']', index + 1);
    return end < 0 ? sql.length : end + 1;
  }
  return index;
}

/**
 * Walk past a string literal, quoted identifier or comment beginning at `index`.
 *
 * @param sql - The statement text
 * @param index - Where to look
 * @returns Index just past it, or `index` unchanged when none starts here
 */
function skipLiteralOrComment(sql: string, index: number): number {
  const past = skipComment(sql, index);
  return past > index ? past : skipQuotedRun(sql, index);
}

/**
 * Index of the first character that is neither whitespace nor part of a comment.
 *
 * @param sql - The statement text
 * @param from - Where to start looking
 * @returns That index, or `sql.length` when nothing but space and comments is left
 */
function indexPastSpaceAndComments(sql: string, from: number): number {
  let index = from;
  while (index < sql.length) {
    const past = skipComment(sql, index);
    if (past > index) {
      index = past;
    } else if (WHITESPACE.test(sql[index] ?? '')) {
      index += 1;
    } else {
      return index;
    }
  }
  return sql.length;
}

/**
 * Index of the first `;` that actually separates statements.
 *
 * A scanner rather than a regex, and deliberately: the alternation this
 * replaced tripped both `security/detect-unsafe-regex` and SonarJS's complexity
 * ceiling, and the honest reading of those is that a pattern matching nested,
 * escaped syntax is the wrong tool. This cannot backtrack at all — every branch
 * moves the cursor forward — so the input being user-supplied costs nothing.
 *
 * @param sql - The statement text
 * @returns The index, or `-1` when every `;` is inside a literal or comment
 */
function indexOfStatementSeparator(sql: string): number {
  let index = 0;
  while (index < sql.length) {
    const skipped = skipLiteralOrComment(sql, index);
    if (skipped > index) {
      index = skipped;
    } else if (sql[index] === ';') {
      return index;
    } else {
      index += 1;
    }
  }
  return -1;
}

/** The characters SQLite's tokenizer admits in a parameter name after a sigil. */
const PARAMETER_NAME_CHAR = /[\w\u0080-\uFFFF]/;

/** The sigils that open a NAMED parameter, which positional values never reach. */
const NAMED_PARAMETER_SIGILS: ReadonlySet<string> = new Set([':', '@', '$']);

/** One decimal digit, for the `?NNN` form. */
const DIGIT = /\d/;

/**
 * How many values SQLite expects bound to `sql`, and whether any of its
 * placeholders is one positional values can never reach.
 *
 * 🚨 **Derived, because the driver does not say.** `StatementSync` exposes no
 * `sqlite3_bind_parameter_count` (verified on Node 24.13.1 — the prototype has
 * nothing between `columns` and the setters), and the engine only refuses ONE
 * direction: a value with no slot throws `column index out of range`, while a
 * slot with no value is silently bound to NULL. On this surface that second
 * case is not an error but a wrong answer at exit 0 — every comparison against
 * NULL is false, so the statement selects nothing, and "selected nothing" is
 * what a passing `resources.checks` entry looks like.
 *
 * So the count is read off the statement with the SAME scanner the separator
 * gate uses: each bare `?` is one slot. Every other placeholder form is
 * reported rather than counted, because positional values cannot reach it on
 * every Node this package supports: a `:x`, `@x` or `$x` name never binds
 * positionally, and `?NNN` does not either on the declared floor — measured,
 * Node 22.13.0, 22.14.0 and 22.16.0 throw `column index out of range` for
 * `SELECT ?1 AS x` with one value, while 22.22.3 and 24.x bind it. A form that
 * works on one supported runtime and throws an unrelated error on another is
 * refused on all of them, with a message that names the form.
 *
 * @param sql - The statement text
 * @returns The slot count, and the first unreachable placeholder if there is one
 */
function countBoundParameters(sql: string): { readonly slots: number; readonly unreachable: string | undefined } {
  let slots = 0;
  let unreachable: string | undefined;
  let index = 0;
  while (index < sql.length) {
    const skipped = skipLiteralOrComment(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    const placeholder = placeholderAt(sql, index);
    if (placeholder === undefined) {
      index += 1;
      continue;
    }
    const form = placeholder.name ?? (placeholder.slot === undefined ? undefined : `?${placeholder.slot}`);
    if (form === undefined) {
      slots += 1;
    } else {
      unreachable ??= form;
    }
    index = placeholder.end;
  }
  return { slots, unreachable };
}

/** What one placeholder token is: where it ends, and its `?NNN` slot or its `:name`. */
interface PlaceholderToken {
  readonly end: number;
  readonly slot?: number;
  readonly name?: string;
}

/**
 * The placeholder token beginning at `index`, or `undefined` when none does.
 *
 * Outside literals and comments only — the caller has already stepped past
 * those, and a `?` inside one is text.
 *
 * @param sql - The statement text
 * @param index - Where to look
 * @returns The token, or `undefined`
 */
function placeholderAt(sql: string, index: number): PlaceholderToken | undefined {
  const char = sql[index] ?? '';
  if (char === '?') {
    const end = indexPastRun(sql, index + 1, DIGIT);
    return end > index + 1 ? { end, slot: Number(sql.slice(index + 1, end)) } : { end };
  }
  if (NAMED_PARAMETER_SIGILS.has(char) && PARAMETER_NAME_CHAR.test(sql[index + 1] ?? '')) {
    const end = indexPastRun(sql, index + 1, PARAMETER_NAME_CHAR);
    return { end, name: sql.slice(index, end) };
  }
  return undefined;
}

/**
 * Index just past the run of characters matching `pattern` that starts at `from`.
 *
 * @param sql - The statement text
 * @param from - Where the run may start
 * @param pattern - A single-character test
 * @returns `from` itself when the run is empty
 */
function indexPastRun(sql: string, from: number, pattern: RegExp): number {
  let end = from;
  while (end < sql.length && pattern.test(sql[end] ?? '')) end += 1;
  return end;
}

/**
 * Refuse a statement whose placeholders and values do not pair off exactly.
 *
 * Both directions, in one message that names both counts — the engine's own
 * over-bind refusal says `column index out of range`, which is about a column
 * in a statement that has no column problem. See {@link countBoundParameters}
 * for why the under-bound direction is the one that matters.
 *
 * @param sql - The statement text
 * @param parameters - What the caller is binding, positionally
 * @throws If a placeholder is named or numbered, or the counts differ
 */
function assertParametersBound(sql: string, parameters: readonly SqliteValue[]): void {
  const { slots, unreachable } = countBoundParameters(sql);
  if (unreachable !== undefined) {
    throw new VatError(
      PROJECTION_STATEMENT_REFUSED_CODE,
      `This statement has a named or numbered parameter (\`${unreachable}\`), and this surface binds`
      + ' values positionally into bare `?` slots only — write `?` instead, once per value.',
    );
  }
  if (slots === parameters.length) return;
  const placeholders = `${slots} placeholder${slots === 1 ? '' : 's'}`;
  const values = `${parameters.length} value${parameters.length === 1 ? ' was' : 's were'} bound`;
  const consequence = parameters.length < slots
    ? 'SQLite binds a missing value as NULL, so an under-bound statement compares against nothing'
      + ' and reports that it succeeded'
    : 'there is no placeholder for the extra value';
  throw new VatError(
    PROJECTION_STATEMENT_REFUSED_CODE,
    `This statement has ${placeholders} and ${values}; ${consequence}. Bind exactly one value per placeholder.`,
  );
}

/**
 * Refuse text carrying more than one statement.
 *
 * 🪤 **Not belt-and-braces over `query_only`** — it is the only thing that says
 * anything at all. Measured on Node 24.13.1: `prepare('SELECT 1; DELETE FROM t')`
 * is *accepted*, compiles the first statement, and **silently discards the
 * tail**. The rows survive, so nothing is destroyed; what is destroyed is the
 * caller's intent, with no error and no output to show it went missing. A user
 * whose second statement quietly evaporates is worse off than one told no.
 *
 * @param sql - The caller's statement text
 * @throws If anything but whitespace follows a statement separator
 */
function assertSingleStatement(sql: string): void {
  const separator = indexOfStatementSeparator(sql);
  // 🪤 NOT `.trim()`. Whitespace is not the only thing that can follow a
  // terminator without being a statement: `SELECT … ;  -- see ADR-14` is one
  // statement and a note, and a `resources.checks` entry written as a YAML block
  // scalar ends that way routinely. Trimming counted the comment as a second
  // statement and failed the adopter's gate with "the trailing text would be
  // ignored rather than run" — which, for a comment, is not a hazard but the
  // correct and expected behaviour. A stray LITERAL after the `;` is still
  // refused, because that one really is text the caller meant and SQLite drops.
  if (separator >= 0 && indexPastSpaceAndComments(sql, separator + 1) < sql.length) {
    throw new VatError(
      PROJECTION_STATEMENT_REFUSED_CODE,
      'A projection query must be a single statement. SQLite compiles only the first and discards'
      + ' the rest without error, so the trailing text would be ignored rather than run.',
    );
  }
}

/**
 * Refuse anything that is not a query.
 *
 * 🚨 **Without this, a statement that is not a query is a PASSING check.** The
 * `resources.checks` surface defines success as "this statement selected no
 * rows", so anything SQLite accepts and that yields nothing is indistinguishable
 * from a clean pass. Measured on Node 24.13.1 under `query_only = 1`:
 * `ATTACH DATABASE 'evil.db' AS evil` produced no finding, incremented the
 * checks-run count, and left a zero-byte file in the project directory; so did
 * `PRAGMA query_only = 0`. An author cannot write an assertion that passes
 * vacuously by selecting nothing — but they could write one that passes
 * vacuously by not asserting at all, which is worse, because it looks like a
 * check.
 *
 * ⚠️ **This is a gate on statement KIND and not an inspection of the SQL.** It
 * reads exactly one token and knows nothing about the rest; read-only-ness stays
 * the engine's job via `PRAGMA query_only`. See {@link QUERY_STATEMENT_KEYWORDS}
 * for what is admitted and why `EXPLAIN` is not.
 *
 * It is also the first of the two things standing between this surface and
 * another database on disk: `ATTACH` is not a query, so it never reaches the
 * engine that would have accepted it.
 *
 * @param sql - The caller's statement text
 * @throws If the first significant token is not a query keyword
 */
function assertIsQuery(sql: string): void {
  const start = indexPastSpaceAndComments(sql, 0);
  const keyword = (LEADING_KEYWORD.exec(sql.slice(start))?.[0] ?? '').toUpperCase();
  if (QUERY_STATEMENT_KEYWORDS.includes(keyword)) return;

  const admitted = QUERY_STATEMENT_KEYWORDS.map((word) => `\`${word}\``).join(', ');
  const found = keyword === '' ? 'none of them' : `\`${keyword}\``;
  throw new VatError(
    PROJECTION_STATEMENT_REFUSED_CODE,
    `A projection query must be a read-only query, so it has to begin with one of ${admitted}.`
    + ` This one begins with ${found}, and a statement the engine accepts without producing rows`
    + ' cannot be told apart from a check that passed — on this surface, selecting nothing IS'
    + ' success.',
  );
}

/**
 * Detach every schema this connection was not opened on.
 *
 * 🚨 **The other half of refusing `ATTACH`, and it is not redundancy.** One
 * connection serves every statement in a run — `vat resources check` puts all of
 * a project's declared checks through a single `ask` closure — so an attachment
 * that outlives the call that made it is readable by the NEXT statement, under a
 * schema prefix no key predicate narrows. Reproduced end to end before this
 * existed: check `a` attached `$TMPDIR/.vat-cache/<version>/projection-*`, check
 * `b` selected from it, and rows from every repository on the machine appeared in
 * the findings — the material this module chmods `0o700` to protect. `check` is
 * built to run unattended in CI, where nobody reads the SQL.
 *
 * The kind gate stops the `ATTACH` from being submitted; this stops one that got
 * there anyway from surviving. Either alone is a single point of failure on a
 * disclosure path, so both are here.
 *
 * The name is quoted with its `"` doubled: a schema name is caller-supplied text
 * and `AS "we""ird"` is legal.
 *
 * @param database - The connection to sweep
 */
function detachForeignSchemas(database: DatabaseSync): void {
  // `main` is this database and `temp` is its own scratch schema — neither is
  // attachable and neither is detachable. Everything else arrived through a
  // statement.
  const listed = database.prepare('PRAGMA database_list').all() as readonly { name?: unknown }[];
  for (const { name } of listed) {
    if (typeof name !== 'string' || name === 'main' || name === 'temp') continue;
    database.exec(`DETACH DATABASE "${name.replaceAll('"', '""')}"`);
  }
}

/**
 * Gate one caller statement, compile it on a read-only connection, and hand the
 * compiled statement to `step` — the one path both `query` and `assertCompiles`
 * take, so the two cannot disagree on what is admitted.
 *
 * `query_only` is set before `prepare` because `prepare` is where SQLite decides
 * a statement is legal, and a writable connection would compile things this
 * surface must never admit. It is restored in `finally`, FIRST, so a sweep that
 * somehow throws still leaves the connection writable for the handle's own
 * writes. The sweep is unconditional and costs one `PRAGMA database_list` per
 * call — the alternative is trusting that the kind gate is airtight on a path
 * whose failure discloses every repository on the machine. See
 * {@link detachForeignSchemas}.
 *
 * @param database - The connection
 * @param sql - The caller's statement
 * @param parameters - What the caller binds (or will bind)
 * @param step - What to do with the compiled statement
 * @returns Whatever `step` returns
 * @throws The kind, single-statement and placeholder-count refusals, or
 *   SQLite's own for a name the schema lacks
 *
 * Not on the package barrel: the run database and the compile probe call it, and
 * its unit test does.
 */
export function runGated<T>(
  database: DatabaseSync,
  sql: string,
  parameters: readonly SqliteValue[],
  step: (statement: StatementSync) => T,
): T {
  assertSingleStatement(sql);
  assertIsQuery(sql);
  assertParametersBound(sql, parameters);
  database.exec('PRAGMA query_only = 1');
  let failed = false;
  try {
    const statement = database.prepare(sql);
    assertResultColumns(statement);
    return step(statement);
  } catch (error) {
    failed = true;
    // The engine refusing the CALLER'S statement — a name the schema lacks, a
    // write `query_only` stopped — is the same claim the gates above make, so it
    // carries the same code. Anything else — a corrupt file, a lock timeout, a
    // full disk — is the STORE failing and propagates as it was thrown.
    if (isStatementRefusal(error)) throw new VatError(PROJECTION_STATEMENT_REFUSED_CODE, error.message, { cause: error });
    throw error;
  } finally {
    restoreConnection(database, failed);
  }
}

/**
 * Refuse a compiled statement whose RESULT SHAPE cannot be published, read off
 * the statement itself — so `query` and `columns` refuse it identically, though
 * `columns` never steps:
 *
 * - **no result column** — the statement is not a query. `WITH x AS (…) INSERT …`
 *   passes the kind gate on its first keyword and compiles; `query` then meets
 *   `query_only` when it steps, but `columns` would answer `[]` for a write.
 * - **two result columns under one name** — a row is keyed by column name, so
 *   `SELECT 1 AS a, 2 AS a` returns `{ a: 2 }`: one value silently lost, while
 *   `columns` reports two.
 *
 * @param statement - The compiled statement
 * @throws VatError `PROJECTION_STATEMENT_REFUSED`
 */
function assertResultColumns(statement: StatementSync): void {
  const names = statement.columns().map((column) => column.name);
  if (names.length === 0) {
    throw new VatError(PROJECTION_STATEMENT_REFUSED_CODE, 'The statement produces no result column, so it is not a read: only a SELECT, WITH or VALUES that returns rows is admitted.');
  }
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) {
    throw new VatError(
      PROJECTION_STATEMENT_REFUSED_CODE,
      `Two result columns are named "${repeated}". A row is keyed by column name, so one of the two values would be lost — give each column its own alias (AS).`,
    );
  }
}

/**
 * Put the connection back the way `runGated` found it: writable, with no
 * foreign schema attached.
 *
 * 🔑 After a failed step the ORIGINAL failure wins. A connection the fault left
 * unusable (closed, corrupt) makes this restore throw too, and a `finally` that
 * throws replaces the error in flight — so the one thing the caller needed to
 * see, what actually went wrong, would be lost to a secondary "database is not
 * open". The secondary failure is dropped; the connection it concerns is
 * already the subject of the error being thrown. After a SUCCESSFUL step a
 * restore failure is the only failure, and it propagates.
 *
 * @param database - The connection
 * @param stepFailed - Whether an error is already propagating
 */
function restoreConnection(database: DatabaseSync, stepFailed: boolean): void {
  try {
    database.exec('PRAGMA query_only = 0');
    detachForeignSchemas(database);
  } catch (restoreError) {
    if (!stepFailed) throw restoreError;
  }
}

/**
 * SQLite's EXTENDED result codes that mean the STATEMENT was refused, matched
 * exactly:
 *
 * - `SQLITE_ERROR` (1) — a name the schema lacks, a syntax error
 * - `SQLITE_ERROR_MISSING_COLLSEQ` (257) — the statement names a collation that
 *   does not exist
 * - `SQLITE_READONLY` (8) — a write `PRAGMA query_only` stopped
 * - `SQLITE_TOOBIG` (18) — the statement built a string or blob over SQLite's
 *   length limit (`zeroblob(2147483647)`, a `group_concat` over a large corpus)
 * - `SQLITE_RANGE` (25) — a bind index out of range
 *
 * `SQLITE_MISMATCH` (20) is deliberately absent: only a write raises it (a
 * non-integer rowid), and `query_only` refuses every write first, as 8.
 *
 * 🚨 Never masked to the primary code. `& 0xff` folds whole families in, and
 * the READONLY family is mostly the ENVIRONMENT: `READONLY_RECOVERY`,
 * `CANTLOCK`, `ROLLBACK`, `DBMOVED`, `CANTINIT` and `DIRECTORY` are a store
 * whose directory or file went read-only — which a WAL-mode SELECT can meet.
 * `ERROR_RETRY` (513) and `ERROR_SNAPSHOT` (769) are not the statement's
 * fault either.
 */
const STATEMENT_REFUSAL_RESULT_CODES: ReadonlySet<number> = new Set([1, 8, 18, 25, 257]);

/**
 * Whether `error` is SQLite refusing the caller's statement, as opposed to the
 * store itself failing.
 *
 * 🚨 `node:sqlite` reports EVERY SQLite failure under one `code`,
 * `ERR_SQLITE_ERROR` — `SQLITE_BUSY`, `SQLITE_IOERR`, `SQLITE_CORRUPT`,
 * `SQLITE_NOTADB`, `SQLITE_FULL` and `SQLITE_NOMEM` included. Keying on that
 * `code` published a corrupt database as "your statement is wrong". The
 * EXTENDED result code in `errcode`, matched exactly against
 * {@link STATEMENT_REFUSAL_RESULT_CODES}, is what says which failure this is.
 *
 * Exported for its unit test only; not on the package barrel.
 */
export function isStatementRefusal(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const { code, errcode } = error as Error & { code?: unknown; errcode?: unknown };
  return code === 'ERR_SQLITE_ERROR'
    && typeof errcode === 'number'
    && STATEMENT_REFUSAL_RESULT_CODES.has(errcode);
}
