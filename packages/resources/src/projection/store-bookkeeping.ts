/**
 * The store's own bookkeeping tables, declared as data: what a backend records
 * beside the projection rows to tell a written extent from an unwritten one and
 * to evict either tier.
 *
 * Declared here, in `resources`, and not as DDL in the backend, because their
 * shape is part of what a stored projection IS: a store whose `blob_keys` lacks
 * a column this build writes cannot be read by it. {@link shapeDigestOf} hashes
 * this declaration beside `PROJECTION_TABLES`, so editing a bookkeeping column
 * moves the store to another directory, exactly as editing a row schema does.
 * The SQLite backend builds the `CREATE TABLE` for each from this declaration
 * and from nothing else.
 *
 * Every column is `NOT NULL`; the backend emits that for each.
 */

/** A bookkeeping column's storage type: the two SQLite affinities these tables use. */
export type BookkeepingColumnType = 'TEXT' | 'INTEGER';

/** One bookkeeping column. */
export interface BookkeepingColumn {
  readonly name: string;
  readonly type: BookkeepingColumnType;
}

/** One bookkeeping table: its name, its columns in order, and its primary key. */
export interface BookkeepingTable {
  readonly name: string;
  readonly columns: readonly BookkeepingColumn[];
  readonly primaryKey: readonly string[];
}

/** The two bookkeeping tables, by role. */
export interface StoreBookkeepingTables {
  readonly extents: BookkeepingTable;
  readonly blobKeys: BookkeepingTable;
}

/**
 * The columns naming which tree an extent-scoped row was observed in.
 *
 * Order matters: they lead both the column list and the primary key of every
 * extent-scoped table and of `extents`, so `WHERE storeRootId = ? AND
 * storeTreeHash = ?` is a prefix of the key's own index.
 *
 * 🪤 **Prefixed, and not simply `rootId`, because `resolution_contexts` already
 * declares a `rootId`** — SQLite rejects the `CREATE TABLE` outright, which is
 * how this was found. The two columns are genuinely different facts: a
 * projection may be federated over several roots, so a row's own `rootId` names
 * which of those roots the row belongs to, while this names the whole snapshot
 * the store filed the projection under.
 */
export const EXTENT_KEY_COLUMNS = ['storeRootId', 'storeTreeHash'] as const;

/**
 * One value as a backend binds it to storage, after its encoder: what
 * `node:sqlite` accepts and returns. A boolean is already 0 or 1, an instant
 * an ISO-8601 string, a JSON value its serialized text.
 */
export type EncodedStoreValue = null | number | bigint | string | Uint8Array;

/**
 * The logical bytes of one stored row: a string's UTF-8 length, 8 for a number
 * or bigint, 0 for null, a byte array's length, summed over the row's values.
 *
 * The unit of the blob tier's byte budget (`blob_keys.bytes`). Logical, not file
 * bytes: page and index overhead are out of the count, and a backend's default
 * budget is set from a measured ratio of the two. Measured over ENCODED values,
 * so a row read back from storage measures exactly what the row written did,
 * which is what keeps the ledger equal to the measure of the stored rows.
 *
 * @param values - The row's encoded values, in any order
 * @returns The row's logical bytes
 */
export function blobRowBytes(values: Iterable<EncodedStoreValue>): number {
  let bytes = 0;
  for (const value of values) bytes += valueBytes(value);
  return bytes;
}

/**
 * One encoded value's logical bytes — see {@link blobRowBytes}.
 *
 * @param value - The encoded value
 * @returns Its bytes
 */
function valueBytes(value: EncodedStoreValue): number {
  if (value === null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value === 'number' || typeof value === 'bigint') return NUMBER_BYTES;
  return value.byteLength;
}

/** What a number or bigint counts as: SQLite's widest integer and its real are eight bytes. */
const NUMBER_BYTES = 8;

/** The column both bookkeeping tables order eviction by. */
const WRITTEN_AT: BookkeepingColumn = { name: 'writtenAt', type: 'TEXT' };

/**
 * The bookkeeping tables.
 *
 * - `extents` records that an extent was written at all: without it "this tree
 *   holds no resources" and "this tree was never scanned" are the same empty
 *   result. `writtenAt` (ISO-8601) orders a root's trees for eviction, `rowid`
 *   breaking the tie.
 * - `blob_keys` records, per content key, when a write last held it and the
 *   logical bytes its stored rows measure (`blobRowBytes`, summed over every
 *   blob-scoped row of the key). The blob tier is evicted by those bytes against
 *   a byte budget, newest kept first.
 */
export const STORE_BOOKKEEPING_TABLES: StoreBookkeepingTables = {
  extents: {
    name: 'extents',
    columns: [...EXTENT_KEY_COLUMNS.map((name) => ({ name, type: 'TEXT' as const })), WRITTEN_AT],
    primaryKey: [...EXTENT_KEY_COLUMNS],
  },
  blobKeys: {
    name: 'blob_keys',
    columns: [{ name: 'contentKey', type: 'TEXT' }, WRITTEN_AT, { name: 'bytes', type: 'INTEGER' }],
    primaryKey: ['contentKey'],
  },
};
