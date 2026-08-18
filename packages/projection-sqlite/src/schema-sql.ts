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
 * `resource_tags.value`, `realization_conditions.resourceId` and
 * `blob_conditions.line`. SQLite permits NULL in a `PRIMARY KEY` column of an
 * ordinary rowid table, and its unique index treats two NULLs as *distinct*, so
 * two rows differing only by a NULL key column both insert and neither
 * conflicts.
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
  PROJECTION_TABLES,
  type ProjectionColumnKind,
  type ProjectionColumnTypeSource,
  type ProjectionTableScope,
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
 */
const SQLITE_TYPES: Readonly<Record<ProjectionColumnKind, string>> = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  boolean: 'INTEGER',
  timestamp: 'TEXT',
  json: 'TEXT',
};

/**
 * The columns naming which tree an extent-scoped row was observed in.
 *
 * Order matters: they lead both the column list and the primary key, so
 * `WHERE storeRootId = ? AND storeTreeHash = ?` is a prefix of the key's own
 * index.
 *
 * 🪤 **Prefixed, and not simply `rootId`, because `resolution_contexts` already
 * declares a `rootId`** — SQLite rejects the `CREATE TABLE` outright, which is
 * how this was found. Renaming is not merely a way around the clash: the two
 * columns are genuinely different facts. A projection may be **federated over
 * several roots** (`roots` is a table precisely so that it can be), so a row's
 * own `rootId` names which of those roots the row belongs to, while this names
 * the whole snapshot the store filed the projection under. Collapsing them
 * would make a federated projection unreadable.
 */
export const EXTENT_KEY_COLUMNS = ['storeRootId', 'storeTreeHash'] as const;

/**
 * The table recording that an extent was written at all.
 *
 * Without it, "this tree holds no resources" and "this tree was never scanned"
 * are the same empty result — and they are different answers, one a hit and one
 * a miss. A projection with zero rows is legal (an empty corpus, a tree whose
 * every file was excluded), so emptiness cannot stand in for absence.
 */
export const EXTENTS_TABLE = 'extents';

/** Column of {@link EXTENTS_TABLE} holding when the extent was last written. */
export const WRITTEN_AT_COLUMN = 'writtenAt';

/**
 * DDL for the extent manifest.
 *
 * `writtenAt` is the only handle any future eviction has. Nothing reads it
 * today, and it is here rather than added later because a cache whose rows
 * carry no age has no prune to design — the alternative when the directory
 * grows is deleting all of it.
 */
export const CREATE_EXTENTS_TABLE_SQL
  = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(EXTENTS_TABLE)} (`
    + `${quoteIdentifier('storeRootId')} TEXT NOT NULL, `
    + `${quoteIdentifier('storeTreeHash')} TEXT NOT NULL, `
    + `${quoteIdentifier(WRITTEN_AT_COLUMN)} TEXT NOT NULL, `
    + `PRIMARY KEY (${quoteIdentifier('storeRootId')}, ${quoteIdentifier('storeTreeHash')}))`;

/**
 * A projection table, as this module needs to see it.
 *
 * Structural and row-type-free: every entry of `PROJECTION_TABLES` satisfies
 * it, and erasing `Row` is what lets one function serve all twelve without the
 * caller reconciling twelve different row types into a union.
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
  const definitions: string[] = [];
  if (spec.scope === 'extent') {
    assertNoKeyColumnClash(spec);
    for (const column of EXTENT_KEY_COLUMNS) {
      definitions.push(`${quoteIdentifier(column)} TEXT NOT NULL`);
    }
  }
  for (const [column, { kind, nullable }] of projectionColumnTypes(spec)) {
    definitions.push(`${quoteIdentifier(column)} ${SQLITE_TYPES[kind]}${nullable ? '' : ' NOT NULL'}`);
  }
  const key = storedPrimaryKey(spec).map((column) => quoteIdentifier(column)).join(', ');
  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(spec.name)} (${definitions.join(', ')}, PRIMARY KEY (${key}))`;
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
  const columns = storedColumns(spec);
  const placeholders = columns.map(() => '?').join(', ');
  const names = columns.map((column) => quoteIdentifier(column)).join(', ');
  return `INSERT INTO ${quoteIdentifier(spec.name)} (${names}) VALUES (${placeholders})`;
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
 * {@link EXTENT_KEY_COLUMNS}). A thirteenth table taking one of these names
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
 * `<key column> IN (?, …)`.
 *
 * @param spec - A blob-scoped table's registry entry
 * @param keyCount - How many placeholders to emit
 * @returns The predicate
 * @throws RangeError When `keyCount` is not a positive integer
 */
function blobKeyPredicate(spec: StoredTableSpec, keyCount: number): string {
  if (!Number.isInteger(keyCount) || keyCount < 1) {
    throw new RangeError(`A blob-fact statement needs at least one content key, got ${keyCount}`);
  }
  const placeholders = Array.from({ length: keyCount }, () => '?').join(', ');
  return `${quoteIdentifier(blobKeyColumn(spec))} IN (${placeholders})`;
}

/** Every projection table, in registry order, as this module sees them. */
export function allSpecs(): readonly StoredTableSpec[] {
  return Object.values(PROJECTION_TABLES);
}
