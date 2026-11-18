/**
 * The gate every caller statement passes before it reaches SQLite: no NUL, one
 * statement, a query by its first keyword, exactly one value per placeholder,
 * nothing attached, and a compiled program that reads no schema, no connection
 * state and no relation the statement does not name, and writes nothing —
 * compiled on a read-only connection with every foreign schema detached after.
 *
 * Every piece of state is the owning handle's ({@link GateConnection}); this
 * module holds none, so nothing one connection learned can answer for another.
 *
 * Shared by the two handles that take a caller's SQL — the run database, which
 * runs it, and the compile probe, which only compiles it — so the two cannot
 * disagree on what is admitted. The storage port takes no SQL and never reaches
 * this module.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import {
  identifierSpellings,
  PROJECTION_STATEMENT_REFUSED_CODE,
  queryableRelationNames,
  quoteIdentifier,
  relationsNamedBy,
  SQL_IDENTIFIER_CHAR,
  SQL_WHITESPACE,
  SQL_WORD_START_CHAR,
  sqlSpanAt,
  type SqlToken,
  sqlTokens,
} from '@vibe-agent-toolkit/resources';
import { countWork, VatError } from '@vibe-agent-toolkit/utils';

import type { SqliteValue } from './values.js';

/** The leading run of letters, which is the only thing the statement-kind gate reads. */
const LEADING_KEYWORD = /^[a-z]+/i;

/**
 * The statement kinds this surface runs.
 *
 * ⚠️ A gate on statement KIND, read from one token without knowing anything about
 * what follows: it decides whether the caller submitted a *query* at all. It is
 * not what refuses a write. `WITH c(a) AS (VALUES (1)) DELETE FROM x` passes
 * this; the program gate ({@link assertProgramAdmitted}) then refuses it before
 * it runs, because its compiled program opens a write transaction, and
 * `PRAGMA query_only` stays armed as a second guard for any write a step reaches.
 *
 * 🚫 `EXPLAIN` is deliberately absent even though it is genuinely side-effect
 * free — measured on Node 24.13.1, `EXPLAIN ATTACH DATABASE '/tmp/x.db' AS x`
 * returns eight opcode rows and creates no file. It is out because it is a
 * PREFIX: admitting it would mean any statement can wear a token this gate
 * accepts, and deciding safety would then require looking *past* the first
 * token, which is the SQL inspection this project has settled against. Its rows
 * are SQLite bytecode rather than projection facts, and the schema-diagnostic
 * path reads `PROJECTION_TABLES` in-process instead — so nothing wants it yet,
 * and pre-1.0 there is no cost to adding it the day something does. (The gate
 * prepares `EXPLAIN` itself, to read what a statement opens; a caller never
 * does.)
 */
const QUERY_STATEMENT_KEYWORDS: readonly string[] = ['SELECT', 'WITH', 'VALUES'];

/**
 * Walk past a comment beginning at `index`.
 *
 * Two callers need *only* comments: what may follow a terminating `;`, and what
 * may precede the first keyword, are both "whitespace and comments" — a string
 * literal in either position is trailing text SQLite would discard, not
 * decoration. Where a comment ends is the shared lexer's ({@link sqlSpanAt}), the
 * one the relation scan reads too: a second scanner is how a quoting form one of
 * them missed once desynchronised the two (``SELECT 1 AS `a'b`; DELETE FROM
 * blobs`` swallowed the real `;`).
 *
 * @param sql - The statement text
 * @param index - Where to look
 * @returns Index just past the comment, or `index` unchanged when none starts here
 */
function skipComment(sql: string, index: number): number {
  const span = sqlSpanAt(sql, index);
  return span?.kind === 'comment' ? span.end : index;
}

/**
 * Walk past a string literal, quoted identifier or comment beginning at `index`.
 *
 * @param sql - The statement text
 * @param index - Where to look
 * @returns Index just past it, or `index` unchanged when none starts here
 */
function skipLiteralOrComment(sql: string, index: number): number {
  return sqlSpanAt(sql, index)?.end ?? index;
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
    } else if (SQL_WHITESPACE.test(sql[index] ?? '')) {
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

/**
 * The characters SQLite's tokenizer admits in a parameter name after a sigil: its name characters,
 * which are letters, digits, the underscore, the dollar sign and every character from U+0080 up.
 * The dollar sign is one of them, so `#$`, `@$`, `:$` and `$$` are parameters; a class without it
 * let them through to bind NULL. Held to the engine by `parameter-scan.test.ts`, which asks SQLite
 * about every sigil and printable character.
 */
const PARAMETER_NAME_CHAR = SQL_IDENTIFIER_CHAR;

/** What may open a bare identifier or number token: a name character that is not `$`. */
const TOKEN_START_CHAR = SQL_WORD_START_CHAR;

/**
 * The sigils that open a NAMED parameter, which positional values never reach.
 *
 * 🪤 `#` is SQLite's fourth, and leaving it out was a hole: `WHERE path = #p` bound NULL and
 * answered at exit 0, and `WHERE path <> #p(') ; SELECT 'x` dropped its tail. Every named form is
 * refused whatever follows its name — SQLite's `::name` and `(...)` suffixes included — because the
 * refusal fires on the sigil and the first name character.
 */
const NAMED_PARAMETER_SIGILS: ReadonlySet<string> = new Set([':', '@', '$', '#']);

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
 * A bare identifier or number is stepped past whole, as SQLite's tokenizer reads it: `$` is a
 * name character, so `a$b` is one identifier and never the parameter `$b`.
 *
 * Exported for its unit test only; not on the package barrel.
 *
 * @param sql - The statement text
 * @returns The slot count, and the first unreachable placeholder if there is one
 */
export function countBoundParameters(sql: string): { readonly slots: number; readonly unreachable: string | undefined } {
  let slots = 0;
  let unreachable: string | undefined;
  let index = 0;
  while (index < sql.length) {
    const skipped = skipLiteralOrComment(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (TOKEN_START_CHAR.test(sql[index] ?? '')) {
      index = indexPastRun(sql, index, PARAMETER_NAME_CHAR);
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
 * Refuse a statement carrying a NUL character.
 *
 * 🪤 SQLite reads a statement only up to its first NUL and drops the rest without error, so
 * `SELECT 1 AS x\u0000 WHERE 0` answers a row its author wrote a `WHERE` to exclude. No scanner
 * here stops at a NUL, so each would judge text the engine never compiles.
 *
 * @param sql - The caller's statement text
 * @throws If the text holds a NUL
 */
function assertNoNul(sql: string): void {
  if (!sql.includes('\u0000')) return;
  throw new VatError(
    PROJECTION_STATEMENT_REFUSED_CODE,
    'This statement holds a NUL character. SQLite compiles only the text before it and discards the rest without error, so the statement would not run as written.',
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
 * ⚠️ **This is a gate on statement KIND.** It reads exactly one token and knows
 * nothing about the rest. A write that begins with a query keyword is refused
 * before it runs by the program gate, which reads the compiled program, with
 * `PRAGMA query_only` as a second guard. See {@link QUERY_STATEMENT_KEYWORDS}
 * for what is admitted and why `EXPLAIN` is not.
 *
 * It is also the first of the two things standing between this surface and
 * another database on disk: `ATTACH` is not a query, so it never reaches the
 * engine that would have accepted it.
 *
 * The program gate holds a second, independent layer of this refusal
 * ({@link refusalAsSubquery}), so a keyword list loosened here does not admit a `PRAGMA`.
 * Exported for its unit test only; not on the package barrel.
 *
 * @param sql - The caller's statement text
 * @throws If the first significant token is not a query keyword
 */
export function assertIsQuery(sql: string): void {
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
  for (const name of foreignSchemas(database)) {
    database.exec(`DETACH DATABASE "${name.replaceAll('"', '""')}"`);
  }
}

/**
 * Every schema attached to the connection but `main` and `temp`.
 *
 * `main` is this database and `temp` is its own scratch schema — neither is attachable and neither
 * is detachable. Everything else arrived through a statement.
 *
 * @param database - The connection
 * @returns The attached schemas' names
 */
function foreignSchemas(database: DatabaseSync): readonly string[] {
  const listed = database.prepare('PRAGMA database_list').all() as readonly { name?: unknown }[];
  return listed
    .map(({ name }) => name)
    .filter((name): name is string => typeof name === 'string' && name !== 'main' && name !== 'temp');
}

/**
 * The table-valued functions a statement may open as a virtual table: the four JSON walkers, which
 * read a column's value and nothing about the database. Every other virtual table — `dbstat`,
 * every `pragma_*` function — describes the database itself.
 */
const REFERENCE_VIRTUAL_TABLES: readonly string[] = ['json_each', 'json_tree', 'jsonb_each', 'jsonb_tree'];

/**
 * The functions that answer about the CONNECTION rather than the rows: what the last write
 * changed, and which rowid it inserted — here, which relations hydration filled.
 */
const CONNECTION_STATE_FUNCTIONS: ReadonlySet<string> = new Set(['changes', 'total_changes', 'last_insert_rowid']);

/** The text `EXPLAIN` prints for a virtual-table pointer: `vtab:` and the address in hex. */
const VIRTUAL_TABLE_POINTER = /^vtab:[0-9a-f]+$/i;

/**
 * One handle's private gate state: its connection, and the virtual-table pointers of the four
 * {@link REFERENCE_VIRTUAL_TABLES} on THAT connection.
 *
 * 🔑 Read when the handle is constructed, held by it, and never memoized at module scope: SQLite
 * reuses virtual-table addresses across connections, so a pointer read on one connection can name a
 * different module on another — a refused `dbstat` was seen landing on a former `json_each` address
 * 235 times in 200 connections.
 */
export interface GateConnection {
  /** The connection every gated statement compiles on. */
  readonly database: DatabaseSync;
  /** The four admitted virtual-table pointers, as `EXPLAIN` prints them on this connection. */
  readonly referenceVirtualTables: ReadonlySet<string>;
  /**
   * Which relation each root page of `main` holds — a table's own page and each of its indexes'
   * pages — so an `OpenRead` names the relation it reads. Filled by {@link openGate} and refilled
   * by {@link refreshRelationPages} after the handle creates a relation.
   */
  readonly relationOfRootPage: Map<number, string>;
}

/** One row of an `EXPLAIN` program: the fields the gate reads. */
interface ExplainedOp {
  readonly opcode?: unknown;
  readonly p2?: unknown;
  readonly p3?: unknown;
  readonly p4?: unknown;
}

/** The opcodes that open a cursor on a stored table or index for reading. */
const READ_OPEN_OPCODES: ReadonlySet<string> = new Set(['OpenRead', 'ReopenIdx']);

/**
 * Open the gate state for one handle's connection, reading the reference pointers off it.
 *
 * Each read is an `EXPLAIN`, counted as `statement.explained`: four per handle, one per
 * {@link REFERENCE_VIRTUAL_TABLES} member, whether or not this runtime has it.
 *
 * 🪤 Whichever members THIS runtime's SQLite has: `jsonb_each` and `jsonb_tree` arrived in SQLite
 * 3.51.0, so a Node whose SQLite is older (22.16.0 ships 3.49.1) lacks them, and a later Node 22
 * (22.23.3 ships 3.51.3) has them. An absent member is not admitted and has no
 * pointer to read; a statement naming it fails `no such table` in the gate's own `EXPLAIN`, which is
 * a statement refusal like any other.
 *
 * @param database - The handle's connection
 * @returns The gate state the handle holds for its whole life
 * @throws Error When `EXPLAIN` shows no virtual-table open for a member this runtime has — a
 *   driver invariant, since nothing could then be told apart from it
 */
export function openGate(database: DatabaseSync): GateConnection {
  const pointers = REFERENCE_VIRTUAL_TABLES.flatMap((name) => {
    const program = explainReference(database, name);
    if (program === undefined) return [];
    const pointer = program.find((op) => op.opcode === 'VOpen')?.p4;
    if (typeof pointer !== 'string' || !VIRTUAL_TABLE_POINTER.test(pointer)) {
      throw new Error(`EXPLAIN shows no virtual-table pointer for ${name} on this connection, so no statement could be gated.`);
    }
    return [pointer];
  });
  const gate: GateConnection = { database, referenceVirtualTables: new Set(pointers), relationOfRootPage: new Map() };
  refreshRelationPages(gate);
  return gate;
}

/** SQLite's plain `SQLITE_ERROR`, with no extended code: a statement the schema cannot compile. */
const SQLITE_ERROR = 1;

/**
 * The `EXPLAIN` of one reference function over an empty array, or undefined when this runtime's
 * SQLite has no such function.
 *
 * Read off the extended result code, never the message: the statement is fixed and well-formed, so
 * plain `SQLITE_ERROR` (1) compiling it can only be the name it calls being absent (SQLite says
 * `no such table: <name>`). Every other code — a busy, corrupt or closed connection — propagates.
 *
 * @param database - The handle's connection
 * @param name - A {@link REFERENCE_VIRTUAL_TABLES} member
 * @returns Its program, or undefined when absent
 * @throws Any other failure, as thrown
 */
function explainReference(database: DatabaseSync, name: string): readonly ExplainedOp[] | undefined {
  try {
    return explain(database, `SELECT * FROM ${name}('[]')`);
  } catch (error) {
    if (isStatementRefusal(error) && (error as Error & { errcode?: unknown }).errcode === SQLITE_ERROR) return undefined;
    throw error;
  }
}

/**
 * Re-read which relation each root page of `main` holds, after the handle created a relation.
 *
 * Read from `sqlite_schema` by the handle itself, never by a caller statement: tables and indexes,
 * each under the table it belongs to. Not an `EXPLAIN`, so `statement.explained` does not move.
 *
 * @param gate - The handle's gate state
 */
function refreshRelationPages(gate: GateConnection): void {
  const pages = gate.database
    .prepare("SELECT tbl_name, rootpage FROM main.sqlite_schema WHERE type IN ('table', 'index') AND rootpage > 0")
    .all() as readonly { tbl_name?: unknown; rootpage?: unknown }[];
  gate.relationOfRootPage.clear();
  for (const { tbl_name: relation, rootpage } of pages) {
    if (typeof relation === 'string' && typeof rootpage === 'number') gate.relationOfRootPage.set(rootpage, relation);
  }
}

/**
 * {@link refreshRelationPages} after a handle's own write, which may have failed.
 *
 * 🔑 After a failed write the ORIGINAL failure wins, as in {@link restoreConnection}: a connection
 * the fault left unusable makes this refresh throw too, and a `finally` that throws replaces the
 * error in flight. The secondary failure is dropped then; after a successful write it is the only
 * failure, and it propagates.
 *
 * @param gate - The handle's gate state
 * @param writeFailed - Whether an error is already propagating
 */
export function refreshRelationPagesAfter(gate: GateConnection, writeFailed: boolean): void {
  try {
    refreshRelationPages(gate);
  } catch (refreshError) {
    if (!writeFailed) throw refreshError;
  }
}

/**
 * The `EXPLAIN` program of one statement, counted.
 *
 * @param database - The connection
 * @param sql - The statement
 * @returns Its opcodes
 */
function explain(database: DatabaseSync, sql: string): readonly ExplainedOp[] {
  countWork('statement.explained', 1);
  return database.prepare(`EXPLAIN ${sql}`).all() as readonly ExplainedOp[];
}

/**
 * Refuse a statement that observes the database rather than its rows: which relations exist, how
 * they are stored, or what the connection last did.
 *
 * 🔑 Read off the compiled program, never the text: `EXPLAIN` shows what SQLite will OPEN, so an
 * alias (`dbstat AS json_each`) or a spelling the planner reads but a scanner would miss changes
 * nothing. Refused:
 *
 * - an `OpenRead` of root page 1 — the schema table, `sqlite_schema` by any of its names;
 * - a `VOpen` whose pointer is not one of this connection's four {@link REFERENCE_VIRTUAL_TABLES},
 *   or does not read as a pointer at all — `dbstat` and every `pragma_*` function;
 * - a call of a {@link CONNECTION_STATE_FUNCTIONS} member.
 *
 * And, from the same program, a statement whose answer would not be its own:
 *
 * - a relation reached through a single-quoted name ({@link assertNoQuotedRelation}) — SQLite
 *   reads `FROM 'blobs'` as the table when one exists, and a run holds every relation some
 *   declared statement names, so such a statement answered only while another named its relation;
 * - an `OpenRead` of a relation the statement does not NAME ({@link relationsNamedBy}), by any
 *   other route;
 * - a write transaction (`Transaction` with a non-zero `p2`) — refused before it runs, on
 *   `query`, `columns` and the compile probe alike, for any write that compiles as a subquery.
 *   `PRAGMA query_only` stays armed as a further guard for any write a step reaches;
 * - a statement SQLite will not compile as a subquery ({@link refusalAsSubquery}) — a `PRAGMA`
 *   by any spelling, and a write behind a `WITH` (`WITH … DELETE … RETURNING` passes the kind
 *   gate). This is the kind gate's second layer: {@link assertIsQuery} reads the leading keyword,
 *   this asks the engine's grammar and reads no token itself, and each refuses a `PRAGMA` alone.
 *   It runs before the statement is compiled as written, since compiling a setting `PRAGMA`
 *   applies it, and its refusal carries SQLite's own error: a query at SQLite's nesting limits,
 *   which compiles alone but not one level deeper, is refused this way too.
 *
 * Exported for its unit test only; not on the package barrel.
 *
 * A relation the run did not hydrate fails the subquery compile first, and is refused carrying
 * SQLite's own error.
 *
 * @param gate - The handle's gate state
 * @param sql - The caller's statement
 * @throws VatError `PROJECTION_STATEMENT_REFUSED` naming what the statement would observe or read
 * @throws Error When an `OpenRead` names a root page no relation holds — a driver invariant
 */
export function assertProgramAdmitted(gate: GateConnection, sql: string): void {
  // FIRST, before anything compiles the statement as written: SQLite applies a setting PRAGMA when
  // it compiles one (`EXPLAIN PRAGMA recursive_triggers = 1` flips the setting), so a refusal that
  // came after the statement compiled would leave its effect on the run's connection.
  const subqueryRefusal = refusalAsSubquery(gate.database, sql);
  if (subqueryRefusal !== undefined) throw notASubquery(subqueryRefusal);
  assertOpcodesAdmitted(gate, sql);
}

/**
 * {@link assertProgramAdmitted} less its subquery check: the opcode rules, each a backstop that
 * refuses alone (the write rule is otherwise unreached). Exported for its unit test only; never
 * call it on a statement the subquery check has not admitted.
 *
 * @param gate - The handle's gate state
 * @param sql - The caller's statement
 * @throws VatError `PROJECTION_STATEMENT_REFUSED` naming what the statement would observe or read
 */
export function assertOpcodesAdmitted(gate: GateConnection, sql: string): void {
  const program = explain(gate.database, sql);
  assertNoQuotedRelation(gate, sql);
  const named = new Set(relationsNamedBy(sql, queryableRelationNames()).map((name) => name.toLowerCase()));
  for (const op of program) {
    assertOpAdmitted(gate, sql, op, named);
  }
}

/**
 * Why SQLite will not compile the statement as a subquery, or undefined when it will: the second
 * layer of the kind gate, and the one that does not read the leading keyword.
 *
 * SQLite's grammar admits only a `SELECT`, a `WITH … SELECT` or a `VALUES` inside `EXISTS (…)`, so
 * compiling the statement there asks the engine what kind of statement it is. A `PRAGMA` — which
 * returns rows, so the result-column check would not stop it, and whose program opens nothing the
 * opcode checks refuse — fails to compile there however it is spelled, and the wrapper itself is a
 * `SELECT`, so compiling it applies nothing. So does a write behind a `WITH`.
 *
 * The statement goes in up to its terminating `;` and with a newline before the closing `)`, so a
 * trailing `-- note` cannot swallow it; an unclosed trailing `/*` ends the text at its last token.
 * Compiled, never stepped, and not an `EXPLAIN`: `statement.explained` does not move.
 *
 * @param database - The connection, read-only for the caller's statements
 * @param sql - The caller's statement
 * @returns SQLite's refusal of the wrapped statement, or undefined when it compiled
 * @throws Any failure that is not a statement refusal, as thrown
 */
function refusalAsSubquery(database: DatabaseSync, sql: string): Error | undefined {
  try {
    database.prepare(`SELECT EXISTS (\n${statementBody(sql)}\n)`);
    return undefined;
  } catch (error) {
    if (!isStatementRefusal(error)) throw error;
    return error;
  }
}

/**
 * The refusal of a statement SQLite will not compile as a subquery, carrying SQLite's own error.
 *
 * 🔑 A `PRAGMA`, a typo and a depth limit all fail here, and only SQLite's error tells them
 * apart, so it comes FIRST, untouched, on its own line: a typo reads as a typo.
 *
 * @param cause - SQLite's refusal of it as a subquery
 * @returns The coded error
 */
function notASubquery(cause: Error): VatError {
  return new VatError(
    PROJECTION_STATEMENT_REFUSED_CODE,
    `${cause.message}\n`
    + 'SQLite gave that error compiling the statement as a subquery, and only a SELECT, a WITH ... SELECT'
    + ' or a VALUES compiles as a subquery: that compile is how a projection statement is confirmed to be'
    + ' a query that only reads, and how a PRAGMA or a write behind a WITH is refused.',
    { cause },
  );
}

/**
 * The statement's text from its start to the end of its last token, before any terminating `;`.
 *
 * @param sql - A statement the single-statement gate admitted
 * @returns The text a subquery can hold
 */
function statementBody(sql: string): string {
  const tokens = sqlTokens(sql);
  const terminator = tokens.findIndex((token) => token.kind === 'punctuation' && token.value === ';');
  const last = terminator === -1 ? tokens.at(-1) : tokens[terminator - 1];
  return sql.slice(0, last?.end ?? 0);
}

/**
 * Refuse a statement that reaches a relation through a single-quoted name, such as `FROM 'blobs'`.
 *
 * SQLite reads a string where a table name belongs as that table when one exists, and as a string
 * everywhere else, so the text alone cannot say which `'blobs'` is which. The engine can: each
 * string literal spelling a relation this connection holds is replaced with `''`, which names no
 * relation, and the statement is compiled again. A literal read as a string compiles the same; one
 * read as a table now fails `no such table`, and the statement is refused. A statement whose
 * literals spell no held relation costs nothing more.
 *
 * Refused even when the statement also names the relation as an identifier (`SELECT blobs.k FROM
 * 'blobs'`): what is refused is the single-quoted name, so the rule reads the same whatever else the
 * statement says.
 *
 * The refusal names the relation as the run holds it, beside the literal as the caller typed it
 * (`'BLOBS'` reads the table `blobs`), and it names the literal SQLite read as a table: each
 * candidate is emptied alone, and the one whose emptying fails is it. That costs one `EXPLAIN` per
 * candidate, on the refusal path only.
 *
 * @param gate - The handle's gate state
 * @param sql - The caller's statement, which compiles as written
 * @throws VatError `PROJECTION_STATEMENT_REFUSED` naming the relation, the literal and the identifier spellings
 */
function assertNoQuotedRelation(gate: GateConnection, sql: string): void {
  const held = new Map([...gate.relationOfRootPage.values()].map((relation) => [relation.toLowerCase(), relation]));
  const spelled = sqlTokens(sql).filter((token) => token.kind === 'string' && held.has(token.value.toLowerCase()));
  if (spelled.length === 0 || compilesWith(gate, withEmptyStrings(sql, spelled))) return;
  const literal = spelled.find((candidate) => !compilesWith(gate, withEmptyStrings(sql, [candidate]))) ?? spelled[0];
  const typed = literal?.value ?? '';
  const relation = held.get(typed.toLowerCase()) ?? typed;
  throw new VatError(
    PROJECTION_STATEMENT_REFUSED_CODE,
    `This statement reads the table ${relation} through the single-quoted name '${typed}'. A single-quoted`
    + ` '${typed}' is a string, which SQLite reads as a table only when one by that name exists. Name it as`
    + ` an identifier: ${identifierSpellings(relation).join(', ')}.`,
  );
}

/**
 * Whether a statement compiles on the handle's connection, through a counted `EXPLAIN`.
 *
 * @param gate - The handle's gate state
 * @param sql - The statement
 * @returns False when SQLite refuses the statement
 * @throws Any failure that is not a statement refusal, as thrown
 */
function compilesWith(gate: GateConnection, sql: string): boolean {
  try {
    explain(gate.database, sql);
    return true;
  } catch (error) {
    if (!isStatementRefusal(error)) throw error;
    return false;
  }
}

/**
 * The statement with each of `literals` replaced by the empty string `''`.
 *
 * @param sql - The statement
 * @param literals - String tokens of it, in order
 * @returns The rewritten text
 */
function withEmptyStrings(sql: string, literals: readonly SqlToken[]): string {
  let rewritten = '';
  let at = 0;
  for (const literal of literals) {
    rewritten += `${sql.slice(at, literal.start)}''`;
    at = literal.end;
  }
  return rewritten + sql.slice(at);
}

/**
 * Refuse one opcode of a caller's program; see {@link assertProgramAdmitted}.
 *
 * @param gate - The handle's gate state
 * @param sql - The caller's statement, to name a refused virtual table from
 * @param op - The opcode
 * @param named - The relations the statement names, lower-cased
 */
function assertOpAdmitted(gate: GateConnection, sql: string, { opcode, p2, p3, p4 }: ExplainedOp, named: ReadonlySet<string>): void {
  if (typeof opcode === 'string' && READ_OPEN_OPCODES.has(opcode)) {
    if (p2 === 1) throw introspectionRefusal('reads the schema table, which lists the relations this run holds');
    assertReadsNamed(gate, p2, p3, named);
  }
  if (opcode === 'VOpen' && !(typeof p4 === 'string' && gate.referenceVirtualTables.has(p4))) {
    const table = virtualTableNamed(gate, sql, p4);
    const opened = table === undefined ? 'a virtual table' : `the virtual table ${table}`;
    throw introspectionRefusal(
      `opens ${opened}, which describes the database rather than its rows; the only virtual tables`
      + ` admitted are ${REFERENCE_VIRTUAL_TABLES.join(', ')}`,
    );
  }
  if ((opcode === 'Function' || opcode === 'PureFunc') && CONNECTION_STATE_FUNCTIONS.has(functionNameOf(p4))) {
    throw introspectionRefusal(`calls ${functionNameOf(p4)}(), which answers about the connection rather than the rows`);
  }
  if (opcode === 'Transaction' && p2 !== 0) {
    throw new VatError(
      PROJECTION_STATEMENT_REFUSED_CODE,
      'This statement writes: its compiled program opens a write transaction. A projection query only reads.',
    );
  }
}

/**
 * The name of the virtual table a refused `VOpen` opens, or undefined when no name the statement
 * spells opens it.
 *
 * `EXPLAIN` prints a virtual table as a pointer, never a name, and an alias (`dbstat AS json_each`)
 * hides it from the text. So each name the statement spells, bare or quoted, that this connection
 * knows as a virtual table is opened alone on the same connection, and the one whose `VOpen`
 * carries the same pointer is the table: an eponymous virtual table has one instance per
 * connection. Run on the refusal path only: two reads of what the connection knows, then one
 * counted `EXPLAIN` per distinct virtual-table name the statement spells — never one per word, so a
 * long `IN (…)` list costs nothing.
 *
 * @param gate - The handle's gate state
 * @param sql - The caller's statement
 * @param pointer - The refused `VOpen`'s `p4`
 * @returns The table's name as the statement spells it, or undefined
 * @throws Any failure that is not a statement refusal, as thrown
 */
function virtualTableNamed(gate: GateConnection, sql: string, pointer: unknown): string | undefined {
  if (typeof pointer !== 'string') return undefined;
  const known = knownVirtualTables(gate.database);
  const spelled = new Set(sqlTokens(sql)
    .filter((token) => token.kind === 'word' || token.kind === 'quotedIdentifier')
    .map((token) => token.value.toLowerCase())
    .filter((name) => known.has(name)));
  for (const name of spelled) {
    let program: readonly ExplainedOp[];
    try {
      program = explain(gate.database, `SELECT * FROM ${quoteIdentifier(name)}`);
    } catch (error) {
      if (!isStatementRefusal(error)) throw error;
      continue;
    }
    if (program.some((op) => op.opcode === 'VOpen' && op.p4 === pointer)) return name;
  }
  return undefined;
}

/**
 * Every refused virtual table this connection can open by name, lower-cased: each registered
 * module (`dbstat`, `fts5`, …) and the `pragma_<name>` function of each pragma, less the
 * reference tables. Read on the refusal path only.
 *
 * @param database - The connection
 * @returns The names
 */
function knownVirtualTables(database: DatabaseSync): ReadonlySet<string> {
  const names = (pragma: string): string[] =>
    (database.prepare(`PRAGMA ${pragma}`).all() as readonly { name?: unknown }[])
      .flatMap(({ name }) => (typeof name === 'string' ? [name.toLowerCase()] : []));
  return new Set([...names('module_list'), ...names('pragma_list').map((name) => `pragma_${name}`)]
    .filter((name) => !REFERENCE_VIRTUAL_TABLES.includes(name)));
}

/**
 * Refuse a read of a relation the statement does not name.
 *
 * @param gate - The handle's gate state
 * @param rootPage - The `OpenRead`'s root page
 * @param schema - The `OpenRead`'s schema index: 0 is `main`
 * @param named - The relations the statement names, lower-cased
 * @throws VatError `PROJECTION_STATEMENT_REFUSED` naming the relation and how to name it
 * @throws Error When no relation of `main` holds the page — a driver invariant
 */
function assertReadsNamed(gate: GateConnection, rootPage: unknown, schema: unknown, named: ReadonlySet<string>): void {
  const relation = schema === 0 && typeof rootPage === 'number' ? gate.relationOfRootPage.get(rootPage) : undefined;
  if (relation === undefined) {
    throw new Error(`The statement's program reads root page ${String(rootPage)} of schema ${String(schema)}, which no relation of this run holds.`);
  }
  if (named.has(relation.toLowerCase())) return;
  throw new VatError(
    PROJECTION_STATEMENT_REFUSED_CODE,
    `This statement reads ${relation} without naming it: a statement reads a relation only when it names it`
    + ` itself as an identifier — ${identifierSpellings(relation).join(', ')}. Name it as an identifier.`,
  );
}

/**
 * The function an `EXPLAIN` `Function` opcode calls, from its `p4`: `changes(0)` → `changes`.
 *
 * @param p4 - The opcode's fourth operand
 * @returns The name, or `''` when the operand is not text
 */
function functionNameOf(p4: unknown): string {
  return typeof p4 === 'string' ? p4.slice(0, Math.max(0, p4.indexOf('('))).toLowerCase() : '';
}

/**
 * The refusal of a statement that observes the database.
 *
 * @param what - What the statement does, completing "This statement …"
 * @returns The coded error
 */
function introspectionRefusal(what: string): VatError {
  return new VatError(
    PROJECTION_STATEMENT_REFUSED_CODE,
    `This statement ${what}. A projection query reads the projection's rows; ask about a relation by naming it.`,
  );
}

/**
 * Refuse to compile anything while a schema other than `main` and `temp` is attached.
 *
 * A guard for later steps rather than a refusal of the caller's statement: nothing attaches today
 * (the kind gate refuses `ATTACH`, and {@link detachForeignSchemas} sweeps after every call), so a
 * schema found here is a driver defect, and it is thrown uncoded.
 *
 * @param database - The connection
 * @throws Error When a foreign schema is attached
 */
function assertNoAttachedSchema(database: DatabaseSync): void {
  const foreign = foreignSchemas(database);
  if (foreign.length > 0) {
    const named = foreign.map((name) => JSON.stringify(name)).join(', ');
    throw new Error(
      `Schema ${named} is attached to the run's connection, so a statement`
      + ' could read a database other than this run\'s. Nothing may be attached while a statement compiles.',
    );
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
 * The program gate ({@link assertProgramAdmitted}) runs inside the same read-only, coded-refusal
 * span as the real prepare, so its `EXPLAIN` failing on an unhydrated relation carries the
 * statement code.
 *
 * @param gate - The owning handle's private gate state
 * @param sql - The caller's statement
 * @param parameters - What the caller binds (or will bind)
 * @param step - What to do with the compiled statement
 * @returns Whatever `step` returns
 * @throws The NUL, kind, single-statement, placeholder-count and program refusals, or
 *   SQLite's own for a name the schema lacks; an uncoded Error when a schema is attached
 *
 * Not on the package barrel: the run database and the compile probe call it, and
 * its unit test does.
 */
export function runGated<T>(
  gate: GateConnection,
  sql: string,
  parameters: readonly SqliteValue[],
  step: (statement: StatementSync) => T,
): T {
  const { database } = gate;
  assertNoNul(sql);
  assertSingleStatement(sql);
  assertIsQuery(sql);
  assertParametersBound(sql, parameters);
  assertNoAttachedSchema(database);
  database.exec('PRAGMA query_only = 1');
  let failed = false;
  try {
    assertProgramAdmitted(gate, sql);
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
 * - **no result column** — the statement is not a query. A write such as
 *   `WITH x AS (…) INSERT …` is refused earlier by the program gate; this is the
 *   backstop for any statement that compiles to no column without writing.
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
