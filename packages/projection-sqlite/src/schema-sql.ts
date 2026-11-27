/**
 * The DDL and the statements, built from the projection table registry.
 *
 * Nothing here opens a database. Every statement is a string, so the shape of
 * the schema — which columns exist, what they are declared as, what the key is,
 * and where the extent key is spliced in — is unit-testable without SQLite,
 * and without the `node:sqlite` version floor this package's runtime carries.
 *
 * ## The extent key is two extra leading columns, not a table per tree
 *
 * An extent-scoped table gets `storeRootId` and `storeTreeHash` prepended to
 * its columns *and* to its primary key — see {@link EXTENT_KEY_COLUMNS} for why
 * they are prefixed. That is the whole of SQLite's physical strategy for
 * the `(root, treeHash)` partition: one table holding every tree, with the key
 * prefix doing the pruning a parquet backend would do with a directory per
 * tree. Reading one extent is then a primary-key range scan, which is why no
 * table here needs a secondary index.
 *
 * Blob-scoped tables get neither column, because a blob fact is a pure function
 * of bytes and is shared by every tree that contains those bytes. Giving them a
 * tree key would store the same row once per tree that mentions it — the
 * re-derivation the split exists to avoid.
 *
 * ## 🪤 A nullable primary-key column does NOT make SQLite reject a duplicate
 *
 * Three tables key on a column that is legitimately nullable —
 * `resource_tags.value`, `blob_conditions.line`, and `realization_conditions`,
 * whose key carries four (`resourceId`, `sourcePath`, `sourceLine`, `sourceRef` — a
 * condition no reference provoked states none of them). SQLite permits NULL in
 * a `PRIMARY KEY` column of an ordinary rowid table, and its unique index
 * treats two NULLs as *distinct*, so two rows differing only by a NULL key
 * column both insert and neither conflicts.
 *
 * So this store never relies on a conflict clause to keep a write idempotent.
 * Every write deletes the space it is about to fill and inserts into it (see
 * `store.ts`), which is correct whatever SQLite thinks two NULLs mean — and the
 * per-row variant compares its key columns with `IS` rather than `=` for the
 * same reason, since `= NULL` is never true. The `PRIMARY KEY` is declared for
 * the index it builds and the contract it documents, not for the uniqueness it
 * cannot fully enforce here.
 */

import {
  EXTENT_KEY_COLUMNS,
  isProjectionTable,
  isRowSetTable,
  queryableRelationSpecs,
  STORE_BOOKKEEPING_TABLES,
  storedRelationSpecs,
  type BookkeepingTable,
  type DerivedTableSpec,
  type ProjectionColumnKind,
  type ProjectionColumnTypeSource,
  type ProjectionTableScope,
  type QueryableRelationSpec,
  type RowSetTableEntry,
  projectionColumnTypes,
  quoteIdentifier,
} from '@vibe-agent-toolkit/resources';

/**
 * How each column kind is declared.
 *
 * SQLite's declared types are affinities rather than constraints, so these
 * choose how a value is *stored and compared* rather than what is allowed:
 *
 * - `boolean` → `INTEGER`, SQLite's only spelling for one (0 and 1).
 * - `timestamp` → `TEXT`, holding ISO-8601. Text sorts chronologically in that
 *   format and survives a round trip exactly; a numeric epoch would compare the
 *   same but read back as a number nobody can interpret without knowing the unit.
 * - `json` → `TEXT`, holding the serialized value. Never a decomposed structure:
 *   frontmatter is arbitrarily shaped, and a column per key is not a schema.
 * - `scalar` → no type at all (BLOB affinity), so SQLite keeps the class each
 *   value is bound with: `1` INTEGER, `1.0` REAL, `'1'` TEXT. Any affinity would
 *   convert one of them (`REAL` turns `1` into `1.0`, `TEXT` turns both into text).
 */
const SQLITE_TYPES: Readonly<Record<ProjectionColumnKind, string>> = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  boolean: 'INTEGER',
  timestamp: 'TEXT',
  json: 'TEXT',
  scalar: '',
};

/**
 * A column a bookkeeping table must declare, by name, read from the
 * declaration and checked once at load: a renamed column fails here, naming
 * itself, rather than at the first statement on a user's store.
 *
 * @param table - The declared table
 * @param name - The column the statements here bind
 * @returns `name`
 * @throws TypeError When the declaration has no such column
 */
function declaredColumn(table: BookkeepingTable, name: string): string {
  if (!table.columns.some((column) => column.name === name)) {
    throw new TypeError(`The bookkeeping table "${table.name}" declares no "${name}" column`);
  }
  return name;
}

/**
 * The table recording that an extent was written at all — see
 * `STORE_BOOKKEEPING_TABLES` in `resources`, which declares it.
 *
 * Without it, "this tree holds no resources" and "this tree was never scanned"
 * are the same empty result — and they are different answers, one a hit and one
 * a miss. A projection with zero rows is legal (an empty corpus, a tree whose
 * every file was excluded), so emptiness cannot stand in for absence.
 *
 * Ordering is by `usedAt` (last write or served read) and then by `rowid`, which
 * the table has because it is an ordinary rowid table, and which a use moves too
 * (the stamp is a `REPLACE`). The tie-break is not decoration: an ISO-8601
 * string has millisecond resolution and two uses inside one millisecond are
 * ordinary, so `usedAt` alone leaves the victim unspecified.
 */
export const EXTENTS_TABLE = STORE_BOOKKEEPING_TABLES.extents.name;

/** Column of every bookkeeping table holding when the row was last written. */
export const WRITTEN_AT_COLUMN = declaredColumn(
  STORE_BOOKKEEPING_TABLES.extents,
  declaredColumn(STORE_BOOKKEEPING_TABLES.blobKeys, declaredColumn(STORE_BOOKKEEPING_TABLES.rowSetKeys, 'writtenAt')),
);

/** Column of {@link EXTENTS_TABLE} holding when the extent was last written or served: its eviction order. */
export const USED_AT_COLUMN = declaredColumn(STORE_BOOKKEEPING_TABLES.extents, 'usedAt');

/** Column of both tier ledgers holding a member's stored rows' logical bytes (`storedRowBytes`). */
export const TIER_BYTES_COLUMN = declaredColumn(
  STORE_BOOKKEEPING_TABLES.blobKeys,
  declaredColumn(STORE_BOOKKEEPING_TABLES.rowSetKeys, 'bytes'),
);

/**
 * The table recording, per content key, when a write last held its blob facts
 * and how many logical bytes those facts measure.
 *
 * What {@link EXTENTS_TABLE} is for the extent tier: the record of what may be
 * reclaimed and in what order. Blob rows carry no tree and no root, so an extent
 * eviction has no key to attribute them by; one row per content key gives them
 * one. `store.ts` keeps the newest keys whose bytes fit the blob tier's budget,
 * ordered by `writtenAt` then `rowid`, same tie-break reason as the extent
 * manifest; the keys the writing call holds are excluded by key, never by that
 * order.
 *
 * ⚠️ WRITE recency, not use recency: a write re-stamps every key it holds,
 * covered or not, but a run served whole from the store writes nothing, so its
 * keys age as if idle. The cheap side of the trade — evicting a key still in
 * use costs one re-derivation — against a write on every read path.
 */
export const BLOB_KEYS_TABLE = STORE_BOOKKEEPING_TABLES.blobKeys.name;

/** Column of {@link BLOB_KEYS_TABLE} holding the content key itself. */
export const BLOB_KEY_COLUMN = declaredColumn(STORE_BOOKKEEPING_TABLES.blobKeys, 'contentKey');

/**
 * The row-set tier's ledger: per row set (`contentKey`, `instance`, `variant`, the three fields of
 * a `RowSetId`), when a write last held it and its stored rows' logical bytes. What
 * {@link BLOB_KEYS_TABLE} is for the blob tier, against its own budget; a row set's presence is
 * read from it, in the rows' transaction.
 */
export const ROW_SET_KEYS_TABLE = STORE_BOOKKEEPING_TABLES.rowSetKeys.name;

/** The columns naming one row set in {@link ROW_SET_KEYS_TABLE}: its primary key, in order. */
export const ROW_SET_KEY_COLUMNS = STORE_BOOKKEEPING_TABLES.rowSetKeys.primaryKey
  .map((column) => declaredColumn(STORE_BOOKKEEPING_TABLES.rowSetKeys, column));

/**
 * The `CREATE TABLE` for one bookkeeping table, built from its declaration and
 * from nothing else: the declaration is what the shape digest hashes, so a
 * column edited there moves the store's directory and changes this DDL together.
 * Every column is `NOT NULL`.
 *
 * @param table - A bookkeeping table's declaration
 * @returns A complete `CREATE TABLE IF NOT EXISTS` statement
 */
export function createBookkeepingTableSql(table: BookkeepingTable): string {
  const definitions = table.columns.map((column) => `${quoteIdentifier(column.name)} ${column.type} NOT NULL`);
  const key = table.primaryKey.map((column) => quoteIdentifier(column)).join(', ');
  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.name)} (${definitions.join(', ')}, PRIMARY KEY (${key}))`;
}


/**
 * A projection table, as this module needs to see it.
 *
 * Structural and row-type-free: every entry of `PROJECTION_TABLES` satisfies
 * it, and erasing `Row` is what lets one function serve all thirteen without the
 * caller reconciling thirteen different row types into a union.
 */
export interface StoredTableSpec extends ProjectionColumnTypeSource {
  /**
   * The `Projection` field these rows are carried under.
   *
   * Distinct from {@link StoredTableSpec.name}: a row bundle is keyed by this
   * (`blobReferences`) and SQL is keyed by that (`blob_references`). The
   * registry holds both, so nothing here converts one into the other.
   */
  readonly key: string;
  /** The table's snake_case name. */
  readonly name: string;
  /** Whether the table's rows are keyed by content or by tree. */
  readonly scope: ProjectionTableScope;
  /** The columns that identify a row, in comparison order. */
  readonly primaryKey: readonly string[];
  /**
   * The column naming the resolution context a row belongs to, when it has one.
   *
   * What a write partitions on — see {@link deleteExtentContextSql}. Absent for
   * the three extent-scoped tables that describe the tree or an identity rather
   * than one extent's view of it, which are merged instead.
   */
  readonly contextColumn?: string | undefined;
  /**
   * For a blob-scoped table derived per `(blob, <this column>)`, the column a
   * write is scoped by with the blob — see {@link deleteBlobPartitionSql}.
   * Absent for every table one derivation produces in full.
   */
  readonly partitionColumn?: string | undefined;
}

/**
 * Every column of a stored table, in order — the extent key first when the
 * table has one.
 *
 * @param spec - A projection table's registry entry
 * @returns The stored column names, in declaration order
 */
export function storedColumns(spec: StoredTableSpec): readonly string[] {
  const declared = spec.columns;
  return spec.scope === 'extent' ? [...EXTENT_KEY_COLUMNS, ...declared] : declared;
}

/**
 * The primary key of a stored table — the extent key first when it has one.
 *
 * @param spec - A projection table's registry entry
 * @returns The key column names, in comparison order
 */
export function storedPrimaryKey(spec: StoredTableSpec): readonly string[] {
  const declared = spec.primaryKey;
  return spec.scope === 'extent' ? [...EXTENT_KEY_COLUMNS, ...declared] : declared;
}

/**
 * The `CREATE TABLE` for one projection table.
 *
 * `NOT NULL` is emitted for every column the row schema does not make nullable,
 * which turns an encoding bug into an immediate constraint failure rather than
 * a row that reads back with a null where the type promises a value.
 *
 * @param spec - A projection table's registry entry
 * @returns A complete `CREATE TABLE IF NOT EXISTS` statement
 * @throws TypeError When a column's Zod type has no storage representation
 *
 * @example
 * createTableSql(PROJECTION_TABLES.blobs);
 * // CREATE TABLE IF NOT EXISTS "blobs" ("contentKey" TEXT NOT NULL, … PRIMARY KEY ("contentKey"))
 */
export function createTableSql(spec: StoredTableSpec): string {
  const leading: string[] = [];
  if (spec.scope === 'extent') {
    assertNoKeyColumnClash(spec);
    for (const column of EXTENT_KEY_COLUMNS) {
      leading.push(`${quoteIdentifier(column)} TEXT NOT NULL`);
    }
  }
  return createTable(spec.name, leading, spec, storedPrimaryKey(spec));
}

/**
 * One column's declaration, and the `CREATE TABLE` they compose into.
 *
 * Shared with {@link createDerivedTableSql} rather than copied, so a derived
 * relation's DDL cannot drift from a stored table's — the two differ only in
 * whether an extent key is prepended, and that difference is the caller's.
 *
 * @param name - The table's SQL name
 * @param leading - Column declarations to emit first, already rendered
 * @param source - Where the declared columns and their types come from
 * @param primaryKey - The key columns, in comparison order
 * @returns A complete `CREATE TABLE IF NOT EXISTS` statement
 * @throws TypeError When a column's Zod type has no storage representation
 */
function createTable(
  name: string,
  leading: readonly string[],
  source: ProjectionColumnTypeSource,
  primaryKey: readonly string[],
): string {
  const definitions = [...leading];
  for (const [column, { kind, nullable }] of projectionColumnTypes(source)) {
    const type = SQLITE_TYPES[kind];
    // A scalar column declares no type (its values keep the class they were bound in): no word at all.
    definitions.push([quoteIdentifier(column), type, nullable ? '' : 'NOT NULL'].filter((part) => part !== '').join(' '));
  }
  const key = primaryKey.map((column) => quoteIdentifier(column)).join(', ');
  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(name)} (${definitions.join(', ')}, PRIMARY KEY (${key}))`;
}

/**
 * The `CREATE TABLE` for one relation a LENS produces.
 *
 * ## Why this is a second function and not a widened first one
 *
 * A derived relation carries **no extent key**, and that is the whole
 * difference. It could have been expressed by giving `ProjectionTableScope` a
 * third member, or by passing a stored spec with `scope: 'blob'` — and both are
 * wrong for the same reason: they would emit correct DDL while making a false
 * claim about what the rows ARE. `'blob'` says "a pure function of bytes", and
 * a lens's output is a function of bytes *and of the lens*; a third scope member
 * ripples into the store's scope-partitioned row bundles, which are what a
 * shared on-disk store persists and which derived rows must never enter.
 *
 * Taking a {@link DerivedTableSpec} — a type with no `scope` field at all —
 * makes that distinction unstatable rather than merely unstated, and the shared
 * {@link createTable} keeps the column emission single-sourced.
 *
 * @param spec - A derived relation's registry entry
 * @returns A complete `CREATE TABLE IF NOT EXISTS` statement
 * @throws TypeError When a column's Zod type has no storage representation
 *
 * @example
 * createDerivedTableSql(DERIVED_TABLES.edges);
 * // CREATE TABLE IF NOT EXISTS "edges" ("src" TEXT NOT NULL, … PRIMARY KEY ("src", "refOrdinal", "contextId"))
 */
export function createDerivedTableSql(spec: DerivedTableSpec): string {
  return createTable(spec.name, [], spec, spec.primaryKey);
}

/**
 * The `CREATE TABLE` for one row-set table: its declared columns and primary key, no extent key.
 * A row set is a pure function of its bytes and variant, shared by every tree holding the bytes,
 * as a blob fact is; its identity is its own leading key columns (`blob, variant`).
 *
 * @param spec - A row-set table's registry entry
 * @returns A complete `CREATE TABLE IF NOT EXISTS` statement
 */
export function createRowSetTableSql(spec: RowSetTableEntry): string {
  return createTable(spec.name, [], spec, spec.primaryKey);
}

/**
 * The `INSERT` for one row-set table, one placeholder per declared column.
 *
 * @param spec - A row-set table's registry entry
 * @returns An `INSERT INTO … VALUES (?, …)` statement
 */
export function insertRowSetSql(spec: RowSetTableEntry): string {
  return insertInto(spec.name, spec.columns);
}

/**
 * The `SELECT` of one row set's rows of one table, every declared column, in primary-key order.
 *
 * @param spec - A row-set table's registry entry
 * @returns A `SELECT … WHERE blob = ? AND variant = ? ORDER BY <key>` statement, bound as `(blob, variant)`
 */
export function selectRowSetSql(spec: RowSetTableEntry): string {
  const names = spec.columns.map((column) => quoteIdentifier(column)).join(', ');
  const order = spec.primaryKey.map((column) => quoteIdentifier(column)).join(', ');
  return `SELECT ${names} FROM ${quoteIdentifier(spec.name)} WHERE ${rowSetPredicate(spec)} ORDER BY ${order}`;
}

/**
 * The `DELETE` of one row set's rows of one table: what a replace clears and an eviction reclaims.
 *
 * @param spec - A row-set table's registry entry
 * @returns A `DELETE … WHERE blob = ? AND variant = ?` statement, bound as `(blob, variant)`
 */
export function deleteRowSetSql(spec: RowSetTableEntry): string {
  return `DELETE FROM ${quoteIdentifier(spec.name)} WHERE ${rowSetPredicate(spec)}`;
}

/**
 * The columns naming one row set in a row-set table: its first two key columns, `blob` and
 * `variant` (the registry declares every row-set key to start with them; the instance is the
 * table's own). A prefix of the primary key, so each statement over it is a key-range read.
 *
 * @param spec - A row-set table's registry entry
 * @returns The content-key column and the variant column
 * @throws TypeError When the table's key does not start with two columns
 */
function rowSetIdColumns(spec: RowSetTableEntry): readonly [blob: string, variant: string] {
  const [blob, variant] = spec.primaryKey;
  if (blob === undefined || variant === undefined) {
    throw new TypeError(`Row-set table "${spec.name}" declares no (blob, variant) key prefix`);
  }
  return [blob, variant];
}

/**
 * `blob = ? AND variant = ?` for one row-set table.
 *
 * @param spec - A row-set table's registry entry
 * @returns The predicate, bound as `(blob, variant)`
 */
function rowSetPredicate(spec: RowSetTableEntry): string {
  return rowSetIdColumns(spec).map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');
}

/**
 * The `INSERT` for one relation a lens produces.
 *
 * @param spec - A derived relation's registry entry
 * @returns An `INSERT INTO … VALUES (?, …)` statement
 */
export function insertDerivedSql(spec: DerivedTableSpec): string {
  return insertInto(spec.name, spec.columns);
}

/**
 * The `INSERT` for one projection table, with one placeholder per stored column.
 *
 * Positional placeholders rather than named ones: the column order is the
 * registry's, and binding an array in that same order means the two orders
 * cannot drift the way a name-to-value map lets them.
 *
 * @param spec - A projection table's registry entry
 * @returns An `INSERT INTO … VALUES (?, …)` statement
 *
 * @example
 * insertSql(PROJECTION_TABLES.roots);
 * // INSERT INTO "roots" ("rootId", "treeHash", "id", "path") VALUES (?, ?, ?, ?)
 */
export function insertSql(spec: StoredTableSpec): string {
  return insertInto(spec.name, storedColumns(spec));
}

/**
 * The `INSERT` for a named table over a named column list.
 *
 * @param name - The table's SQL name
 * @param columns - Its columns, in binding order
 * @returns An `INSERT INTO … VALUES (?, …)` statement
 */
function insertInto(name: string, columns: readonly string[]): string {
  const placeholders = columns.map(() => '?').join(', ');
  const names = columns.map((column) => quoteIdentifier(column)).join(', ');
  return `INSERT INTO ${quoteIdentifier(name)} (${names}) VALUES (${placeholders})`;
}

/**
 * The `SELECT` that reads one extent-scoped table back.
 *
 * The column list is the registry's declared columns only — the extent key is
 * in the `WHERE`, so re-selecting it would hand every row two columns the row
 * schema does not declare.
 *
 * @param spec - An extent-scoped table's registry entry
 * @returns A `SELECT … WHERE rootId = ? AND treeHash = ?` statement
 */
export function selectExtentSql(spec: StoredTableSpec): string {
  const names = spec.columns.map((column) => quoteIdentifier(column)).join(', ');
  return `SELECT ${names} FROM ${quoteIdentifier(spec.name)} WHERE ${extentKeyPredicate()}`;
}

/**
 * The `DELETE` that empties one extent-scoped table's rows for **one context**
 * of one tree.
 *
 * This is the physical half of `writeExtent` being additive: the tree key alone
 * would take out every context under it, so a `vat resources scan` writing the
 * filesystem extent would delete the skill extents `vat inventory` wrote against
 * the same tree. Bound as `(rootId, treeHash, contextId)`.
 *
 * @param spec - An extent-scoped table's registry entry, with a context column
 * @returns A `DELETE … WHERE rootId = ? AND treeHash = ? AND <context> = ?` statement
 * @throws TypeError When the table has no context column to partition on
 */
export function deleteExtentContextSql(spec: StoredTableSpec): string {
  const column = spec.contextColumn;
  if (column === undefined) {
    throw new TypeError(
      `Table "${spec.name}" declares no context column, so its rows cannot be replaced one context`
      + ' at a time. Tables without one are merged by primary key — see deleteRowByKeySql.',
    );
  }
  return `DELETE FROM ${quoteIdentifier(spec.name)}`
    + ` WHERE ${extentKeyPredicate()} AND ${quoteIdentifier(column)} = ?`;
}

/**
 * The `DELETE` that removes one extent-scoped table's rows for a **whole tree**.
 *
 * The only statement here that takes out every context under a key at once, and
 * the only one eviction uses. `writeExtent` must never reach for it — a write is
 * additive at context granularity, and the reason
 * {@link deleteExtentContextSql} exists is that clearing the whole key would let
 * one command delete another command's contexts. Eviction is the opposite
 * situation: the tree is being reclaimed entire, so every context under it goes.
 *
 * Bound as `(rootId, treeHash)`, which is a prefix of the table's own primary
 * key, so this is a key range rather than a scan — the same index
 * {@link selectExtentSql} reads through.
 *
 * @param spec - An extent-scoped table's registry entry
 * @returns A `DELETE … WHERE rootId = ? AND treeHash = ?` statement
 */
export function deleteExtentSql(spec: StoredTableSpec): string {
  return `DELETE FROM ${quoteIdentifier(spec.name)} WHERE ${extentKeyPredicate()}`;
}

/**
 * The `DELETE` that removes the single row a primary key names, so an insert can
 * take its place.
 *
 * The three extent-scoped tables with no context column (`roots`, `resources`,
 * `resource_tags`) describe the tree or an identity rather than one extent's
 * view of it, so they are merged rather than partitioned: two commands that both
 * realize a file contribute the same identity row, and whichever writes last
 * writes the same bytes.
 *
 * 🪤 Every key column is compared with `IS`, not `=`. `resource_tags.value` is
 * nullable and `= NULL` is never true, so an `=` predicate would delete nothing
 * for exactly the rows a conflict clause also cannot dedup (see this module's
 * header) — and the row would insert a second time, silently, on every write.
 * `IS` is SQLite's null-safe comparison and behaves as `=` elsewhere.
 *
 * @param spec - An extent-scoped table's registry entry
 * @returns A `DELETE … WHERE rootId IS ? AND treeHash IS ? AND <key…> IS ?` statement
 */
export function deleteRowByKeySql(spec: StoredTableSpec): string {
  const predicate = storedPrimaryKey(spec)
    .map((column) => `${quoteIdentifier(column)} IS ?`)
    .join(' AND ');
  return `DELETE FROM ${quoteIdentifier(spec.name)} WHERE ${predicate}`;
}

/**
 * The `SELECT` that reads one blob-scoped table back for a set of content keys.
 *
 * @param spec - A blob-scoped table's registry entry
 * @param keyCount - How many content keys the statement should accept
 * @returns A `SELECT … WHERE <key column> IN (?, …)` statement
 * @throws RangeError When `keyCount` is not a positive integer — an `IN ()` with
 *   no members is a SQLite syntax error, so an empty batch must be skipped by
 *   the caller rather than compiled into a statement that cannot parse
 */
export function selectBlobFactsSql(spec: StoredTableSpec, keyCount: number): string {
  const names = spec.columns.map((column) => quoteIdentifier(column)).join(', ');
  return `SELECT ${names} FROM ${quoteIdentifier(spec.name)} WHERE ${blobKeyPredicate(spec, keyCount)}`;
}

/**
 * The `SELECT` that reads one blob-scoped table back for a set of content keys,
 * keeping only the rows whose `column` holds one of `valueCount` bound values
 * (bound after the keys).
 *
 * @param spec - A blob-scoped table's registry entry
 * @param keyCount - How many content keys the statement should accept
 * @param column - The column the values filter on
 * @param valueCount - How many values the statement should accept
 * @returns A `SELECT … WHERE <key column> IN (?, …) AND <column> IN (?, …)` statement
 * @throws RangeError When `keyCount` or `valueCount` is not a positive integer
 */
export function selectBlobFactsWhereSql(spec: StoredTableSpec, keyCount: number, column: string, valueCount: number): string {
  if (!Number.isInteger(valueCount) || valueCount < 1) {
    throw new RangeError(`A filtered blob-fact statement needs at least one value, got ${valueCount}`);
  }
  const placeholders = Array.from({ length: valueCount }, () => '?').join(', ');
  return `${selectBlobFactsSql(spec, keyCount)} AND ${quoteIdentifier(column)} IN (${placeholders})`;
}

/**
 * The `DELETE` that removes one blob-scoped table's rows for a set of content keys.
 *
 * @param spec - A blob-scoped table's registry entry
 * @param keyCount - How many content keys the statement should accept
 * @returns A `DELETE … WHERE <key column> IN (?, …)` statement
 * @throws RangeError When `keyCount` is not a positive integer
 */
export function deleteBlobFactsSql(spec: StoredTableSpec, keyCount: number): string {
  return `DELETE FROM ${quoteIdentifier(spec.name)} WHERE ${blobKeyPredicate(spec, keyCount)}`;
}

/**
 * The `DELETE` that removes one partitioned blob-scoped table's rows for ONE
 * `(blob, partition)` pair — what a write clears in a table whose rows are
 * derived per pair, so a run that did not derive a pair leaves it alone.
 *
 * @param spec - A blob-scoped table's registry entry, declaring `partitionColumn`
 * @returns A `DELETE … WHERE <key column> = ? AND <partition column> = ?` statement
 * @throws TypeError When the table declares no partition column
 */
export function deleteBlobPartitionSql(spec: StoredTableSpec): string {
  return `DELETE FROM ${quoteIdentifier(spec.name)} WHERE ${blobPartitionPredicate(spec)}`;
}

/**
 * The `SELECT` of one partitioned blob-scoped table's stored rows for ONE
 * `(blob, partition)` pair, every declared column: what a write measures
 * before {@link deleteBlobPartitionSql} clears the pair, so the key's recorded
 * bytes lose exactly what the delete takes. A prefix of the table's primary key.
 *
 * @param spec - A blob-scoped table's registry entry, declaring `partitionColumn`
 * @returns A `SELECT … WHERE <key column> = ? AND <partition column> = ?` statement
 * @throws TypeError When the table declares no partition column
 */
export function selectBlobPartitionSql(spec: StoredTableSpec): string {
  const names = spec.columns.map((column) => quoteIdentifier(column)).join(', ');
  return `SELECT ${names} FROM ${quoteIdentifier(spec.name)} WHERE ${blobPartitionPredicate(spec)}`;
}

/**
 * `<key column> = ? AND <partition column> = ?` for a partitioned blob table.
 *
 * @param spec - A blob-scoped table's registry entry
 * @returns The predicate, bound as `(blob, partition)`
 * @throws TypeError When the table declares no partition column
 */
function blobPartitionPredicate(spec: StoredTableSpec): string {
  if (spec.partitionColumn === undefined) {
    throw new TypeError(`Table "${spec.name}" declares no partition column to scope a statement by`);
  }
  return `${quoteIdentifier(blobKeyColumn(spec))} = ? AND ${quoteIdentifier(spec.partitionColumn)} = ?`;
}

/**
 * The column a blob-scoped table joins to `blobs.contentKey` through.
 *
 * It is the table's *first* key column in every case — `contentKey` on `blobs`
 * itself and `blob` on the three that hang off it — so it is read from the
 * registry rather than named here, and a renamed column moves this with it.
 *
 * @param spec - A blob-scoped table's registry entry
 * @returns The content-key column's name
 * @throws TypeError When the table declares no primary key at all
 */
export function blobKeyColumn(spec: StoredTableSpec): string {
  const [first] = spec.primaryKey;
  if (first === undefined) {
    throw new TypeError(`Table "${spec.name}" declares no primary key to join blob facts through`);
  }
  return first;
}

/**
 * Refuse a table that declares a column of its own by one of the extent key's
 * names.
 *
 * SQLite would reject the `CREATE TABLE` with `duplicate column name`, which
 * names the column but not the reason — and the reason matters, because the
 * repair is never "drop one of them": the two are different facts (see
 * {@link EXTENT_KEY_COLUMNS}). A new table taking one of these names
 * should fail here, saying so.
 *
 * @param spec - An extent-scoped table's registry entry
 * @throws TypeError When a declared column collides with an extent key column
 */
function assertNoKeyColumnClash(spec: StoredTableSpec): void {
  const clash = spec.columns.find((column) => (EXTENT_KEY_COLUMNS as readonly string[]).includes(column));
  if (clash !== undefined) {
    throw new TypeError(
      `Table "${spec.name}" declares a column named "${clash}", which the extent key already uses`,
    );
  }
}

/** `storeRootId = ? AND storeTreeHash = ?`, in the order {@link EXTENT_KEY_COLUMNS} declares. */
function extentKeyPredicate(): string {
  return EXTENT_KEY_COLUMNS.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');
}

/**
 * `<key column> IN (?, …)` for a blob-scoped table.
 *
 * @param spec - A blob-scoped table's registry entry
 * @param keyCount - How many placeholders to emit
 * @returns The predicate
 * @throws RangeError When `keyCount` is not a positive integer
 */
function blobKeyPredicate(spec: StoredTableSpec, keyCount: number): string {
  return contentKeyInPredicate(blobKeyColumn(spec), keyCount);
}

/**
 * `<column> IN (?, …)` over content keys.
 *
 * @param column - The column holding a content key
 * @param keyCount - How many placeholders to emit
 * @returns The predicate
 * @throws RangeError When `keyCount` is not a positive integer
 */
function contentKeyInPredicate(column: string, keyCount: number): string {
  if (!Number.isInteger(keyCount) || keyCount < 1) {
    throw new RangeError(`A blob-fact statement needs at least one content key, got ${keyCount}`);
  }
  const placeholders = Array.from({ length: keyCount }, () => '?').join(', ');
  return `${quoteIdentifier(column)} IN (${placeholders})`;
}

/**
 * The `SELECT` of which of a set of content keys the blob ledger
 * ({@link BLOB_KEYS_TABLE}) tracks: a read's presence, never a decoded row.
 *
 * @param keyCount - How many content keys the statement should accept
 * @returns A `SELECT <key> FROM blob_keys WHERE <key> IN (?, …)` statement
 * @throws RangeError When `keyCount` is not a positive integer
 */
export function selectBlobKeysPresentSql(keyCount: number): string {
  const column = quoteIdentifier(BLOB_KEY_COLUMN);
  return `SELECT ${column} FROM ${quoteIdentifier(BLOB_KEYS_TABLE)} WHERE ${contentKeyInPredicate(BLOB_KEY_COLUMN, keyCount)}`;
}

/**
 * The members of one stored tier past its byte budget: the one eviction statement, for the blob
 * tier and the row-set tier alike.
 *
 * The members the calling write holds are named BY IDENTITY, a tuple of the ledger's identity
 * columns bound as one JSON array of arrays (`[["k","data","json"], …]`) and read through
 * `json_each`, and are never selected; their bytes count first. The rest follow newest first
 * (`writtenAt`, then `rowid`), and one goes once the running sum of recorded bytes up to and
 * including it passes the budget. Bound as `(heldJson, budget)`.
 *
 * By identity and not by place in the order: a store restored from a runner whose clock ran ahead
 * holds `writtenAt` values later than this write's stamp, so the newest rows are not always the
 * write's own. The running sum only grows, so the kept members are exactly a newest prefix: one
 * cut, never a knapsack. One pass over the ledger, never over the stored rows.
 *
 * @param ledger - The tier's ledger declaration
 * @param identity - The ledger columns naming one member, in the order each held tuple lists them
 * @returns The statement; each result row carries the identity columns
 * @throws TypeError When the ledger declares no such identity column
 */
export function tierPastBudgetSql(ledger: BookkeepingTable, identity: readonly string[]): string {
  const ids = identity.map((column) => quoteIdentifier(declaredColumn(ledger, column))).join(', ');
  const tuple = identity.map((_, index) => `json_extract("value", '$[${index}]')`).join(', ');
  const bytes = quoteIdentifier(TIER_BYTES_COLUMN);
  const writtenAt = quoteIdentifier(WRITTEN_AT_COLUMN);
  return `SELECT ${ids} FROM (`
    + `SELECT ${ids}, "held",`
    + ` SUM(${bytes}) OVER (ORDER BY "held" DESC, ${writtenAt} DESC, "position" DESC`
    + ' ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "running"'
    + ` FROM (SELECT ${ids}, ${bytes}, ${writtenAt}, "rowid" AS "position",`
    + ` (${ids}) IN (SELECT ${tuple} FROM json_each(?)) AS "held"`
    + ` FROM ${quoteIdentifier(ledger.name)})`
    + ') WHERE NOT "held" AND "running" > ?';
}

/** Every projection table, in registry order, as this module sees them. */
export function allSpecs(): readonly StoredTableSpec[] {
  return storedRelationSpecs().filter((spec) => isProjectionTable(spec));
}

/** Every row-set table, in registry order. */
export function rowSetSpecs(): readonly RowSetTableEntry[] {
  return storedRelationSpecs().filter((spec) => isRowSetTable(spec));
}

/**
 * One relation a statement can name, as the run database and the compile probe create it: its
 * spec, its DDL, its `INSERT`, and whether its rows lead with the extent key.
 */
export interface QueryableRelation {
  /** The projection table's, row-set table's or derived relation's registry entry. */
  readonly spec: QueryableRelationSpec;
  /** `CREATE TABLE IF NOT EXISTS`, in today's shape. */
  readonly createSql: string;
  /** One placeholder per stored column, the extent key first when {@link extentKeyed}. */
  readonly insertSql: string;
  /** Whether each row binds `storeRootId` and `storeTreeHash` ahead of its own columns. */
  readonly extentKeyed: boolean;
}

/**
 * Every relation a statement can name — every projection table, then every row-set table, then
 * every derived relation — and nothing else: no `extents`, `blob_keys` or `row_set_keys`, which
 * are the fact store's bookkeeping.
 *
 * 🔑 Read off `queryableRelationSpecs()` — the one list the planner and the SQL gate read too —
 * and the ONE source the compile probe and hydration create tables from, so the probe holds exactly
 * what hydration can create, and a statement naming anything else (`SELECT * FROM extents`)
 * refuses at preflight rather than after a population. Each spec's `kind` decides its DDL, as the
 * planner reads it too.
 *
 * @returns The relations, stored tables first, each registry in declaration order
 */
export function queryableSpecs(): readonly QueryableRelation[] {
  return queryableRelationSpecs().map((spec): QueryableRelation => {
    switch (spec.kind) {
      case 'projection': {
        return { spec, createSql: createTableSql(spec), insertSql: insertSql(spec), extentKeyed: spec.scope === 'extent' };
      }
      case 'rowSet': {
        return { spec, createSql: createRowSetTableSql(spec), insertSql: insertRowSetSql(spec), extentKeyed: false };
      }
      case 'derived': {
        return { spec, createSql: createDerivedTableSql(spec), insertSql: insertDerivedSql(spec), extentKeyed: false };
      }
    }
  });
}
