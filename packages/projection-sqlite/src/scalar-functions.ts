/**
 * The scalar functions VAT adds to SQLite's own on every connection a statement is compiled or run
 * on: the run database and the preflight compile probe alike, so a statement the probe admits is
 * one the run can answer.
 *
 * `sha256(x)`, because a check comparing a value to a recorded digest had no way to compute one, and
 * `regexp(pattern, text[, flags])`, which is also what SQLite's `text REGEXP pattern` operator calls,
 * because a check pulling a name out of free text had no way to match one. Each is registered
 * `deterministic`: a pure function of its arguments, which is what
 * lets SQLite use it in an index expression or fold it, and what keeps a check's verdict a function
 * of the tree.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { PROJECTION_STATEMENT_REFUSED_CODE } from '@vibe-agent-toolkit/resources';
import { VatError } from '@vibe-agent-toolkit/utils';

/**
 * A call the statement got wrong, refused as the statement's fault: the code the SQL gate refuses a
 * statement with, so `vat resources query` exits `USAGE_INVALID` and a check is broken naming it,
 * never an internal error.
 *
 * @param message - What the call got wrong and how to fix it
 * @returns The refusal to throw
 */
function refusedCall(message: string): VatError {
  return new VatError(PROJECTION_STATEMENT_REFUSED_CODE, message);
}

/**
 * `sha256(x)`: the lowercase hex SHA-256 of `x`, the spelling a content key carries its digest in.
 * TEXT is hashed as its UTF-8 bytes, a BLOB as its bytes, and NULL answers NULL.
 *
 * ⛔ A number is refused rather than hashed as text: SQLite spells `1.0` as `1.0` and JavaScript as
 * `1`, so whichever spelling this chose, one of `sha256(1.0)` and `sha256(CAST(1.0 AS TEXT))` would
 * silently disagree with the other. `CAST(x AS TEXT)` says which bytes are meant.
 *
 * @param value - The argument as SQLite hands it over
 * @returns The digest, or null
 * @throws VatError For an INTEGER or REAL argument, naming the CAST
 */
function sha256(value: SQLInputValue): string | null {
  if (value === null) return null;
  if (typeof value === 'string' || ArrayBuffer.isView(value)) return createHash('sha256').update(value).digest('hex');
  throw refusedCall('sha256() takes TEXT or BLOB; for a number, CAST(x AS TEXT) first to say which spelling is hashed.');
}

/** The flags `regexp` accepts beside the `u` it always sets: case-insensitive, multiline, dot-all. */
const REGEXP_FLAGS = /^[ims]*$/;

/** Compiled patterns by flags and source; past the bound the oldest is dropped. */
const compiled = new Map<string, RegExp>();
const COMPILED_BOUND = 256;

/** The pattern compiled with `u` and `flags`; refuses one that does not compile, naming it. */
function patternOf(source: string, flags: string): RegExp {
  const key = `${flags}/${source}`;
  const held = compiled.get(key);
  if (held !== undefined) return held;
  let pattern: RegExp;
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp -- the pattern IS the caller's question; the hazard is documented with the function
    pattern = new RegExp(source, `u${flags}`);
  } catch (error) {
    throw refusedCall(`regexp() could not compile the pattern "${source}" (a JavaScript RegExp, u flag): ${(error as Error).message}`);
  }
  if (compiled.size >= COMPILED_BOUND) compiled.delete(compiled.keys().next().value as string);
  compiled.set(key, pattern);
  return pattern;
}

/**
 * `regexp(pattern, text[, flags])`: 1 when the JavaScript RegExp `pattern` matches anywhere in
 * `text`, else 0; NULL when either is NULL or `text` is not TEXT. SQLite's `text REGEXP pattern`
 * calls it with two.
 *
 * The flavour is ECMAScript's, always with the `u` flag (a code point outside the BMP is one
 * character, and an escape the `u` grammar does not define is an error rather than a literal), and
 * never `g` or `y`, whose `lastIndex` state would make one row's answer depend on the last. `flags`
 * may add `i`, `m` and `s`. Anchor with `^` and `$` for a whole-value match.
 *
 * ⚠️ V8's engine backtracks: a pattern with nested quantifiers (`(a+)+$`) can take exponential time on
 * a long non-matching text, and nothing here interrupts it. The run's own budget bounds it (`vat
 * resources check` stops at its default budget; `vat resources query --budget`).
 *
 * @param source - The pattern, TEXT
 * @param text - The text, TEXT
 * @param flags - Optional flags, TEXT
 * @returns 1, 0 or null
 * @throws VatError For a non-TEXT pattern or flags, a flag outside `i`, `m`, `s`, or a pattern that does not compile
 */
function regexp(source: SQLInputValue, text: SQLInputValue, flags: SQLInputValue = ''): number | null {
  if (source === null || text === null || flags === null) return null;
  if (typeof source !== 'string' || typeof flags !== 'string') {
    throw refusedCall('regexp() takes its pattern and flags as TEXT.');
  }
  if (!REGEXP_FLAGS.test(flags)) throw refusedCall(`regexp() flags may be any of i, m, s; got "${flags}".`);
  const pattern = patternOf(source, flags);
  // Not TEXT is not matched, so a mixed-type column (`data__values.value`) is asked row by row.
  return typeof text === 'string' ? Number(pattern.test(text)) : null;
}

/**
 * Register VAT's scalar functions on one connection.
 *
 * @param database - A connection a statement will be compiled or run on
 */
export function registerScalarFunctions(database: DatabaseSync): void {
  database.function('sha256', { deterministic: true }, sha256);
  // `node:sqlite` registers by declared arity, which a default parameter does not count.
  database.function('regexp', { deterministic: true }, (source: SQLInputValue, text: SQLInputValue) => regexp(source, text));
  database.function('regexp', { deterministic: true }, (source: SQLInputValue, text: SQLInputValue, flags: SQLInputValue) => regexp(source, text, flags));
}
