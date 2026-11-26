/**
 * The store's own bookkeeping tables, declared as data: what a backend records
 * beside the projection rows to tell a written extent from an unwritten one and
 * to evict each tier.
 *
 * Declared here, in `resources`, and not as DDL in the backend, because their
 * shape is part of what a stored projection IS: a store whose `blob_keys` lacks
 * a column this build writes cannot be read by it. {@link shapeDigestOf} hashes
 * this declaration and the byte measure ({@link BLOB_BYTE_MEASURE}) beside
 * every stored relation (`storedRelationSpecs()`), so editing a bookkeeping column or a measure constant
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

/**
 * The three bookkeeping tables, by role: the extent ledger and one ledger per
 * stored tier. A record type rather than an interface so `Object.values` of it
 * is typed: every consumer that walks the tables walks this one list.
 */
export type StoreBookkeepingTables = Readonly<Record<'extents' | 'blobKeys' | 'rowSetKeys', BookkeepingTable>>;

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
 * The byte measure's constants, as data: what each kind of encoded value counts
 * as. A byte array counts its length, which has no constant.
 *
 * {@link shapeDigestOf} hashes this beside the bookkeeping tables, because
 * `blob_keys.bytes` is recorded in this unit: a store written under one measure
 * and budgeted under another would sum two units, so changing a constant moves
 * the store to another directory.
 */
export interface BlobByteMeasure {
  /** What a null counts as. */
  readonly nullBytes: number;
  /** What a number or bigint counts as. */
  readonly numberBytes: number;
  /** The encoding a string's length is counted in. */
  readonly stringEncoding: 'utf8' | 'utf16le';
}

/**
 * The byte measure {@link storedRowBytes} applies: a null is 0, a number or bigint
 * 8 (SQLite's widest integer and its real are eight bytes), a string its UTF-8
 * length. Shared by both stored tiers; the name is the blob tier's, where it
 * began.
 */
export const BLOB_BYTE_MEASURE: BlobByteMeasure = { nullBytes: 0, numberBytes: 8, stringEncoding: 'utf8' };

/**
 * The logical bytes of one stored row: each value measured by
 * {@link BLOB_BYTE_MEASURE} (a string's UTF-8 length, 8 for a number or bigint,
 * 0 for null) or, for a byte array, its length, summed over the row's values.
 *
 * The unit of both stored tiers' byte budgets (`blob_keys.bytes`,
 * `row_set_keys.bytes`). Logical, not file bytes: page and index overhead are
 * out of the count, and a backend's default budget is set from a measured ratio
 * of the two. Measured over ENCODED values, so a row read back from storage
 * measures exactly what the row written did, which is what keeps each ledger
 * equal to the measure of its stored rows.
 *
 * @param values - The row's encoded values, in any order
 * @returns The row's logical bytes
 */
export function storedRowBytes(values: Iterable<EncodedStoreValue>): number {
  let bytes = 0;
  for (const value of values) bytes += valueBytes(value);
  return bytes;
}

/**
 * One encoded value's logical bytes — see {@link storedRowBytes}.
 *
 * @param value - The encoded value
 * @returns Its bytes
 */
function valueBytes(value: EncodedStoreValue): number {
  if (value === null) return BLOB_BYTE_MEASURE.nullBytes;
  if (typeof value === 'string') return Buffer.byteLength(value, BLOB_BYTE_MEASURE.stringEncoding);
  if (typeof value === 'number' || typeof value === 'bigint') return BLOB_BYTE_MEASURE.numberBytes;
  return value.byteLength;
}

/** The column every bookkeeping table orders eviction by. */
const WRITTEN_AT: BookkeepingColumn = { name: 'writtenAt', type: 'TEXT' };

/** The column a tier's ledger records its stored rows' logical bytes in ({@link storedRowBytes}). */
const BYTES: BookkeepingColumn = { name: 'bytes', type: 'INTEGER' };

/** The column naming a content key, in both tier ledgers. */
const CONTENT_KEY: BookkeepingColumn = { name: 'contentKey', type: 'TEXT' };

/**
 * The bookkeeping tables.
 *
 * - `extents` records that an extent was written at all: without it "this tree
 *   holds no resources" and "this tree was never scanned" are the same empty
 *   result. `writtenAt` (ISO-8601) orders a root's trees for eviction, `rowid`
 *   breaking the tie.
 * - `blob_keys` records, per content key, when a write last held it and the
 *   logical bytes its stored rows measure (`storedRowBytes`, summed over every
 *   blob-scoped row of the key). The blob tier is evicted by those bytes against
 *   a byte budget, newest kept first.
 * - `row_set_keys` is the row-set tier's own ledger, the same record per row set
 *   (`contentKey`, `instance`, `variant`: the three fields of a `RowSetId`,
 *   never a hash of them), against its own budget. Presence is read from it;
 *   one ledger per tier, so a large data corpus never evicts blob facts.
 */
export const STORE_BOOKKEEPING_TABLES: StoreBookkeepingTables = {
  extents: {
    name: 'extents',
    columns: [...EXTENT_KEY_COLUMNS.map((name) => ({ name, type: 'TEXT' as const })), WRITTEN_AT],
    primaryKey: [...EXTENT_KEY_COLUMNS],
  },
  blobKeys: {
    name: 'blob_keys',
    columns: [CONTENT_KEY, WRITTEN_AT, BYTES],
    primaryKey: [CONTENT_KEY.name],
  },
  rowSetKeys: {
    name: 'row_set_keys',
    columns: [CONTENT_KEY, { name: 'instance', type: 'TEXT' }, { name: 'variant', type: 'TEXT' }, WRITTEN_AT, BYTES],
    primaryKey: [CONTENT_KEY.name, 'instance', 'variant'],
  },
};
