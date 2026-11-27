/**
 * Row values in and out of SQLite, per column kind.
 *
 * `node:sqlite` binds and returns exactly four JavaScript types — `null`,
 * `number`, `bigint`, `string` (and `Uint8Array` for blobs, which no projection
 * column uses). Three of the six column kinds are therefore not directly
 * storable and need a representation chosen here: a boolean, an instant, and an
 * arbitrary JSON value.
 *
 * **The property that matters is the round trip**, not the encoding: a row
 * written and read back must be the row that went in, still satisfying its Zod
 * schema. Both halves live in this one module for exactly that reason — an
 * encoder and a decoder in different files are two places for the convention to
 * drift, and the drift is silent (a `Date` that reads back as a string still
 * *looks* like data).
 *
 * ## Null and the JSON kind
 *
 * A JSON column stores SQL NULL for the JavaScript value `null` rather than the
 * four characters `null`. That keeps `WHERE parameterSet IS NULL` meaningful,
 * and it is lossless because `null` is the only JSON value that serializes to
 * that token — a *string* `"null"` serializes to `"null"` with the quotes, which
 * survives untouched.
 *
 * ## Rows, not values: the `scalar` kind
 *
 * `node:sqlite` binds every JavaScript `number` as REAL; only a `bigint` binds
 * INTEGER. A data file's `1` and `1.0` are the same JavaScript number, so no
 * per-value encoder can class them apart. A `scalar` column (declared with no
 * type, so SQLite keeps the class it is bound) is therefore encoded from its
 * ROW: its companion `type` column names the source type and its `lexeme`
 * column a number's source text. {@link encodeRow} and {@link decodeRow} are the
 * only entry points an insert and a decode call; {@link encodeKeyValue} binds a
 * lone key or filter value, never a scalar.
 */

import type { ProjectionColumnKind, ProjectionColumnType } from '@vibe-agent-toolkit/resources';

/** What `node:sqlite` accepts as a bound parameter, for the columns in play. */
export type SqliteValue = null | number | bigint | string;

/** What `node:sqlite` hands back in a result row, for the columns in play. */
export type SqliteResultValue = null | number | bigint | string | Uint8Array;

/** A row's columns, each with what it holds, in binding order: what {@link encodeRow} and {@link decodeRow} walk. */
export type RowColumns = readonly (readonly [column: string, type: ProjectionColumnType])[];

/** A column kind whose value encodes alone, without its row. */
type ValueKind = Exclude<ProjectionColumnKind, 'scalar'>;

/** `null` and `undefined` both mean "no value" and both become SQL NULL. */
function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * Encode one row for an insert, in its columns' order: the one way a row reaches SQLite.
 *
 * @param columns - The row's columns and kinds, as `projectionColumnTypes` gives them
 * @param row - The row
 * @returns One bindable value per column
 * @throws TypeError When a value cannot be represented (see {@link encodeValue}
 *   and {@link encodeScalar})
 */
export function encodeRow(columns: RowColumns, row: Readonly<Record<string, unknown>>): SqliteValue[] {
  return columns.map(([column, type]) => (type.kind === 'scalar'
    ? encodeScalar(column, row[column], row[type.companions.type], row[type.companions.lexeme])
    : encodeValue(type.kind, row[column])));
}

/**
 * Decode one stored row: the one way a row leaves SQLite. A scalar is decoded by its row's
 * (decoded) `type` column.
 *
 * @param columns - The row's columns and kinds
 * @param stored - What SQLite returned, by column
 * @returns The row as its schema describes it
 */
export function decodeRow(columns: RowColumns, stored: Readonly<Record<string, SqliteResultValue>>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [column, type] of columns) {
    if (type.kind !== 'scalar') row[column] = decodeValue(type.kind, stored[column] ?? null);
  }
  for (const [column, type] of columns) {
    if (type.kind === 'scalar') row[column] = decodeScalar(stored[column] ?? null, row[type.companions.type]);
  }
  return row;
}

/**
 * Bind one key or filter value as a write binds its column: a delete's key columns, a read's
 * filter values.
 *
 * @param kind - The column's kind
 * @param value - The value
 * @returns A bindable value
 * @throws TypeError For a `scalar` column, whose storage class only its row decides
 */
export function encodeKeyValue(kind: ProjectionColumnKind, value: unknown): SqliteValue {
  if (kind === 'scalar') {
    throw new TypeError('A scalar column cannot be bound alone: its storage class is decided by its row (encodeRow)');
  }
  return encodeValue(kind, value);
}

/**
 * The largest magnitude an integer lexeme may have to be stored as INTEGER: past it, the value
 * the row carries is not the lexeme's, so the double is stored (REAL).
 */
const SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/** An integer lexeme: an optional minus and digits, no `.`, `e` or `E`. */
const INTEGER_LEXEME = /^-?\d+$/u;

/**
 * Encode a `scalar` from its row (see this module's header):
 *
 * - `string`: the string (TEXT);
 * - `boolean`: `1n` or `0n` (INTEGER);
 * - `number` whose lexeme is an integer lexeme in the safe range: `BigInt(lexeme)` (INTEGER), so
 *   `-0` stores the integer 0 and its sign survives only in the lexeme;
 * - any other `number`: the JavaScript number (REAL);
 * - anything else (`null`, `object`, `array`): NULL.
 *
 * @param column - The scalar column, for an error message
 * @param value - The row's value
 * @param type - The row's source type (the `type` companion)
 * @param lexeme - The row's number source text (the `lexeme` companion)
 * @returns The bound value
 * @throws TypeError When the value is not what its type says, or a number has no lexeme
 */
function encodeScalar(column: string, value: unknown, type: unknown, lexeme: unknown): SqliteValue {
  switch (type) {
    case 'string': {
      if (typeof value !== 'string') throw new TypeError(`Scalar "${column}" of type string holds a ${typeof value}`);
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw new TypeError(`Scalar "${column}" of type boolean holds a ${typeof value}`);
      return value ? 1n : 0n;
    }
    case 'number': {
      if (typeof value !== 'number' || typeof lexeme !== 'string') {
        throw new TypeError(`Scalar "${column}" of type number needs a number and its lexeme, got ${typeof value} and ${typeof lexeme}`);
      }
      return integerOfLexeme(lexeme) ?? value;
    }
    default: {
      return null;
    }
  }
}

/**
 * A number's lexeme as an INTEGER, when it is an integer lexeme within the safe range.
 *
 * @param lexeme - The number's source text
 * @returns The bigint, or `undefined` when the number is stored as its double
 */
function integerOfLexeme(lexeme: string): bigint | undefined {
  if (!INTEGER_LEXEME.test(lexeme)) return undefined;
  const integer = BigInt(lexeme);
  return integer >= -SAFE_INTEGER && integer <= SAFE_INTEGER ? integer : undefined;
}

/**
 * Decode a stored `scalar` by its row's source type: a boolean's 1/0 back to `true`/`false`, a
 * number to a JavaScript number, a string to itself, anything else to null.
 *
 * A stored NULL of type `number` is NaN, the one number SQLite binds as NULL, so a decoded row
 * encodes again as extracted.
 *
 * @param stored - What SQLite returned
 * @param type - The row's decoded source type
 * @returns The value
 */
function decodeScalar(stored: SqliteResultValue, type: unknown): unknown {
  if (stored === null) return type === 'number' ? Number.NaN : null;
  switch (type) {
    case 'boolean': {
      return stored !== 0 && stored !== 0n;
    }
    case 'number': {
      return Number(stored);
    }
    case 'string': {
      return String(stored);
    }
    default: {
      return null;
    }
  }
}

/**
 * Convert one row value into what SQLite will store: {@link encodeRow}'s and
 * {@link encodeKeyValue}'s, and theirs only.
 *
 * @param kind - The column's kind
 * @param value - The value as it appears on the row
 * @returns A bindable value
 * @throws TypeError When a value cannot be represented — a boolean column
 *   holding something other than a boolean, or a JSON column holding a cyclic
 *   structure. Both are caller bugs, and both would otherwise be stored as
 *   something plausible and wrong.
 */
function encodeValue(kind: ValueKind, value: unknown): SqliteValue {
  if (isAbsent(value)) return null;
  switch (kind) {
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new TypeError(`A boolean column cannot store ${typeof value}`);
      }
      return value ? 1 : 0;
    }
    case 'timestamp': {
      return encodeTimestamp(value);
    }
    case 'json': {
      return JSON.stringify(value) ?? null;
    }
    case 'integer':
    case 'real': {
      if (typeof value !== 'number') {
        throw new TypeError(`A numeric column cannot store ${typeof value}`);
      }
      return value;
    }
    case 'text': {
      // Strict, like the boolean and numeric cases: every text column holds a
      // string or an enum member, and coercing anything else would store
      // `[object Object]` as though it were data.
      if (typeof value !== 'string') {
        throw new TypeError(`A text column cannot store ${typeof value}`);
      }
      return value;
    }
  }
}

/**
 * Convert one stored value back into what the row schema expects.
 *
 * @param kind - The column's kind
 * @param value - The value SQLite returned
 * @returns The row value
 *
 * @example
 * decodeValue('boolean', 1);                       // true
 * decodeValue('timestamp', '2026-08-18T00:00:00Z'); // Date
 */
function decodeValue(kind: ValueKind, value: SqliteResultValue): unknown {
  if (value === null) return null;
  switch (kind) {
    case 'boolean': {
      return value !== 0 && value !== 0n;
    }
    case 'timestamp': {
      return new Date(String(value));
    }
    case 'json': {
      return JSON.parse(String(value)) as unknown;
    }
    case 'integer':
    case 'real': {
      // `bigint` only appears if a column ever holds a value outside the double
      // range; every integer column here is a count, an offset or a line
      // number, so narrowing keeps the row's declared `number` type honest
      // rather than handing a caller a type its schema does not describe.
      return Number(value);
    }
    case 'text': {
      return String(value);
    }
  }
}

/**
 * An instant, as a string that sorts chronologically and round-trips exactly.
 *
 * A `Date` is the declared type, but `resource_realizations.mtime` is a
 * `z.coerce.date()`, so a caller handing over a row it built from a parsed
 * document may legitimately still be holding the string form. Both are
 * accepted; anything else is a caller bug rather than a value to guess at.
 *
 * 🪤 An invalid `Date` — what `new Date('nonsense')` produces — throws from
 * `toISOString()`. It is caught here and reported as what it is, because the
 * alternative diagnosis a caller would otherwise get is `RangeError: Invalid
 * time value` with no column and no row attached.
 *
 * @param value - A `Date`, or a string a `Date` can be built from
 * @returns ISO-8601, always in UTC
 * @throws TypeError When the value is neither, or is an invalid instant
 */
function encodeTimestamp(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw new TypeError(`A timestamp column cannot store ${typeof value}`);
  }
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError(`A timestamp column cannot store "${String(value)}" — not a valid instant`);
  }
  return instant.toISOString();
}
