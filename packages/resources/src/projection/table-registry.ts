/**
 * The one authority on what a projection table *is*: SQL name, row schema,
 * primary key, and column order.
 *
 * Twelve tables were enumerated by hand in three places that nothing kept in
 * sync — {@link Projection}'s fields, `exportProjection`'s primary keys, and
 * dev-tools' JSON Schema generator, which listed fifteen because three row
 * schemas that are *not* tables had been folded into the same list. A fourth
 * such list was about to be added for a parquet writer, whose
 * `COPY (SELECT <columns> FROM …)` needs exactly the four facts above.
 *
 * So there is one list, and the others derive from it:
 *
 * - **Completeness is a compile error, both ways.** The `satisfies` clause is a
 *   mapped type over `keyof Projection`, so omitting a table fails to compile
 *   and so does naming one that {@link Projection} does not declare. This is the
 *   same guarantee `ProjectionDocument.tables` gives on the export side,
 *   extended to cover the registry itself.
 * - **Column order is read out of the Zod schema, never restated.** A Zod object
 *   holds its shape as the object literal it was declared with, so `.shape`'s
 *   key order *is* the declaration order — which is the order the row schemas
 *   already document and the order the generated JSON Schemas already carry.
 *   Two of the twelve row schemas are wrapped in `.superRefine()`, so the shape
 *   lives one `ZodEffects` deep; {@link objectShape} unwraps rather than each
 *   caller knowing that.
 * - **The SQL name is derived from the field name.** `resourceRealizations` →
 *   `resource_realizations` holds for all twelve, and the JSON Schema filenames
 *   (`projection-resource-realizations`) are that name with dashes. A hand-kept
 *   spelling here would be the same class of drift one table lower.
 *
 * The **primary key** is the one fact that cannot be derived: nothing in a Zod
 * object says which columns identify a row. It is declared here once, and
 * `exportProjection` reads it rather than restating it — the two must agree,
 * because the export's byte-identity across hosts is a claim about *that* sort.
 *
 * 🚫 There is deliberately no version or digest of this registry. See the note
 * in `schemas/projection-shared.ts` about the `PROJECTION_SCHEMA_VERSION` that
 * used to exist: a number someone has to remember to bump is not a contract.
 */

import { z } from 'zod';

import {
  BlobConditionRowSchema,
  BlobReferenceRowSchema,
  BlobRowSchema,
  BlobSectionRowSchema,
} from '../schemas/projection-blobs.js';
import {
  RealizationConditionRowSchema,
  ResourceExtentRowSchema,
  ResourceRealizationRowSchema,
  ResourceRowSchema,
  ResourceTagRowSchema,
  RootRowSchema,
} from '../schemas/projection-resources.js';
import { ResolutionContextRowSchema, ZoneProvenanceRowSchema } from '../schemas/projection-zones.js';

import type { Projection } from './projection.js';

/** The field of {@link Projection} a table's rows are carried under. */
export type ProjectionTableName = keyof Projection;

/** The row type of one projection table. */
export type ProjectionRow<Name extends ProjectionTableName> = Projection[Name][number];

/** A column name of a row type — every key it declares, and nothing else. */
type ColumnOf<Row> = keyof Row & string;

/**
 * A row schema as declared: output is the row, input is whatever Zod accepts.
 *
 * The input parameter is `unknown` rather than the row type because
 * `resource_realizations.mtime` is a `z.coerce.date()`, so at least one row
 * schema's input genuinely differs from its output.
 */
type RowSchema<Row> = z.ZodType<Row, z.ZodTypeDef, unknown>;

/** Everything a consumer needs to read, write or query one table. */
export interface ProjectionTableSpec<Name extends ProjectionTableName, Row> {
  /** The {@link Projection} field these rows are carried under. */
  readonly key: Name;
  /** The table's snake_case name, as the schema docs and DuckDB spell it. */
  readonly name: string;
  /** The Zod schema one row of this table validates against. */
  readonly schema: RowSchema<Row>;
  /** The columns that identify a row, in the order they are compared. */
  readonly primaryKey: readonly ColumnOf<Row>[];
  /** Every column, in the order the row schema declares it. */
  readonly columns: readonly ColumnOf<Row>[];
}

/**
 * The twelve tables of the resource projection.
 *
 * Declaration order is {@link Projection}'s own field order, which is also the
 * key order `exportProjection` emits — a document whose table order moved would
 * not be byte-identical to its predecessor even with every row unchanged.
 */
export const PROJECTION_TABLES = {
  roots: table('roots', RootRowSchema, ['id']),
  resources: table('resources', ResourceRowSchema, ['resourceId']),
  resourceRealizations: table('resourceRealizations', ResourceRealizationRowSchema, ['extentId', 'path']),
  resourceExtents: table('resourceExtents', ResourceExtentRowSchema, ['resourceId', 'extentId']),
  resourceTags: table('resourceTags', ResourceTagRowSchema, ['resourceId', 'tag', 'value', 'source']),
  realizationConditions: table('realizationConditions', RealizationConditionRowSchema, [
    'extentId',
    'path',
    'code',
    'resourceId',
  ]),
  resolutionContexts: table('resolutionContexts', ResolutionContextRowSchema, ['contextId']),
  zoneProvenance: table('zoneProvenance', ZoneProvenanceRowSchema, ['contextId', 'contributorId']),
  blobs: table('blobs', BlobRowSchema, ['contentKey']),
  blobReferences: table('blobReferences', BlobReferenceRowSchema, ['blob', 'ordinal']),
  blobSections: table('blobSections', BlobSectionRowSchema, ['blob', 'ordinal']),
  blobConditions: table('blobConditions', BlobConditionRowSchema, ['blob', 'code', 'line', 'message']),
} as const satisfies { readonly [Name in ProjectionTableName]: ProjectionTableSpec<Name, ProjectionRow<Name>> };

/**
 * Describe one table, deriving everything derivable.
 *
 * @param key - The {@link Projection} field these rows are carried under
 * @param schema - The row schema, which supplies the column order
 * @param primaryKey - The columns that identify a row, in comparison order
 * @returns The table's specification
 */
function table<Name extends ProjectionTableName>(
  key: Name,
  schema: RowSchema<ProjectionRow<Name>>,
  primaryKey: readonly ColumnOf<ProjectionRow<Name>>[],
): ProjectionTableSpec<Name, ProjectionRow<Name>> {
  return {
    key,
    name: sqlName(key),
    schema,
    primaryKey,
    // `Object.keys` of a Zod shape is the shape literal's key order, and the
    // cast only re-states what that shape is already typed as one level up.
    columns: Object.keys(objectShape(schema)) as ColumnOf<ProjectionRow<Name>>[],
  };
}

/**
 * A table field name as SQL spells it: `blobReferences` → `blob_references`.
 *
 * @param key - The camelCase {@link Projection} field name
 * @returns Its snake_case equivalent
 */
function sqlName(key: string): string {
  return key.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * The object shape under a row schema, however many refinements wrap it.
 *
 * `.superRefine()` returns a `ZodEffects`, not a `ZodObject`, so two of the
 * twelve row schemas have no `.shape` of their own. Unwrapping here rather than
 * at each call site is the difference between a registry that covers all twelve
 * tables and one that silently reports no columns for those two.
 *
 * @param schema - A row schema
 * @returns The shape of the object it ultimately validates
 * @throws TypeError When the schema is not an object under its refinements
 */
function objectShape(schema: z.ZodTypeAny): z.ZodRawShape {
  if (schema instanceof z.ZodEffects) {
    return objectShape(schema.innerType() as z.ZodTypeAny);
  }
  if (schema instanceof z.ZodObject) {
    return schema.shape as z.ZodRawShape;
  }
  throw new TypeError('A projection row schema must be a z.object(), optionally wrapped in refinements');
}
