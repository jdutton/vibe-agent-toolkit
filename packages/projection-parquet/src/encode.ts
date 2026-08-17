/**
 * Rows in, Arrow IPC **stream** bytes out — the ingest path into DuckDB.
 *
 * Chosen by measurement over the four alternatives, at 200k rows:
 *
 * | route | time | extra cost |
 * |---|---|---|
 * | Arrow IPC stream (this) | 533 ms | none |
 * | `read_json_auto` | 686 ms | seeds an 820 KB extension |
 * | CSV with full quoting | 796 ms | none |
 * | batched `VALUES` | 7,397 ms | none |
 * | prepared statements | 29,395 ms | none |
 *
 * It also round-trips every null, empty string, embedded newline, quote,
 * backslash and non-ASCII byte exactly, which the two text routes only manage
 * with escaping rules of their own.
 *
 * ## Three constraints, none of them stylistic
 *
 * **1. This module returns bytes, and never an Arrow object.** duckdb-wasm
 * `require`s `apache-arrow` and does not bundle it. `Arrow.node.mjs` and
 * `Arrow.node.js` are two distinct module instances of the identical version —
 * the dual-package hazard — so an ESM caller (which every consumer of this
 * package is) that hands an ESM-built `Table` to duckdb-wasm's CJS writer gets
 * a **0-byte IPC buffer and total, silent data loss**. Measured. Hence
 * `insertArrowTable` is never used, exported or recommended here, and
 * {@link EncodedArrowStream} carries a `Uint8Array`: bytes have no module
 * identity, so nothing can be lost across the seam.
 *
 * **2. The bytes are the `stream` format, not the `file` format.** Feeding
 * file-format bytes to `insertArrowFromIPCStream` is a silent no-op that
 * *permanently poisons the connection*: measured forward-only and
 * irreversible — the insert before it survived, every insert after it did
 * nothing, and nothing ever threw. The two formats differ in their first
 * bytes (`ARROW1` versus a `0xFFFFFFFF` continuation marker), so the test
 * suite pins the actual bytes rather than the intent.
 *
 * **3. The row count comes back with the bytes.** `insertArrowFromIPCStream`
 * never throws for *any* input — empty, truncated, garbage, wrong format — so
 * a post-insert `SELECT count(*)` is the only real guard that the data landed.
 * The count is part of the return type so a caller cannot forget to compare.
 */

import * as arrow from 'apache-arrow';
import { z } from 'zod';

/** Arrow IPC stream bytes, and the number of rows they are supposed to carry. */
export interface EncodedArrowStream {
  /** Arrow IPC **stream**-format bytes, ready for `insertArrowFromIPCStream`. */
  readonly bytes: Uint8Array;
  /**
   * How many rows went in. Compare it against `SELECT count(*)` after
   * inserting: that comparison is the only thing that can detect a failed
   * insert, because the insert itself never reports one.
   */
  readonly rowCount: number;
}

/**
 * The two facts encoding a table needs: which columns, in what order, and the
 * schema that says what each column holds.
 *
 * Structural on purpose — every entry of `PROJECTION_TABLES` satisfies it, so
 * a caller writes `encodeArrowStream(PROJECTION_TABLES.blobs, rows)` and the
 * column order is the registry's, never a second list.
 */
export interface ArrowEncodableTable<Row extends object> {
  /** Every column, in the order it should appear in the Arrow schema. */
  readonly columns: readonly (keyof Row & string)[];
  /** The Zod schema one row validates against; supplies each column's type. */
  readonly schema: z.ZodType<Row, z.ZodTypeDef, unknown>;
}

/** How one column's values become Arrow cells. */
interface ColumnEncoder {
  /** The Arrow type the column's vector is built with. */
  readonly type: arrow.DataType;
  /**
   * Convert one row's value for this column into what the Arrow builder wants.
   *
   * @param value - The value as it appears on the row
   * @returns The cell value, or `null`
   */
  cell(value: unknown): unknown;
}

/** `null` and `undefined` both mean "no value" and both become SQL NULL. */
function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

const TEXT_ENCODER: ColumnEncoder = {
  type: new arrow.Utf8(),
  cell: (value) => value ?? null,
};

const BOOLEAN_ENCODER: ColumnEncoder = {
  type: new arrow.Bool(),
  cell: (value) => value ?? null,
};

const FLOAT_ENCODER: ColumnEncoder = {
  type: new arrow.Float64(),
  cell: (value) => value ?? null,
};

const TIMESTAMP_ENCODER: ColumnEncoder = {
  type: new arrow.TimestampMillisecond(),
  cell: (value) => value ?? null,
};

/**
 * Integers become Arrow `Int64`, which the builder wants as `BigInt`.
 *
 * 🪤 The temptation on the read side is duckdb-wasm's `castBigIntToDouble`.
 * Do not reach for it: it was measured to *bit-reinterpret* int64 values nested
 * inside a STRUCT or LIST, so a stored `7` reads back as `3.5e-323`. Convert at
 * the edge, as here, rather than asking the engine to cast.
 */
const INTEGER_ENCODER: ColumnEncoder = {
  type: new arrow.Int64(),
  cell: (value) => (isAbsent(value) ? null : BigInt(value as number)),
};

/**
 * Nested JSON — parsed frontmatter, condition payloads, contributor parameter
 * sets — is carried as a JSON **string**, in a VARCHAR column.
 *
 * Not an inferred STRUCT, for a measured reason: DuckDB builds a struct type
 * from a *sample* of the input, and any key first seen after that sample window
 * is silently NULL for every row — a data loss with no error attached. A string
 * also means the `json` extension is never needed, which keeps this package's
 * offline story intact.
 */
const JSON_TEXT_ENCODER: ColumnEncoder = {
  type: new arrow.Utf8(),
  cell: (value) => (isAbsent(value) ? null : JSON.stringify(value)),
};

/**
 * Zod wrappers that say something about *optionality*, not about the value's
 * type, and so have to come off before the type can be read.
 *
 * @param schema - Any column schema
 * @returns The schema underneath every optionality/refinement wrapper
 */
function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
    } else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
    } else if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
    } else {
      return current;
    }
  }
}

/** Zod types whose values are arbitrary JSON and are stored as a JSON string. */
const JSON_SHAPED = [z.ZodLazy, z.ZodRecord, z.ZodObject, z.ZodArray, z.ZodUnion, z.ZodTuple] as const;

/**
 * Pick the Arrow representation of one column from its Zod schema.
 *
 * @param column - The column's name, for the error message
 * @param schema - The column's schema, or `undefined` if the row schema has no
 *   such key
 * @returns How to type and fill that column's Arrow vector
 * @throws TypeError When the column is undeclared, or its Zod type has no
 *   Arrow representation here
 */
function columnEncoder(column: string, schema: z.ZodTypeAny | undefined): ColumnEncoder {
  if (schema === undefined) {
    throw new TypeError(`Column "${column}" is not declared by the row schema`);
  }
  const inner = unwrapSchema(schema);
  if (inner instanceof z.ZodString || inner instanceof z.ZodEnum) {
    return TEXT_ENCODER;
  }
  if (inner instanceof z.ZodBoolean) {
    return BOOLEAN_ENCODER;
  }
  if (inner instanceof z.ZodDate) {
    return TIMESTAMP_ENCODER;
  }
  if (inner instanceof z.ZodNumber) {
    return inner.isInt ? INTEGER_ENCODER : FLOAT_ENCODER;
  }
  if (JSON_SHAPED.some((candidate) => inner instanceof candidate)) {
    return JSON_TEXT_ENCODER;
  }
  throw new TypeError(`Column "${column}" has no Arrow representation for Zod type ${inner.constructor.name}`);
}

/**
 * The object shape a row schema ultimately validates.
 *
 * @param schema - A row schema, possibly wrapped in refinements
 * @returns Its column-name-to-schema shape
 * @throws TypeError When the schema is not an object under its wrappers
 */
function rowShape(schema: z.ZodTypeAny): z.ZodRawShape {
  const inner = unwrapSchema(schema);
  if (!(inner instanceof z.ZodObject)) {
    throw new TypeError('A row schema must be a z.object(), optionally wrapped in refinements');
  }
  return inner.shape as z.ZodRawShape;
}

/**
 * Encode rows as Arrow IPC stream bytes.
 *
 * @param table - Column order and row schema — pass a `PROJECTION_TABLES` entry
 * @param rows - The rows to encode; may be empty
 * @returns The stream bytes and the row count to verify them against
 * @throws TypeError When a column is undeclared or has no Arrow representation
 * @throws Error When serialisation produced no bytes at all
 *
 * @example
 * const { bytes, rowCount } = encodeArrowStream(PROJECTION_TABLES.blobs, projection.blobs);
 * await connection.insertArrowFromIPCStream(bytes, { name: 'blobs' });
 * // then: assert SELECT count(*) FROM blobs === rowCount
 */
export function encodeArrowStream<Row extends object>(
  table: ArrowEncodableTable<Row>,
  rows: readonly Row[],
): EncodedArrowStream {
  const shape = rowShape(table.schema);
  const vectors: Record<string, arrow.Vector> = {};
  for (const column of table.columns) {
    const encoder = columnEncoder(column, shape[column]);
    const cells = rows.map((row) => encoder.cell(row[column]));
    vectors[column] = arrow.vectorFromArray(cells, encoder.type);
  }

  const bytes = arrow.RecordBatchStreamWriter.writeAll(new arrow.Table(vectors)).toUint8Array(true);
  if (bytes.length === 0) {
    // Unreachable with a well-formed table, and asserted anyway: a 0-byte
    // buffer is exactly what the dual-package hazard produces, and
    // `insertArrowFromIPCStream` would accept it without a word.
    throw new Error('Arrow IPC serialisation produced no bytes');
  }
  return { bytes, rowCount: rows.length };
}
