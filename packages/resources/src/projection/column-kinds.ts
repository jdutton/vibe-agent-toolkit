/**
 * What kind of value a projection column holds, read out of its Zod schema.
 *
 * Every storage backend has to answer the same question before it can write a
 * row — SQLite needs a declared type per column and a binder per value, a
 * columnar encoder would need a `DataType` per vector — and the answer is a
 * property of the *row schema*, not of the backend. So the classification lives
 * here, once, beside the registry that says which columns exist at all.
 *
 * It was not always here: the first backend derived it inline, and a second one
 * deriving it again would have been the same drift the table registry exists to
 * prevent, one layer down — two cascades agreeing today about which Zod types
 * are JSON-shaped, and disagreeing the first time a column takes a type only one
 * of them was taught. Deriving it once is what keeps a backend from having an
 * opinion about the schema.
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
 * fail at runtime on real data. A `scalar` column is nullable for the same
 * reason: its union carries `z.null()`.
 *
 * ## Why `scalar` is a Zod subclass
 *
 * A data file's value (`data__nodes.value`) is a string, a number, a boolean or
 * null, and its storage class must follow the value's source type: `1` an
 * integer, `1.0` a real, `true` an integer 1. A JavaScript number cannot say
 * which of `1` and `1.0` it came from, so a backend encodes the value from the
 * whole row, reading the columns the scalar names as its companions (`type` and
 * `lexeme`). A plain union classifies as `json`, so the kind is carried by the
 * schema's own class, {@link ZodScalar}, whose companions live in its `_def`:
 * `.describe()` rebuilds a schema through `this.constructor` with the same
 * `_def`, so the class and the companions survive it.
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
 * - `scalar` — a string, a number, a boolean or null, whose storage class its
 *   row's companion columns decide (see {@link ScalarCompanions})
 */
export type ProjectionColumnKind = 'text' | 'integer' | 'real' | 'boolean' | 'timestamp' | 'json' | 'scalar';

/**
 * The columns of the same row a `scalar` column's encoding reads: `type` names
 * the value's source type (`string`, `number`, `boolean`, ...), `lexeme` a
 * number's source text.
 */
export interface ScalarCompanions {
  /** The column holding the value's source type. */
  readonly type: string;
  /** The column holding a number's source text. */
  readonly lexeme: string;
}

/** One column's kind, and whether it can hold no value at all; a `scalar` also names its companions. */
export type ProjectionColumnType =
  | {
    /** What the column holds. */
    readonly kind: Exclude<ProjectionColumnKind, 'scalar'>;
    /** Whether `null` is a legal value — see this module's note on `json`. */
    readonly nullable: boolean;
  }
  | {
    readonly kind: 'scalar';
    /** Always true: the union carries `z.null()`. */
    readonly nullable: boolean;
    /** The row's columns its encoding reads. */
    readonly companions: ScalarCompanions;
  };

/** The four value types a scalar admits. */
const SCALAR_OPTIONS = [z.string(), z.number(), z.boolean(), z.null()] as const;

/** A scalar's Zod definition: a union's, plus the companions. */
interface ZodScalarDef extends z.ZodUnionDef<typeof SCALAR_OPTIONS> {
  readonly companions: ScalarCompanions;
}

/**
 * A `scalar` column's schema: a union of string, number, boolean and null that
 * classifies as `scalar` and carries its companions. Build one with
 * {@link scalarColumn}.
 */
export class ZodScalar extends z.ZodUnion<typeof SCALAR_OPTIONS> {
  declare readonly _def: ZodScalarDef;

  /** The row's columns this scalar's encoding reads. */
  get companions(): ScalarCompanions {
    return this._def.companions;
  }
}

/**
 * A `scalar` column: a string, a number, a boolean or null.
 *
 * @param companions - The row's columns holding the value's source type and a number's source text
 * @returns The column's schema
 *
 * @example
 * value: scalarColumn({ type: 'type', lexeme: 'lexeme' }).describe('The value of a scalar node')
 */
export function scalarColumn(companions: ScalarCompanions): ZodScalar {
  const def: ZodScalarDef = { ...z.union(SCALAR_OPTIONS)._def, companions: { ...companions } };
  return new ZodScalar(def);
}

/**
 * What a `text` or `json` column holds, for a reader asking whether its value means the same thing
 * in a run holding more than one root.
 *
 * - `rootRelativePath` — a path (or a path prefix), or a value carrying one, stated against the root
 *   the row was observed under. Two roots can each hold `docs/a.md`, so in a run holding both, a
 *   relation carrying one of these and no `root` column cannot say which root a row's path is under.
 *   A `json` column is this when any value inside it is (`zone_provenance.parameterSet` holds a
 *   closure's `closureFrom` and `traverseGlobs`).
 * - `other` — anything else: an id, a hash, an enum member, authored text, or an ABSOLUTE path
 *   (`roots.path`), which names its root by itself.
 */
export type ColumnRole = 'rootRelativePath' | 'other';

/** {@link ColumnRole}'s path member, named once for the registries. */
export const ROOT_RELATIVE_PATH: ColumnRole = 'rootRelativePath';

/** {@link ColumnRole}'s other member, named once for the registries. */
export const OTHER: ColumnRole = 'other';

/**
 * Every `text` and `json` column of one relation, classified — the two kinds that can carry a path.
 * Declared, because nothing in a Zod string or JSON value says what a path in it is relative to;
 * held both ways against the `text` and `json` columns {@link projectionColumnTypes} reads off the
 * schema, so an unclassified column and a stale entry are both test failures.
 */
export type ColumnRoles<Column extends string = string> = Readonly<Partial<Record<Column, ColumnRole>>>;

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
 * not the values — and demanding one would force a backend iterating every
 * registry entry to reconcile their different `Row`s into a union whose
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
 * The kind of a column that is not a {@link ZodScalar}, from the schema left after its wrappers
 * come off. A scalar is classified before this is asked: it IS a union, which reads as json here.
 *
 * @param column - The column's name, for the error message
 * @param inner - The unwrapped column schema
 * @returns What the column holds
 * @throws TypeError When the Zod type is one no backend has been taught to store
 */
function kindOf(column: string, inner: z.ZodTypeAny): Exclude<ProjectionColumnKind, 'scalar'> {
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
 * Two of the row schemas are wrapped in `.superRefine()`, so their shape
 * lives one `ZodEffects` deep and they have no `.shape` of their own.
 * Unwrapping here rather than at each call site is the difference between a
 * caller that covers every table and one that silently reports no columns
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
  if (inner instanceof ZodScalar) {
    // The union carries `z.null()`, like a JSON column's. See this module's header.
    return { kind: 'scalar', nullable: true, companions: inner.companions };
  }
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
 * @throws TypeError When a column is undeclared or has no storage representation, or a `scalar`
 *   column names a companion the table does not list
 *
 * @example
 * for (const [column, type] of projectionColumnTypes(PROJECTION_TABLES.blobs)) { … }
 */
export function projectionColumnTypes(
  table: ProjectionColumnTypeSource,
): readonly (readonly [column: string, type: ProjectionColumnType])[] {
  const shape = projectionRowShape(table.schema);
  const types = table.columns.map((column) => [column, projectionColumnType(column, shape[column])] as const);
  for (const [column, type] of types) {
    if (type.kind !== 'scalar') continue;
    // A backend encodes a scalar from these columns of the same row: one the row lacks would
    // encode every value as null, silently.
    for (const companion of [type.companions.type, type.companions.lexeme]) {
      if (!table.columns.includes(companion)) {
        throw new TypeError(`Scalar column "${column}" names companion "${companion}", which the row does not declare`);
      }
    }
  }
  return types;
}
