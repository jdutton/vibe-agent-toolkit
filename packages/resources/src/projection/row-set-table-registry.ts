/**
 * The row-set tables: the third registry beside `PROJECTION_TABLES` and `DERIVED_TABLES`.
 *
 * A row set is every row one instance extracts from one blob read as one variant, identified by
 * `RowSetId` (content key, instance, variant). It is stored, like a blob-scoped table's rows, and is
 * a pure function of the bytes and the variant, but it is its own tier: its own ledger
 * (`row_set_keys`), its own byte budget and its own eviction, so a large data corpus never evicts
 * markdown facts and the blob coverage predicate never reads it. That is why these are not
 * partitioned blob-scoped tables (the harness precedent): those share the blob tier's ledger.
 *
 * Every table belongs to one instance, so its rows carry `blob` and `variant` and the instance is
 * the table's. Every primary key starts `(blob, variant)`. Exactly one table per instance is the
 * **head** (`head: true`): one row per stored row set, so a row set's presence and coverage are read
 * from its head row alone.
 *
 * Relation names follow the ADR's relation naming rule (`<instance>__<relation>`).
 *
 * ⛔ Iterate only through the accessors in `derived-table-registry.ts` (`storedRelationSpecs()`,
 * `queryableRelationSpecs()`); named access (`ROW_SET_TABLES.dataFiles.name`) is fine.
 */

import type { z } from 'zod';

import {
  DATA_INSTANCE,
  DataConditionRowSchema,
  DataDocumentRowSchema,
  DataFileRowSchema,
  DataNodeRowSchema,
  DataVariantSchema,
  type DataConditionRow,
  type DataDocumentRow,
  type DataFileRow,
  type DataNodeRow,
} from '../schemas/projection-data.js';
import {
  TS_INSTANCE,
  TsExportRowSchema,
  TsFileRowSchema,
  TsImportNameRowSchema,
  TsImportRowSchema,
  TsVariantSchema,
  type TsExportRow,
  type TsFileRow,
  type TsImportNameRow,
  type TsImportRow,
} from '../schemas/projection-ts.js';

import { OTHER, projectionRowShape, type ColumnRoles } from './column-kinds.js';
import type { RowSetInstanceId, RowSetVariants } from './row-set-id.js';

/** Each row-set table's row type, by the field its rows are carried under. */
export interface RowSetRowTypes {
  readonly dataFiles: DataFileRow;
  readonly dataDocuments: DataDocumentRow;
  readonly dataNodes: DataNodeRow;
  readonly dataConditions: DataConditionRow;
  readonly tsFiles: TsFileRow;
  readonly tsImports: TsImportRow;
  readonly tsImportNames: TsImportNameRow;
  readonly tsExports: TsExportRow;
}

/** The field a row-set table's rows are carried under. */
export type RowSetTableName = keyof RowSetRowTypes;

/** A column name of a row type. */
type ColumnOf<Row> = keyof Row & string;

/** Everything a consumer needs to read, write, copy or query one row-set table. */
export interface RowSetTableSpec<
  Name extends RowSetTableName,
  Row,
  Head extends boolean = boolean,
  Instance extends RowSetInstanceId = RowSetInstanceId,
> {
  /** Which registry: always `rowSet`. */
  readonly kind: 'rowSet';
  /** The field these rows are carried under. */
  readonly key: Name;
  /** The table's SQL name, `<instance>__<relation>`. */
  readonly name: string;
  /** The instance whose row sets the table holds. */
  readonly instance: Instance;
  /** The variants the instance reads its bytes as. */
  readonly variants: readonly RowSetVariants[Instance][];
  /** Whether this is the instance's head table: one row per stored row set. */
  readonly head: Head;
  /** The Zod schema one row validates against. */
  readonly schema: z.ZodType<Row, z.ZodTypeDef, unknown>;
  /** The columns that identify a row, in comparison order; always `blob, variant, ...`. */
  readonly primaryKey: readonly ColumnOf<Row>[];
  /** Every column, in the order the row schema declares it. */
  readonly columns: readonly ColumnOf<Row>[];
  /** Every `text` and `json` column, classified. */
  readonly columnRoles: ColumnRoles<ColumnOf<Row>>;
}

/** Each instance's variants, as its schema declares them: every table of the instance holds them all. */
const VARIANTS: { readonly [Instance in RowSetInstanceId]: readonly RowSetVariants[Instance][] } = {
  data: DataVariantSchema.options,
  ts: TsVariantSchema.options,
};

/** The row-set tables, in declaration order, instance by instance: each instance's head first. */
export const ROW_SET_TABLES = {
  dataFiles: rowSetTable('dataFiles', 'data__files', DATA_INSTANCE, true, DataFileRowSchema, ['blob', 'variant'], {
    blob: OTHER, variant: OTHER,
  }),
  dataDocuments: rowSetTable('dataDocuments', 'data__documents', DATA_INSTANCE, false, DataDocumentRowSchema, ['blob', 'variant', 'doc'], {
    blob: OTHER, variant: OTHER, rootType: OTHER,
  }),
  // `pointer` and `key` are positions inside one file's value, never a path in a tree.
  dataNodes: rowSetTable('dataNodes', 'data__nodes', DATA_INSTANCE, false, DataNodeRowSchema, ['blob', 'variant', 'doc', 'ordinal'], {
    blob: OTHER, variant: OTHER, pointer: OTHER, key: OTHER, type: OTHER, lexeme: OTHER, tag: OTHER,
  }),
  dataConditions: rowSetTable('dataConditions', 'data__conditions', DATA_INSTANCE, false, DataConditionRowSchema, ['blob', 'variant', 'doc', 'seq'], {
    blob: OTHER, variant: OTHER, code: OTHER, severity: OTHER, message: OTHER,
  }),
  // Every `ts` text column is a name, a specifier or an enum member as the bytes state it: never a
  // path in a tree, since no stored fact depends on where the file is.
  tsFiles: rowSetTable('tsFiles', 'ts__files', TS_INSTANCE, true, TsFileRowSchema, ['blob', 'variant'], {
    blob: OTHER, variant: OTHER,
  }),
  tsImports: rowSetTable('tsImports', 'ts__imports', TS_INSTANCE, false, TsImportRowSchema, ['blob', 'variant', 'ordinal'], {
    blob: OTHER, variant: OTHER, kind: OTHER, specifier: OTHER, specifierForm: OTHER, resolutionMode: OTHER, attributeType: OTHER, scope: OTHER,
  }),
  tsImportNames: rowSetTable('tsImportNames', 'ts__import_names', TS_INSTANCE, false, TsImportNameRowSchema, ['blob', 'variant', 'import', 'seq'], {
    blob: OTHER, variant: OTHER, imported: OTHER, local: OTHER,
  }),
  tsExports: rowSetTable('tsExports', 'ts__exports', TS_INSTANCE, false, TsExportRowSchema, ['blob', 'variant', 'seq'], {
    blob: OTHER, variant: OTHER, name: OTHER, kind: OTHER, local: OTHER, imported: OTHER,
  }),
} as const satisfies { readonly [Name in RowSetTableName]: RowSetTableSpec<Name, RowSetRowTypes[Name]> };

/** An instance some row-set table belongs to. */
export type RowSetInstance = (typeof ROW_SET_TABLES)[RowSetTableName]['instance'];

/** The head tables: one per instance, one row per stored row set. */
export type RowSetHeadTableName = {
  [Name in RowSetTableName]: (typeof ROW_SET_TABLES)[Name]['head'] extends true ? Name : never;
}[RowSetTableName];

/** Some row-set tables' rows, each as a flat array. */
export type RowSetRows = { readonly [Name in RowSetTableName]: readonly RowSetRowTypes[Name][] };

/** Every row-set table's rows, each as an array a holder appends to. */
export type MutableRowSetRows = { -readonly [Name in RowSetTableName]: RowSetRowTypes[Name][] };

/**
 * Describe one row-set table, deriving its column order from its schema.
 *
 * @param key - The field these rows are carried under
 * @param name - The table's SQL name
 * @param instance - The instance whose row sets it holds
 * @param head - Whether it is its instance's head table
 * @param schema - The row schema
 * @param primaryKey - The identifying columns, `blob, variant` first
 * @param columnRoles - Every `text` and `json` column, classified
 * @returns The table's specification
 */
function rowSetTable<Name extends RowSetTableName, Instance extends RowSetInstanceId, Head extends boolean>(
  key: Name,
  name: string,
  instance: Instance,
  head: Head,
  schema: z.ZodType<RowSetRowTypes[Name], z.ZodTypeDef, unknown>,
  primaryKey: readonly ColumnOf<RowSetRowTypes[Name]>[],
  columnRoles: ColumnRoles<ColumnOf<RowSetRowTypes[Name]>>,
): RowSetTableSpec<Name, RowSetRowTypes[Name], Head, Instance> {
  return {
    kind: 'rowSet',
    key,
    name,
    instance,
    variants: VARIANTS[instance],
    head,
    schema,
    primaryKey,
    columnRoles,
    // The shape literal's key order, as `table()` reads it for a projection table.
    columns: Object.keys(projectionRowShape(schema)) as ColumnOf<RowSetRowTypes[Name]>[],
  };
}
