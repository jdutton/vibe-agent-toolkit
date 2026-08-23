/**
 * The one authority on what a projection table *is*: SQL name, row schema,
 * primary key, and column order.
 *
 * Twelve tables were enumerated by hand in three places that nothing kept in
 * sync — {@link Projection}'s fields, `exportProjection`'s primary keys, and
 * dev-tools' JSON Schema generator, which listed fifteen because three row
 * schemas that are *not* tables had been folded into the same list. A fourth
 * such list was about to be added for a storage backend, whose `CREATE TABLE`
 * and `INSERT` need exactly the four facts above.
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
 *   lives one `ZodEffects` deep; `projectionRowShape` unwraps rather than each
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
 * The **scope** is the second such fact, and it is what a stored projection is
 * partitioned on. See {@link ProjectionTableScope}.
 *
 * 🚫 There is deliberately no version or digest of this registry. See the note
 * in `schemas/projection-shared.ts` about the `PROJECTION_SCHEMA_VERSION` that
 * used to exist: a number someone has to remember to bump is not a contract.
 */

import type { z } from 'zod';

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

import { projectionRowShape } from './column-kinds.js';
import type { Projection } from './projection.js';

/** The field of {@link Projection} a table's rows are carried under. */
export type ProjectionTableName = keyof Projection;

/**
 * What a table's rows are a fact *about* — the partition any stored projection
 * is cut along.
 *
 * - **`blob`** — every column is a pure function of the content's bytes. Editing
 *   a file yields a different `contentKey`, so a row is correct forever and is
 *   never invalidated. These rows are **global**: two corpora containing the
 *   same bytes share them, which is exactly what makes a store worth sharing.
 * - **`extent`** — the rows describe *what is present in one tree*. A row is
 *   only meaningful in company with the root and the tree it was observed in,
 *   so a store keys these on `(rootId, treeHash)`. Keyed that way they are as
 *   immutable as blob rows are: the extent of a given tree is a pure function
 *   of that tree.
 *
 * The distinction is not derivable — nothing in a Zod object says whether its
 * rows outlive the tree they were observed in — so it is declared here, beside
 * the primary key, and read by every backend rather than restated by each.
 * A backend that stored blob rows per-tree would re-derive facts it already
 * holds; one that stored extent rows globally would serve another tree's
 * contents as this tree's.
 */
export type ProjectionTableScope = 'blob' | 'extent';

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
export interface ProjectionTableSpec<
  Name extends ProjectionTableName,
  Row,
  Scope extends ProjectionTableScope = ProjectionTableScope,
> {
  /** The {@link Projection} field these rows are carried under. */
  readonly key: Name;
  /** The table's snake_case name, as the schema docs and SQL spell it. */
  readonly name: string;
  /** What these rows are a fact about — see {@link ProjectionTableScope}. */
  readonly scope: Scope;
  /** The Zod schema one row of this table validates against. */
  readonly schema: RowSchema<Row>;
  /** The columns that identify a row, in the order they are compared. */
  readonly primaryKey: readonly ColumnOf<Row>[];
  /** Every column, in the order the row schema declares it. */
  readonly columns: readonly ColumnOf<Row>[];
  /**
   * The column naming the resolution context a row belongs to, when it has one.
   *
   * This is what makes a stored extent **divisible**. A store keys extent-scoped
   * rows on `(rootId, treeHash)`, but two commands over one tree ask different
   * questions of it: `vat inventory` declares the filesystem extent plus one
   * closure extent per skill, `vat resources scan` declares the filesystem
   * extent alone. Without this column a write would have to replace the whole
   * key range, so the narrow run would silently delete the broad run's closure
   * extents — and the alternative (folding the request into the tree hash) gives
   * the two runs disjoint keys and stops them sharing the enumeration that is
   * over half the cost.
   *
   * With it, a write replaces only the contexts it produced, and a read takes
   * only the contexts it asked for.
   *
   * Three tables legitimately have none — `roots`, `resources` and
   * `resource_tags` are facts about the *tree* or about an *identity*, not about
   * one extent's view of it, and two contributors that both realize a file
   * contribute the same identity row. Those are merged by primary key rather
   * than partitioned, and a reader reconstructs the subset it is owed by
   * following the references its own contexts' rows carry.
   *
   * Not derivable: `extentId` and `contextId` are two spellings of the same
   * relation (an extent *is* a resolution context), and nothing in a Zod object
   * says which of a row's string columns is the one a store partitions on.
   */
  readonly contextColumn?: ColumnOf<Row> | undefined;
}

/**
 * The twelve tables of the resource projection.
 *
 * Declaration order is {@link Projection}'s own field order, which is also the
 * key order `exportProjection` emits — a document whose table order moved would
 * not be byte-identical to its predecessor even with every row unchanged.
 */
export const PROJECTION_TABLES = {
  roots: table('roots', 'extent', RootRowSchema, ['id']),
  resources: table('resources', 'extent', ResourceRowSchema, ['resourceId']),
  resourceRealizations: table('resourceRealizations', 'extent', ResourceRealizationRowSchema, ['extentId', 'path'], 'extentId'),
  resourceExtents: table('resourceExtents', 'extent', ResourceExtentRowSchema, ['resourceId', 'extentId'], 'extentId'),
  resourceTags: table('resourceTags', 'extent', ResourceTagRowSchema, ['resourceId', 'tag', 'value', 'source']),
  realizationConditions: table('realizationConditions', 'extent', RealizationConditionRowSchema, [
    'extentId',
    'path',
    'code',
    'resourceId',
  ], 'extentId'),
  resolutionContexts: table('resolutionContexts', 'extent', ResolutionContextRowSchema, ['contextId'], 'contextId'),
  zoneProvenance: table('zoneProvenance', 'extent', ZoneProvenanceRowSchema, ['contextId', 'contributorId'], 'contextId'),
  blobs: table('blobs', 'blob', BlobRowSchema, ['contentKey']),
  blobReferences: table('blobReferences', 'blob', BlobReferenceRowSchema, ['blob', 'ordinal']),
  blobSections: table('blobSections', 'blob', BlobSectionRowSchema, ['blob', 'ordinal']),
  blobConditions: table('blobConditions', 'blob', BlobConditionRowSchema, ['blob', 'code', 'line', 'message']),
} as const satisfies { readonly [Name in ProjectionTableName]: ProjectionTableSpec<Name, ProjectionRow<Name>> };

/**
 * Describe one table, deriving everything derivable.
 *
 * `Scope` is a type parameter rather than a plain field so each entry's scope
 * survives as a literal into {@link PROJECTION_TABLES}. That is what lets a
 * consumer split the table names by scope *in the type system* — a store's
 * blob-scoped and extent-scoped row bundles are derived from these literals,
 * so a thirteenth table joins the right bundle by declaring its scope here and
 * nowhere else.
 *
 * @param key - The {@link Projection} field these rows are carried under
 * @param scope - What these rows are a fact about
 * @param schema - The row schema, which supplies the column order
 * @param primaryKey - The columns that identify a row, in comparison order
 * @param contextColumn - The column naming the row's resolution context, for a
 *   table whose rows belong to one; omitted for the three that describe the tree
 *   or an identity rather than one extent's view of it
 * @returns The table's specification
 */
function table<Name extends ProjectionTableName, Scope extends ProjectionTableScope>(
  key: Name,
  scope: Scope,
  schema: RowSchema<ProjectionRow<Name>>,
  primaryKey: readonly ColumnOf<ProjectionRow<Name>>[],
  contextColumn?: ColumnOf<ProjectionRow<Name>>,
): ProjectionTableSpec<Name, ProjectionRow<Name>, Scope> {
  return {
    key,
    name: sqlName(key),
    scope,
    schema,
    primaryKey,
    // Conditional spread rather than `contextColumn: contextColumn`:
    // `exactOptionalPropertyTypes` makes an absent key and one holding
    // `undefined` different values, and "this table has no context column" is
    // the absence.
    ...(contextColumn !== undefined && { contextColumn }),
    // `Object.keys` of a Zod shape is the shape literal's key order, and the
    // cast only re-states what that shape is already typed as one level up.
    columns: Object.keys(projectionRowShape(schema)) as ColumnOf<ProjectionRow<Name>>[],
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
