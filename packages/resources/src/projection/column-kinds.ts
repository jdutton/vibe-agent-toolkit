/**
 * What kind of value a projection column holds, read out of its Zod schema.
 *
 * Every storage backend has to answer the same question before it can write a
 * row — Arrow needs a `DataType` per vector, SQLite needs a declared type per
 * column and a binder per value — and the answer is a property of the *row
 * schema*, not of the backend. So the classification lives here, once, beside
 * the registry that says which columns exist at all.
 *
 * It was not always here. `projection-parquet`'s Arrow encoder derived it
 * inline, and a second backend deriving it again would have been the same
 * drift the table registry exists to prevent, one layer down: two cascades
 * agreeing today about which Zod types are JSON-shaped, and disagreeing the
 * first time a column takes a type only one of them was taught.
 *
 * ## The kinds are semantic, not physical
 *
 * `timestamp` says "this column holds an instant", not "store it as
 * milliseconds" — Arrow stores it as `TimestampMillisecond` and SQLite stores
 * it as an ISO-8601 string, and both are correct readings of the same fact.
 * Deciding the physical representation is the backend's job; deciding what the
 * value *is* is this module's.
 *
 * ## Why `json` is always nullable
 *
 * Nullability is otherwise read off the wrapper chain — `.nullable()` and
 * `.optional()` are the only things that put a column's absence in the type.
 * A JSON column is the exception: `realization_conditions.matchedPayload` and
 * `zone_provenance.parameterSet` are typed as `JsonValueSchema`, whose union
 * *includes* `z.null()`, so a null payload is a legal value of a schema that
 * carries no `.nullable()` wrapper. A backend that read the wrapper chain alone
 * would emit `NOT NULL` for a column that can hold null, and the write would
 * fail at runtime on real data.
 */

import { z } from 'zod';

/**
 * What one projection column holds, independent of how a backend stores it.
 *
 * - `text` — a string or an enum member
 * - `integer` — a number the schema constrains to an integer
 * - `real` — any other number
 * - `boolean` — a boolean
 * - `timestamp` — an instant
 * - `json` — an arbitrary JSON value: frontmatter, a condition payload, a
 *   contributor's parameter set
 */
export type ProjectionColumnKind = 'text' | 'integer' | 'real' | 'boolean' | 'timestamp' | 'json';

/** One column's kind, and whether it can hold no value at all. */
export interface ProjectionColumnType {
  /** What the column holds. */
  readonly kind: ProjectionColumnKind;
  /** Whether `null` is a legal value — see this module's note on `json`. */
  readonly nullable: boolean;
}

/**
 * The two facts a backend needs to walk a table column-wise.
 *
 * Structural on purpose: every entry of `PROJECTION_TABLES` satisfies it, so a
 * backend passes the registry entry straight through and never restates a
 * column list of its own.
 */
export interface ProjectionColumnSource<Row extends object> {
  /** Every column, in the order the row schema declares it. */
  readonly columns: readonly (keyof Row & string)[];
  /** The schema one row validates against; supplies each column's type. */
  readonly schema: z.ZodType<Row, z.ZodTypeDef, unknown>;
}

/**
 * The same two facts with the row type erased.
 *
 * Every {@link ProjectionColumnSource} is one of these, and so is every entry of
 * `PROJECTION_TABLES`. Classification needs no row type — it reads the schema,
 * not the values — and demanding one would force a backend iterating all twelve
 * registry entries to reconcile twelve different `Row`s into a union whose
 * common keys are `never`.
 */
export interface ProjectionColumnTypeSource {
  /** Every column, in the order the row schema declares it. */
  readonly columns: readonly string[];
  /** The schema one row validates against; supplies each column's type. */
  readonly schema: z.ZodTypeAny;
}

/** Zod types whose values are arbitrary JSON rather than a scalar. */
const JSON_SHAPED = [z.ZodLazy, z.ZodRecord, z.ZodObject, z.ZodArray, z.ZodUnion, z.ZodTuple] as const;

/**
 * Strip the wrappers that describe a column's *optionality* rather than its
 * type, reporting whether any of them made it nullable.
 *
 * @param schema - Any column schema
 * @returns The schema underneath every optionality wrapper, and whether one of
 *   them admits `null`
 */
function unwrapColumn(schema: z.ZodTypeAny): { readonly inner: z.ZodTypeAny; readonly nullable: boolean } {
  let current = schema;
  let nullable = false;
  for (;;) {
    if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
    } else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      nullable = true;
      current = current.unwrap() as z.ZodTypeAny;
    } else if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
    } else {
      return { inner: current, nullable };
    }
  }
}

/**
 * The kind of a column, from the schema left after its wrappers come off.
 *
 * @param column - The column's name, for the error message
 * @param inner - The unwrapped column schema
 * @returns What the column holds
 * @throws TypeError When the Zod type is one no backend has been taught to store
 */
function kindOf(column: string, inner: z.ZodTypeAny): ProjectionColumnKind {
  if (inner instanceof z.ZodString || inner instanceof z.ZodEnum) {
    return 'text';
  }
  if (inner instanceof z.ZodBoolean) {
    return 'boolean';
  }
  if (inner instanceof z.ZodDate) {
    return 'timestamp';
  }
  if (inner instanceof z.ZodNumber) {
    return inner.isInt ? 'integer' : 'real';
  }
  if (JSON_SHAPED.some((candidate) => inner instanceof candidate)) {
    return 'json';
  }
  throw new TypeError(`Column "${column}" has no storage representation for Zod type ${inner.constructor.name}`);
}

/**
 * The object shape a row schema ultimately validates.
 *
 * Two of the twelve row schemas are wrapped in `.superRefine()`, so their shape
 * lives one `ZodEffects` deep and they have no `.shape` of their own.
 * Unwrapping here rather than at each call site is the difference between a
 * caller that covers all twelve tables and one that silently reports no columns
 * for those two.
 *
 * @param schema - A row schema, possibly wrapped in refinements
 * @returns Its column-name-to-schema shape
 * @throws TypeError When the schema is not an object under its wrappers
 */
export function projectionRowShape(schema: z.ZodTypeAny): z.ZodRawShape {
  const { inner } = unwrapColumn(schema);
  if (!(inner instanceof z.ZodObject)) {
    throw new TypeError('A projection row schema must be a z.object(), optionally wrapped in refinements');
  }
  return inner.shape as z.ZodRawShape;
}

/**
 * Classify one column.
 *
 * @param column - The column's name, for the error message
 * @param schema - The column's schema, or `undefined` when the row schema
 *   declares no such key
 * @returns What the column holds, and whether it may hold nothing
 * @throws TypeError When the column is undeclared, or its Zod type has no
 *   storage representation
 *
 * @example
 * projectionColumnType('mtime', shape.mtime);  // { kind: 'timestamp', nullable: true }
 */
export function projectionColumnType(column: string, schema: z.ZodTypeAny | undefined): ProjectionColumnType {
  if (schema === undefined) {
    throw new TypeError(`Column "${column}" is not declared by the row schema`);
  }
  const { inner, nullable } = unwrapColumn(schema);
  const kind = kindOf(column, inner);
  // A JSON column's own union carries `z.null()`, so the wrapper chain
  // understates it. See this module's header.
  return { kind, nullable: nullable || kind === 'json' };
}

/**
 * Classify every column of a table, in declaration order.
 *
 * @param table - A `PROJECTION_TABLES` entry, or anything with the same two fields
 * @returns Each column paired with what it holds, in the registry's column order
 * @throws TypeError When a column is undeclared or has no storage representation
 *
 * @example
 * for (const [column, type] of projectionColumnTypes(PROJECTION_TABLES.blobs)) { … }
 */
export function projectionColumnTypes(
  table: ProjectionColumnTypeSource,
): readonly (readonly [column: string, type: ProjectionColumnType])[] {
  const shape = projectionRowShape(table.schema);
  return table.columns.map((column) => [column, projectionColumnType(column, shape[column])] as const);
}
