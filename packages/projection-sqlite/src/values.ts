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
 */

import type { ProjectionColumnKind } from '@vibe-agent-toolkit/resources';

/** What `node:sqlite` accepts as a bound parameter, for the columns in play. */
export type SqliteValue = null | number | string;

/** What `node:sqlite` hands back in a result row, for the columns in play. */
export type SqliteResultValue = null | number | bigint | string | Uint8Array;

/** `null` and `undefined` both mean "no value" and both become SQL NULL. */
function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * Convert one row value into what SQLite will store.
 *
 * @param kind - The column's kind
 * @param value - The value as it appears on the row
 * @returns A bindable value
 * @throws TypeError When a value cannot be represented — a boolean column
 *   holding something other than a boolean, or a JSON column holding a cyclic
 *   structure. Both are caller bugs, and both would otherwise be stored as
 *   something plausible and wrong.
 */
export function encodeValue(kind: ProjectionColumnKind, value: unknown): SqliteValue {
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
export function decodeValue(kind: ProjectionColumnKind, value: SqliteResultValue): unknown {
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
