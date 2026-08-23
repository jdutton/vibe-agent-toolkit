/**
 * Emitting a {@link Projection} as a document. **No engine** (zones.md §15
 * step 6).
 *
 * This module emits rows. It does not index them, does not join them, does not
 * filter them, and accepts no query. Anything that reads like a query is a
 * lens's job, over the projection, and belongs nowhere near here — the whole
 * point of materialising twelve flat tables is that the consumer chooses the
 * engine (DuckDB, a JSON reader, a golden diff) rather than inheriting one.
 *
 * ## Two properties the emitted document must have
 *
 * 1. **No absolute path survives.** `roots.path` is an absolute filesystem path
 *    by design and is the only column that carries one — every other path in
 *    the projection is root-relative. It is replaced with
 *    {@link ROOT_PATH_PLACEHOLDER}. This is not hypothetical tidiness: VAT has
 *    already shipped a lane whose evidence leaked `$HOME`. A root is identified
 *    by `roots.id` and joined through `resolution_contexts.rootId`, so nothing
 *    downstream reads `path` back — federation was the reason it is a table at
 *    all, not the reason it is a path.
 * 2. **Byte-identical across runs.** Every table is sorted by its primary key,
 *    and every row's keys are emitted in the registry's column order.
 *    Insertion order is not a stable input: one of `crawlDirectory`'s two routes
 *    enumerates in **filesystem order**, and ext4, APFS and NTFS all differ. An
 *    export carrying insertion order would make any golden host-dependent, which
 *    is the specific failure a golden exists to rule out.
 *
 * The sort is by primary key rather than by whole-row canonical form so the
 * ordering a reader sees is the ordering the schema documents. Numeric key
 * columns (`blob_references.ordinal`, `blob_sections.ordinal`) compare
 * numerically — string order would place 10 before 2.
 *
 * ## Why key order is a property of the export and not of the producer
 *
 * Row order was for a while the only ordering this module imposed, and it was
 * not enough: `JSON.stringify` writes an object's keys in the order that object
 * holds them, so two rows carrying identical values in different key orders are
 * different bytes. A row is not built in one place. `blobReferencesFor` assigns
 * ordinals with `{ ...row, ordinal }`, landing `ordinal` **last** even though it
 * is that table's second column and half its primary key; the same row read back
 * out of a storage backend is rebuilt from the registry's columns, where
 * `ordinal` is second. Nothing about the values differs, and the documents did.
 *
 * Chasing that through the producers would mean every future producer having to
 * know it must not spread, which is a rule nothing can enforce and one nobody
 * would think to apply to the twelfth table. So the order is imposed here,
 * uniformly, out of {@link PROJECTION_TABLES} — the same declaration a storage
 * backend rebuilds rows from. A cold export and a store-hydrated export of the
 * same corpus agree by construction rather than by both happening to be right.
 */

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';

import type { Projection } from './projection.js';
import {
  PROJECTION_TABLES,
  type ProjectionRow,
  type ProjectionTableName,
  type ProjectionTableSpec,
} from './table-registry.js';

/**
 * What `roots.path` holds in an exported document.
 *
 * A single constant rather than a per-root token: `roots.id` already tells two
 * federated roots apart, and a per-root placeholder would only re-encode the
 * ordering of a path column that no longer exists.
 */
export const ROOT_PATH_PLACEHOLDER = '<root>';

/**
 * An exported projection: the twelve tables, and nothing else.
 *
 * The tables stay nested under one key rather than spread across the document
 * so a consumer can enumerate exactly the tables without filtering metadata out
 * of the same object. `tables` is typed as {@link Projection} itself, so adding
 * a thirteenth table is a compile error here rather than a silently unexported
 * one.
 *
 * `tables.roots` still satisfies `RootRowSchema` — the placeholder is a
 * non-empty string — so a redacted document round-trips through the row schemas
 * unchanged.
 *
 * There is no `schemaVersion`. It carried a hand-bumped integer that no reader
 * ever branched on; see the note where that constant used to live, in
 * `schemas/projection-shared.ts`, for what replaces it if a projection is ever
 * *stored* rather than returned in-process.
 */
export interface ProjectionDocument {
  /** The twelve tables, each sorted by its primary key. */
  readonly tables: Projection;
}

/** A single component of a primary key. */
type KeyPart = string | number | boolean | null;

/**
 * A row carried a column {@link PROJECTION_TABLES} does not declare.
 *
 * Thrown rather than dropped. Emitting a row through the registry's columns is
 * what makes key order a property of the export, and the same projection
 * silently deletes any column the registry has not been taught about — a
 * producer that grows a field and a registry nobody updated would otherwise
 * yield an export that is clean, deterministic and missing data. An export can
 * survive being noisy; it cannot survive being quietly incomplete.
 *
 * The fix is always to declare the column on the row schema, never to filter it
 * out here: the schema is what the JSON Schema generator and every storage
 * backend read, so a column this export knows about and they do not is the same
 * drift one layer along.
 */
export class UnregisteredProjectionColumnError extends Error {
  /** The table's snake_case name, as the registry and SQL spell it. */
  readonly table: string;

  /** The offending columns, in the order the row held them. */
  readonly columns: readonly string[];

  /**
   * @param table - The table's snake_case name
   * @param columns - Columns the row held that the registry does not declare
   */
  constructor(table: string, columns: readonly string[]) {
    super(
      `Table "${table}" carries column(s) the projection table registry does not declare:`
      + ` ${columns.join(', ')}.`
      + ' Declare them on the table\'s row schema rather than dropping them here —'
      + ' the registry is what the storage backends and the JSON Schema generator read.',
    );
    this.name = 'UnregisteredProjectionColumnError';
    this.table = table;
    this.columns = columns;
  }
}

/**
 * Emit a projection as a deterministic, path-free document.
 *
 * Every table is named once, and the object literal is checked against
 * {@link Projection}, so a thirteenth table is still a compile error here. What
 * is no longer restated is the **primary keys** or the **column order**: both
 * are read out of {@link PROJECTION_TABLES}, which is the same declaration a
 * storage backend and the JSON Schema generator read. A key that disagreed
 * between the sort and the schema used to be a silent possibility; now it is not
 * representable.
 *
 * `roots` is the one table rewritten after emission. Overriding `path` on an
 * already-emitted row leaves the key where it was — assigning a key an object
 * already holds does not move it — so the redaction cannot disturb the column
 * order the emitter just imposed.
 *
 * @param projection - The projection to emit
 * @returns The document: twelve primary-key-sorted tables, roots redacted
 * @throws {UnregisteredProjectionColumnError} If a row carries a column the
 *   table registry does not declare
 */
export function exportProjection(projection: Projection): ProjectionDocument {
  return {
    tables: {
      roots: emitTable(projection, 'roots').map((row) => ({ ...row, path: ROOT_PATH_PLACEHOLDER })),
      resources: emitTable(projection, 'resources'),
      resourceRealizations: emitTable(projection, 'resourceRealizations'),
      resourceExtents: emitTable(projection, 'resourceExtents'),
      resourceTags: emitTable(projection, 'resourceTags'),
      realizationConditions: emitTable(projection, 'realizationConditions'),
      resolutionContexts: emitTable(projection, 'resolutionContexts'),
      zoneProvenance: emitTable(projection, 'zoneProvenance'),
      blobs: emitTable(projection, 'blobs'),
      blobReferences: emitTable(projection, 'blobReferences'),
      blobSections: emitTable(projection, 'blobSections'),
      blobConditions: emitTable(projection, 'blobConditions'),
    },
  };
}

/**
 * Serialize a projection to JSON.
 *
 * Two calls over the same projection produce identical bytes, as do two
 * projections built from the same rows contributed in different orders — the
 * property that makes a golden of this output meaningful. So do a projection a
 * population derived and the same projection read back out of a store: rows
 * come out in primary-key order and every row's keys come out in the registry's
 * column order, so neither the order rows were contributed in nor the order a
 * producer happened to build a row's keys in reaches the bytes. A golden
 * committed from a cold run matches the same corpus exported warm.
 *
 * `mtime` becomes an ISO-8601 string, which is `Date`'s own JSON form — the
 * emitter reorders keys and copies values, so a `Date` arrives here as a `Date`.
 *
 * @param projection - The projection to serialize
 * @returns Pretty-printed JSON with a trailing newline
 * @throws {UnregisteredProjectionColumnError} If a row carries a column the
 *   table registry does not declare
 */
export function serializeProjection(projection: Projection): string {
  return `${JSON.stringify(exportProjection(projection), undefined, 2)}\n`;
}

/**
 * Emit one table: rows in primary-key order, keys in registry column order.
 *
 * Both orderings come out of the same spec, and both are load-bearing for the
 * same reason — see this module's header on why key order could not be left to
 * the producers.
 *
 * Copies rather than sorting in place: a built projection's tables are frozen,
 * and a caller's live table must not be reordered by the act of exporting it.
 *
 * @param projection - The projection to read the table out of
 * @param name - Which table
 * @returns A new array of new rows, in primary-key order
 * @throws {UnregisteredProjectionColumnError} If a row carries a column the
 *   registry does not declare
 */
function emitTable<Name extends ProjectionTableName>(
  projection: Projection,
  name: Name,
): ProjectionRow<Name>[] {
  // The registry is declared with a mapped type over `keyof Projection`, so
  // `PROJECTION_TABLES[name]` is this table's spec by construction; the compiler
  // just cannot see through the generic parameter to say so.
  const spec = PROJECTION_TABLES[name] as ProjectionTableSpec<Name, ProjectionRow<Name>>;
  const rows = projection[name] as readonly ProjectionRow<Name>[];
  // Built once per table rather than once per row: the membership test below
  // runs over every key of every row, and a table can carry millions.
  const declared = new Set<string>(spec.columns);
  return [...rows]
    .sort((left, right) => compareKeys(keyOf(left, spec.primaryKey), keyOf(right, spec.primaryKey)))
    .map((row) => inColumnOrder(row, spec, declared));
}

/**
 * Rebuild one row with its keys in the registry's declared column order.
 *
 * Undeclared columns are found **first** and thrown on, so the error names the
 * whole surplus rather than whichever key the loop happened to reach. See
 * {@link UnregisteredProjectionColumnError} for why this is a throw.
 *
 * The membership test is `in` rather than `row[column] !== undefined`: this
 * package compiles under `exactOptionalPropertyTypes`, where an absent key and
 * a key holding `undefined` are genuinely different values — the same
 * distinction `table-registry.ts` spreads `contextColumn` conditionally to
 * preserve. Copying the absence is what makes this a reordering rather than a
 * rewrite, and values are copied by reference, so a `Date` stays a `Date`.
 *
 * @param row - The row as its producer built it
 * @param spec - The table's registry entry, which supplies the column order
 * @param declared - `spec.columns` as a set, for the surplus test
 * @returns A new row holding the same values, keyed in column order
 * @throws {UnregisteredProjectionColumnError} If the row carries a column the
 *   registry does not declare
 */
function inColumnOrder<Name extends ProjectionTableName>(
  row: ProjectionRow<Name>,
  spec: ProjectionTableSpec<Name, ProjectionRow<Name>>,
  declared: ReadonlySet<string>,
): ProjectionRow<Name> {
  const surplus = Object.keys(row).filter((column) => !declared.has(column));
  if (surplus.length > 0) {
    throw new UnregisteredProjectionColumnError(spec.name, surplus);
  }
  const ordered: Record<string, unknown> = {};
  for (const column of spec.columns) {
    if (column in row) {
      ordered[column] = (row as Record<string, unknown>)[column];
    }
  }
  return ordered as ProjectionRow<Name>;
}

/**
 * Read a row's primary key out of it, in column order.
 *
 * @param row - The row
 * @param primaryKey - The key columns, in comparison order
 * @returns The key components
 */
function keyOf<Row>(row: Row, primaryKey: readonly (keyof Row & string)[]): readonly KeyPart[] {
  return primaryKey.map((column) => row[column] as KeyPart);
}

/**
 * Compare two primary keys component by component.
 *
 * Both keys come from the same extractor, so they always have the same arity;
 * `?? null` covers the index type rather than a reachable case.
 *
 * @param left - First key
 * @param right - Second key
 * @returns Negative, zero or positive per the `Array.prototype.sort` contract
 */
function compareKeys(left: readonly KeyPart[], right: readonly KeyPart[]): number {
  for (const [index, part] of left.entries()) {
    const order = comparePart(part, right[index] ?? null);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

/**
 * Compare one key component, numerically when the column is numeric.
 *
 * A key column has one type across a table, so the numeric branch is taken for
 * every row of `blob_references.ordinal` or for none.
 *
 * @param left - First component
 * @param right - Second component
 * @returns Negative, zero or positive per the `Array.prototype.sort` contract
 */
function comparePart(left: KeyPart, right: KeyPart): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  return compareCodeUnits(stringifyPart(left), stringifyPart(right));
}

/**
 * Render a key component for code-unit comparison. A null column sorts first,
 * which is the same convention `blob_references.column` documents for a null
 * column position.
 *
 * @param part - The key component
 * @returns Its comparable string form
 */
function stringifyPart(part: KeyPart): string {
  return part === null ? '' : String(part);
}
