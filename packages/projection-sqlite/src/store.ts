/**
 * The `FactStore` port implemented on Node's built-in `node:sqlite`, in WAL
 * mode, and the shared row writers the run database's load uses too.
 *
 * ## Why SQLite, in one paragraph
 *
 * The projection cache's real workload is not a cold build — it is a warm one:
 * a couple of changed files re-parsed, over and over, hundreds of times. An
 * immutable-file store cannot update in place, so every one of those deltas is
 * another file, and a measured comparison put a parquet reader at 841 ms with
 * one delta file and 2,646 ms at 2,001, against **0 ms flat** for SQLite. The
 * ~840 ms floor was engine boot, paid per `vat` invocation before any
 * fragmentation was counted. SQLite also supplies natively the one thing a
 * content-addressed manifest was invented to provide — a cross-table snapshot —
 * and it ships with Node, so it costs no install footprint at all.
 *
 * ## 🪤 `busy_timeout` is set BEFORE `journal_mode = WAL`, and the order matters
 *
 * Switching a database into WAL takes a brief exclusive lock. With no busy
 * handler installed yet, that switch *fails under contention* — the open throws
 * `database is locked`, or worse, a writer proceeds on a connection that never
 * got WAL and rows go missing. Measured: with the pragmas in the wrong order,
 * two of four concurrent-writer trials lost rows; with them in this order, all
 * four trials recorded every row. A harness bug here reads exactly like a
 * storage-engine defect, which is why the ordering is stated in code and pinned
 * by a test rather than left to whoever edits `configure` next.
 *
 * ## Both writes replace, and both are one transaction
 *
 * `writeBlobFacts` deletes every blob-scoped table's rows for the content keys it
 * replaces — those its caller's read did not cover, and those evicted since —
 * and inserts those; a covered key still in the ledger is only re-stamped (see
 * {@link writeBlobRows}). Replace rather than insert-if-absent for a
 * specific reason — see `schema-sql.ts` on SQLite's treatment of NULL in a
 * primary key, which makes a conflict clause unable to dedup the tables whose key
 * holds a nullable column. 🪤 The keys it clears are the union of what **every** blob-scoped table names,
 * never `blobs` alone: a declined blob is a `blob_conditions` row with no
 * `blobs` row, which is what every binary file in a corpus produces — see
 * {@link uniqueContentKeys}.
 *
 * `writeExtent` replaces **only the resolution contexts its own rows name**, not
 * the whole `(rootId, treeHash)` range: five of its eight tables are deleted one
 * context at a time, and the three with no context column are merged row by row
 * under their primary key. The interface states why (a tree is not a question,
 * and two commands ask different ones of it); the consequence here is that this
 * write is not a range operation and cannot be expressed as one.
 *
 * Neither is a lost-update hazard, because both keys name their own contents: a
 * second writer replacing the same key writes the same rows. That is what lets
 * many processes share one store with no lock of VAT's own.
 *
 * ## Eviction: the most recently used few trees per root, pruned by the write that grew it
 *
 * The store used to keep everything, and named the OS tmpdir purge as its
 * eviction policy. That was not adequate and the numbers say so plainly: the
 * extent key is a **whole-repository** tree hash, so any edit anywhere mints a
 * brand new full extent, and a five-edit sequence took one measured store from
 * 9.83 MB / 18,079 rows to 58.49 MB / 108,474 rows — and a larger repository's
 * from 33.83 MB to 202.80 MB — inside a minute. A purge that runs on a reboot,
 * or on some systems never, does not bound something that grows by a whole
 * corpus per keystroke-sized edit.
 *
 * So {@link writeExtentRows} keeps the
 * {@link SqliteStoreOptions.retainedExtentsPerRoot} most recently used trees
 * of the root it is writing and drops the rest, **inside its own transaction**.
 * A write and a served read are both a use (`usedAt`): reverting to the clean
 * tree after a few edits finds it held, because the run before the edits read it.
 * Three properties make that the cheap and safe place for it:
 *
 * - **Amortized, not deferred.** The write that adds an extent is the write that
 *   removes one, so the steady-state cost is a delete of what was just inserted:
 *   eight `DELETE … WHERE storeRootId = ? AND storeTreeHash = ?` statements over
 *   a **prefix of each table's own primary key**. There is no scan, no
 *   background thread, and no command that surprises an operator with a big
 *   bill. The one unbounded case — a store that already grew to hundreds of
 *   extents before this shipped — costs one pass, once, on its next write.
 * - **It can never evict the tree being written.** That tree is by construction
 *   the most recently used one, so recency ordering cannot select it. This is
 *   what keeps `vat build`'s second phase able to read what its first phase
 *   wrote, with no pin, no lease and no lock.
 * - **It cannot tear a concurrent read.** Reads run under `BEGIN DEFERRED` (see
 *   `inReadTransaction` on why autocommit reads go stale), and in WAL
 *   a reader stays on the snapshot it opened with. A delete committed by another
 *   process becomes visible to that reader only after it ends its transaction.
 *
 * Retention is **per root**, never global: two projects share one cache
 * namespace, and an age ordering across the whole manifest would let a busy
 * repository evict a quiet one's only extent.
 *
 * ## The blob tier is evicted too — by its own manifest, not by the extent's
 *
 * A blob fact belongs to bytes, not to a tree, so extent eviction can attribute
 * none of it, and its only bound used to be the release namespace rotating.
 * That is not a bound, and the tier is 153,245 of a 12,602-file adopter store's
 * 193,605 rows. So {@link BLOB_KEYS_TABLE} records when a write last held each key
 * and the logical bytes of its stored rows (`storedRowBytes`), and
 * {@link writeBlobRows} keeps the newest keys whose bytes fit
 * {@link SqliteStoreOptions.blobTierBudgetBytes}, on exactly `writeExtent`'s
 * terms: amortized into the write that grew it, unable to select the keys that
 * write just recorded, inside the same transaction. Bytes rather than a key
 * count, because keys differ in size by orders of magnitude: a count bounds
 * nothing an operator can check with `du`.
 *
 * 🔑 Evicting a key a surviving extent still references is SAFE — that is what
 * makes a global window admissible here and not for extents. `uncoveredContentKeys`
 * turns a missing key into a MISS, so the cost is one cold re-derivation rather
 * than a partial projection.
 */

import { unlinkSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import {
  type BlobFactsRead,
  type BlobFactsWrite,
  type BlobReferenceRow,
  type BlobRequest,
  type BlobScopedRows,
  type BlobScopedTableName,
  type ContentKey,
  type ExtentKey,
  type ExtentRequest,
  type ExtentScopedRows,
  type ExtentScopedTableName,
  type FactStore,
  type ProjectionColumnType,
  type RowSetId,
  type RowSetIdText,
  type RowSetRead,
  type RowSetRequest,
  type RowSetRows,
  type RowSetTableEntry,
  type RowSetTableName,
  type RowSetWrite,
  type StoreAttachTarget,
  STORE_BOOKKEEPING_TABLES,
  compareRowSetIds,
  parseContentKey,
  rowSetIdText,
  storedRowBytes,
  projectionColumnTypes,
  projectionStoreDirectoryName,
  quoteIdentifier,
  markVatCacheRoot,
  vatCacheNamespaceRoot,
} from '@vibe-agent-toolkit/resources';
import { VatError, classifyFsFault, compareCodeUnits, countWork, everywhere, isPathAbsentError, isVatError, pathPresent, promised, safePath, appendAll, workCountsObserved } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';

import {
  BLOB_KEYS_TABLE,
  BLOB_KEY_COLUMN,
  EXTENTS_TABLE,
  ROW_SET_KEYS_TABLE,
  ROW_SET_KEY_COLUMNS,
  TIER_BYTES_COLUMN,
  USED_AT_COLUMN,
  WRITTEN_AT_COLUMN,
  type StoredTableSpec,
  allSpecs,
  blobKeyColumn,
  createBookkeepingTableSql,
  createRowSetTableSql,
  createTableSql,
  deleteBlobFactsSql,
  deleteBlobPartitionSql,
  deleteExtentContextSql,
  deleteExtentSql,
  deleteRowByKeySql,
  deleteRowSetSql,
  insertRowSetSql,
  insertSql,
  rowSetSpecs,
  selectBlobFactsSql,
  selectBlobFactsWhereSql,
  selectBlobKeysPresentSql,
  selectBlobPartitionSql,
  selectExtentSql,
  selectRowSetSql,
  tierPastBudgetSql,
} from './schema-sql.js';
import { readOnlyDatabaseUri } from './sqlite-uri.js';
import { decodeRow, encodeKeyValue, encodeRow, type RowColumns, type SqliteResultValue, type SqliteValue } from './values.js';

/**
 * How long a blocked connection waits for a lock before giving up.
 *
 * Generous rather than tuned: the cost of waiting is latency on a cache write,
 * and the cost of not waiting is a spurious failure on a path whose whole
 * purpose is to be invisible. Measured lock waits under four concurrent writers
 * were 0–112 ms, so this is roughly two orders of magnitude of headroom.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * How many content keys go into one `IN (…)`.
 *
 * SQLite's compiled parameter limit is far higher on any build Node ships, but
 * a bounded batch also bounds the statement text that has to be compiled, and a
 * corpus can present tens of thousands of keys at once. 500 is small enough to
 * compile instantly and large enough that the per-statement overhead disappears.
 */
const KEY_BATCH_SIZE = 500;

/**
 * Return the pages an eviction freed to the file: what each tier's writer runs after a write that
 * evicted, outside its transaction (SQLite refuses it inside one).
 */
const INCREMENTAL_VACUUM_SQL = 'PRAGMA incremental_vacuum';

/** Fail a contended lock at once instead of waiting: what every best-effort or probing statement runs first. */
const NO_BUSY_WAIT_SQL = 'PRAGMA busy_timeout = 0';

/** The database file's name inside the store directory. */
const DATABASE_FILENAME = 'projection.db';

/**
 * How many of a root's trees survive a write, when the caller does not say.
 *
 * Three rather than one, and the difference is what a developer's actual
 * sequence looks like: edit, run, undo the edit, run again. One would make that
 * second run cold; three covers a short there-and-back without holding a
 * corpus-sized extent for every tree ever seen. It caps the extent tier at
 * roughly three times one scan of one repository — ~29 MB for the store measured
 * at 9.83 MB per extent — against the unbounded growth it replaces.
 *
 * Not tuned against a hit-rate curve, and stated here rather than implied: the
 * cost of being wrong low is one cold run, and the cost of being wrong high is
 * proportional disk. Both are cheap, which is why this is a constant and not a
 * knob every command has to plumb.
 */
const DEFAULT_RETAINED_EXTENTS_PER_ROOT = 3;

/**
 * How many roots keep their trees at all, when the caller does not say.
 *
 * ⛔ Per-root retention alone is not a bound. Every distinct root path — each
 * worktree, each CI job directory, each subdirectory a command ran from — kept
 * up to {@link DEFAULT_RETAINED_EXTENTS_PER_ROOT} trees forever, because nothing
 * ever reclaimed a root that was not written again. With the store on by default
 * that was unbounded growth. The least recently used root is dropped whole
 * once this many are held; a root is as recent as its most recently used tree, so a busy
 * repository is never aged out behind a quiet one.
 *
 * Arithmetic: eight roots × three trees × the 9.83 MB measured for one scan of a
 * 12,602-file adopter is a ~236 MB ceiling for the extent tier at that size, and
 * far less for an ordinary repository. Too low costs a cold run on the ninth
 * worktree; too high costs disk `vat cache clear` reclaims.
 */
const DEFAULT_RETAINED_ROOTS = 8;

/**
 * The blob tier's budget in logical bytes (`storedRowBytes`), as the CLI opens the
 * store: about 265 MB of database pages for the blob tier.
 *
 * Arithmetic, from one fresh store populated by `vat resources validate` and
 * `vat audit` over this repository, read after `wal_checkpoint(TRUNCATE)`: the
 * ledger held 3,972 keys and 12,179,272 bytes (3,066 a key); `dbstat` put the
 * blob tier's pages (its eight tables, their indexes, and `blob_keys`) at
 * 16,748,544 bytes, 1.375 file bytes per ledger byte. 265 MB / 1.375 is 192.7 MB,
 * rounded down to 190 MB: about 261 MB of pages, roughly 62,000 keys of this
 * repository's size. The extent tier is bounded on its own
 * ({@link DEFAULT_RETAINED_ROOTS}) and is not in this figure.
 *
 * The budget is **global**, because a blob fact has no root: every repository on
 * the machine shares it, so a machine scanning several corpora holds the newest
 * keys of all of them within it. Too low costs a cold parse of the keys evicted;
 * too high costs disk `vat cache clear` reclaims.
 */
export const DEFAULT_BLOB_TIER_BUDGET_BYTES = 190_000_000;

/**
 * The row-set tier's budget in logical bytes (`storedRowBytes`, recorded in
 * `row_set_keys.bytes`), as the CLI opens the store.
 *
 * Set equal to {@link DEFAULT_BLOB_TIER_BUDGET_BYTES}. Measured after a cold
 * `data__nodes` query under the default routing: this repository holds 38 row
 * sets in 0.26 MB of ledger bytes, and the largest adopter tree measured holds
 * 369 in 2.15 MB. Scaling this repository's figure by the blob tier's headroom
 * rule (a 1.375 file-to-ledger ratio) would give a budget the adopter's one
 * tree overruns, so the bound is the blob tier's instead: about 88 times that
 * adopter, and room for many corpora on one machine.
 *
 * ⚠️ A SECOND budget on top of the blob tier's, not a share of it; its
 * page-to-ledger ratio is unmeasured, so no page figure is claimed.
 *
 * **Global** and independent of the blob tier's: a large data corpus evicts
 * row sets, never blob facts, and the reverse.
 */
export const DEFAULT_ROW_SET_TIER_BUDGET_BYTES = 190_000_000;

/** The code of the error {@link openSqliteFactStore} throws for a budget that is not a positive finite number. */
export const PROJECTION_STORE_BUDGET_INVALID_CODE = 'PROJECTION_STORE_BUDGET_INVALID';

/** Retries for the WAL switch, which the busy handler does not cover — see {@link enableWal}. */
const WAL_SWITCH_ATTEMPTS = 50;

/** Pause between those attempts. 50 × 20 ms is a second of patience on a cold, contended store. */
const WAL_SWITCH_BACKOFF_MS = 20;

/** Where a store lives and how it behaves. */
export interface SqliteStoreOptions {
  /**
   * Directory to hold the database. Defaults to {@link defaultStoreDirectory}.
   *
   * Created if absent, along with any missing parents.
   */
  readonly directory?: string;
  /**
   * Milliseconds a blocked connection waits for a lock.
   *
   * Defaults to {@link BUSY_TIMEOUT_MS}. Exposed so a test can drive contention
   * without waiting seconds for it, not because a caller should tune it.
   */
  readonly busyTimeoutMs?: number;
  /**
   * How many of a root's most recently used (written or served) trees survive a write.
   *
   * Defaults to {@link DEFAULT_RETAINED_EXTENTS_PER_ROOT}. Clamped to at least
   * one: a retention of zero would delete the extent the caller is writing the
   * moment it committed, which is a cache that cannot hit rather than a cache
   * that holds nothing.
   */
  readonly retainedExtentsPerRoot?: number;
  /**
   * How many roots keep their trees at all. Defaults to
   * {@link DEFAULT_RETAINED_ROOTS}; clamped to at least one, for the same reason
   * as {@link SqliteStoreOptions.retainedExtentsPerRoot}.
   */
  readonly retainedRoots?: number;
  /**
   * The blob tier's budget, in the logical bytes `storedRowBytes` measures: a
   * write keeps the newest content keys whose recorded bytes fit it and evicts
   * the rest, except that the keys the write itself holds are never evicted,
   * whatever their size (a write larger than the budget holds its own keys until
   * a later, smaller write reclaims the surplus).
   *
   * Required, with no default here: the caller states the bound it is opening
   * the store under, and the CLI passes {@link DEFAULT_BLOB_TIER_BUDGET_BYTES}.
   * A budget that is not a positive finite number is refused with
   * {@link PROJECTION_STORE_BUDGET_INVALID_CODE}.
   *
   * ⚠️ Global, not per root — a blob fact belongs to bytes, so there is no root
   * to scope it to. See {@link DEFAULT_BLOB_TIER_BUDGET_BYTES} on what that
   * means for a machine holding several corpora.
   */
  readonly blobTierBudgetBytes: number;
  /**
   * The row-set tier's budget, in the same logical bytes, over its own ledger
   * (`row_set_keys`): a write keeps the newest row sets that fit and evicts the
   * rest, never a row set the write holds.
   *
   * Required, with no default here: the CLI passes
   * {@link DEFAULT_ROW_SET_TIER_BUDGET_BYTES}. A budget that is not a positive
   * finite number is refused with {@link PROJECTION_STORE_BUDGET_INVALID_CODE}.
   * Global, and independent of {@link SqliteStoreOptions.blobTierBudgetBytes}.
   */
  readonly rowSetTierBudgetBytes: number;
}

/**
 * Where a projection store lives when the caller does not say.
 *
 * Under the VAT cache namespace — which already separates one release's cache
 * from another's — and then under the projection's own **shape digest**, so a
 * change to the row schemas lands in a different file rather than being read
 * back as rows this build would misinterpret. No version, no migration: the old
 * directory simply goes cold, and `vat cache prune` (or the tmpdir purge) reclaims it.
 *
 * @returns Absolute path, forward-slashed
 */
export function defaultStoreDirectory(): string {
  return safePath.join(vatCacheNamespaceRoot(), projectionStoreDirectoryName());
}

/**
 * One table's prepared statements and the column metadata to drive them.
 *
 * 🪤 **Statements are prepared once and reused, and that is a correctness
 * requirement rather than a performance one.** A `StatementSync` that is
 * created inside a loop and then dropped is not finalized when it goes out of
 * scope, and in WAL mode an unfinalized read statement holds its **read
 * transaction open** — which pins the connection to the snapshot it first saw.
 * Measured: a reader preparing a fresh statement per iteration read an
 * *empty* store 50,000 times in a row while another process committed 500
 * transactions to it, with no error anywhere. Reusing the statement lets
 * SQLite reset it when the read completes, and the next read sees the newest
 * commit.
 */
interface TablePlan {
  readonly spec: StoredTableSpec;
  /** Each declared column paired with what it holds, in registry order. */
  readonly columns: RowColumns;
  readonly insert: StatementSync;
  /** Extent-scoped only: read this table for one tree. */
  readonly selectExtent?: StatementSync;
  /**
   * Extent-scoped only: clear this table's rows for a whole tree.
   *
   * Eviction's statement, and eviction's alone — see {@link deleteExtentSql} on
   * why a write must never reach for it.
   */
  readonly deleteExtent?: StatementSync;
  /**
   * Extent-scoped with a context column: clear one context of one tree.
   *
   * Absent for `roots`, `resources` and `resource_tags`, which have no context
   * to clear — {@link TablePlan.deleteRow} is how those are replaced.
   */
  readonly deleteExtentContext?: StatementSync;
  /** Extent-scoped only: remove the one row a primary key names. */
  readonly deleteRow?: StatementSync;
  /**
   * Extent-scoped only: the row's own key columns paired with what they hold,
   * in the order {@link TablePlan.deleteRow} binds them after the extent key.
   *
   * Precomputed rather than looked up per row, and paired with the kind rather
   * than the name alone, because the delete has to bind a key value in the
   * **stored** encoding — a boolean key column binds 1, not `true`, or the
   * predicate matches nothing and the insert that follows duplicates the row.
   */
  readonly keyColumns?: readonly (readonly [column: string, type: ProjectionColumnType])[];
}


/**
 * Open the file-backed fact store: the {@link FactStore} port, and nothing
 * else.
 *
 * The directory is created if absent, the schema is created if absent, and the
 * connection is configured before either — see this module's note on pragma
 * ordering.
 *
 * @param options - Where to put it, how patient to be, and each tier's budget
 * @returns An open store; close it when done
 * @throws VatError {@link PROJECTION_STORE_BUDGET_INVALID_CODE} when either
 *   budget is not a positive finite number — checked here as well as by the
 *   type, because JavaScript callers (the test children) are not typechecked
 *
 * @example
 * const store = openSqliteFactStore({
 *   blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES,
 *   rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES,
 * });
 * const { blobs, extent } = splitProjectionByScope(projection);
 * await store.writeBlobFacts({ rows: blobs, coveredAtRead: [], settledAtRead: [] });
 * await store.writeExtent({ rootId, treeHash }, extent);
 * await store.close();
 */
export function openSqliteFactStore(options: SqliteStoreOptions): FactStore {
  requireBudget('blob tier', options.blobTierBudgetBytes);
  requireBudget('row-set tier', options.rowSetTierBudgetBytes);
  // The default directory is under the persistable cache root: tag that root
  // (once per process) so `vat cache clear`/`prune` can recognise it as VAT's.
  if (options.directory === undefined) markVatCacheRoot();
  const directory = options.directory ?? defaultStoreDirectory();
  // 0o700: this cache holds link text, heading text and frontmatter source from
  // a corpus that may be private. The mode is a POSIX mechanism — on Windows it
  // only toggles the read-only bit — so it narrows exposure rather than
  // eliminating it.
  mkdirSyncReal(directory, { recursive: true, mode: 0o700 });
  const databasePath = safePath.join(directory, DATABASE_FILENAME);
  // Asked before the open, which creates the file: only a file that was already
  // there can be damaged, and only one that was there may ever be discarded.
  const existed = pathPresent(databasePath, 'entry', everywhere('destination'), 'probe');
  try {
    return openStoreAt(databasePath, options);
  } catch (error) {
    if (existed && isDamagedDatabaseFault(error)) throw new StoreUnopenableError(databasePath, error);
    throw error;
  }
}

/**
 * Refuse a tier budget that is not a positive finite number of bytes.
 *
 * @param tier - The tier, as the refusal names it
 * @param budget - The budget the caller passed, typed or not
 * @throws VatError {@link PROJECTION_STORE_BUDGET_INVALID_CODE}
 */
function requireBudget(tier: string, budget: unknown): void {
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
    throw new VatError(
      PROJECTION_STORE_BUDGET_INVALID_CODE,
      `The projection store's ${tier} budget must be a positive finite number of bytes, not ${String(budget)}.`,
    );
  }
}

/**
 * Open, configure and prepare the store's database file.
 *
 * @param databasePath - The database file
 * @param options - The caller's retention and patience settings
 * @returns The open store
 */
function openStoreAt(databasePath: string, options: SqliteStoreOptions): FactStore {
  const database = new DatabaseSync(databasePath);
  // A file that is not a database opens without complaint and fails at the
  // first statement, so everything after the open releases the connection on
  // the way out; an unclosed handle keeps the file locked on Windows.
  try {
    configure(database, options.busyTimeoutMs ?? BUSY_TIMEOUT_MS);
    createSchema(database);
    const tables = prepareStoreTables(database, {
      extentsPerRoot: Math.max(1, Math.trunc(options.retainedExtentsPerRoot ?? DEFAULT_RETAINED_EXTENTS_PER_ROOT)),
      roots: Math.max(1, Math.trunc(options.retainedRoots ?? DEFAULT_RETAINED_ROOTS)),
      blobTierBudgetBytes: options.blobTierBudgetBytes,
      rowSetTierBudgetBytes: options.rowSetTierBudgetBytes,
    });
    const busyTimeoutMs = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
    return new SqliteFactStore(tables, acquireDecodeLedger(databasePath), { path: databasePath, busyTimeoutMs });
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * What this process has decoded from one store file: per content key (`blob\0<key>`) or tree
 * (`extent\0<rootId>\0<treeHash>`), the tables it decoded, and for `blobReferences` each form.
 * A row decoded under an entry already here is decoded twice, counted
 * `store.rows.decoded.repeated`, which the system arms assert is zero.
 */
interface DecodeLedger {
  /** The store's database file, which keys {@link DECODE_LEDGERS}. */
  readonly path: string;
  /** How many open stores share this ledger. */
  open: number;
  readonly decoded: Map<string, Set<string>>;
}

/**
 * One ledger per database file while any store on it is open: two connections to one file in one
 * process (a question's connection beside the run's) share it, so a second read through either
 * counts. It is dropped when the last of them closes, so a later run in the same process (an
 * in-process test, an embedding tool) starts its own.
 */
const DECODE_LEDGERS = new Map<string, DecodeLedger>();

/**
 * Open the ledger of a store file, or join the one an open store on it holds.
 *
 * @param path - The store's database file
 * @returns The ledger, with this store counted open on it
 */
function acquireDecodeLedger(path: string): DecodeLedger {
  const ledger = DECODE_LEDGERS.get(path) ?? { path, open: 0, decoded: new Map<string, Set<string>>() };
  ledger.open += 1;
  DECODE_LEDGERS.set(path, ledger);
  return ledger;
}

/**
 * Leave a ledger; the last store to leave drops it.
 *
 * @param ledger - What {@link acquireDecodeLedger} returned
 */
function releaseDecodeLedger(ledger: DecodeLedger): void {
  ledger.open -= 1;
  if (ledger.open === 0 && DECODE_LEDGERS.get(ledger.path) === ledger) DECODE_LEDGERS.delete(ledger.path);
}

/**
 * The ledger entry of one content key.
 *
 * @param contentKey - The key
 * @returns Its entry name in {@link DecodeLedger.decoded}
 */
function blobLedgerEntry(contentKey: string): string {
  return `blob\0${contentKey}`;
}

/**
 * The ledger entry of one tree.
 *
 * @param key - Which root, which tree
 * @returns Its entry name in {@link DecodeLedger.decoded}
 */
function extentLedgerEntry(key: ExtentKey): string {
  return `extent\0${key.rootId}\0${key.treeHash}`;
}

/**
 * Count the rows one read decodes again, and record what it decoded. Every slot is judged against
 * the ledger as it stood before this read, so the many rows one read decodes under one slot (a
 * key's references of one form) count once each, never as repeats of each other.
 *
 * @param ledger - The store file's ledger
 * @param slots - Each decoded row's `[entry, slot]`, one per row
 * @returns How many of those rows an earlier read had decoded
 */
function recordDecoded(ledger: DecodeLedger, slots: readonly (readonly [entry: string, slot: string])[]): number {
  let repeated = 0;
  const fresh: (readonly [string, string])[] = [];
  for (const pair of slots) {
    if (ledger.decoded.get(pair[0])?.has(pair[1]) === true) repeated += 1;
    else fresh.push(pair);
  }
  for (const [entry, slot] of fresh) {
    let held = ledger.decoded.get(entry);
    if (held === undefined) {
      held = new Set<string>();
      ledger.decoded.set(entry, held);
    }
    held.add(slot);
  }
  return repeated;
}

/** The code {@link StoreUnopenableError} carries. */
export const PROJECTION_STORE_UNOPENABLE_CODE = 'PROJECTION_STORE_UNOPENABLE';

/**
 * SQLite's primary result codes that say the FILE's bytes are the problem,
 * not the moment: `SQLITE_CORRUPT` (11) and `SQLITE_NOTADB` (26).
 *
 * 🪤 Deliberately not `SQLITE_BUSY`/`SQLITE_LOCKED`: a store another process
 * holds is healthy, and discarding it would destroy a working cache under a
 * concurrent run. Nor `SQLITE_CANTOPEN`/`SQLITE_IOERR`/`SQLITE_FULL`/
 * `SQLITE_READONLY`: those are the machine's state (a permission, a path, a
 * full disk), and a fresh file would fail the same way.
 */
const DAMAGED_DATABASE_RESULT_CODES: ReadonlySet<number> = new Set([11, 26]);

/**
 * SQLite's primary result codes that say another connection holds the
 * database: `SQLITE_BUSY` (5) and `SQLITE_LOCKED` (6). The moment, not the file.
 */
const CONTENDED_RESULT_CODES: ReadonlySet<number> = new Set([5, 6]);

/**
 * @param error - Anything thrown
 * @returns SQLite's primary result code when `error` itself is a SQLite error, else `undefined`
 */
function sqlitePrimaryResultCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, errcode } = error as Error & { code?: unknown; errcode?: unknown };
  return code === 'ERR_SQLITE_ERROR' && typeof errcode === 'number' ? errcode & 0xff : undefined;
}

/**
 * Whether `error`, or any error in its `cause` chain, is a SQLite failure whose
 * primary result code says the database file is damaged or unopenable.
 *
 * @param error - What the open threw
 * @returns True for a damaged-file fault
 */
function isDamagedDatabaseFault(error: unknown): boolean {
  return someSqliteFault(error, (primary) => DAMAGED_DATABASE_RESULT_CODES.has(primary));
}

/**
 * Whether `error`, or any error in its `cause` chain, is a SQLite failure whose
 * primary result code `matches`.
 *
 * @param error - Anything thrown
 * @param matches - Decides by primary result code
 * @returns True when one in the chain matches
 */
function someSqliteFault(error: unknown, matches: (primary: number) => boolean): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const primary = sqlitePrimaryResultCode(current);
    if (primary !== undefined && matches(primary)) return true;
  }
  return false;
}

/**
 * An existing store file SQLite could not open as a database: corrupt,
 * truncated, or not a database at all. A file SQLite cannot open for a
 * machine reason (a permission, a directory in its place, a full disk) is not
 * this error: it surfaces as itself, because discarding would not fix it.
 *
 * Thrown only at open, and only for a file that was there before the open —
 * never for a store that fails mid-run, which surfaces as itself. The caller
 * decides whether a damaged cache is a miss ({@link discardStoreDatabase},
 * then open again); this package never deletes on its own.
 */
export class StoreUnopenableError extends VatError {
  /** The database file that could not be opened. */
  readonly databasePath: string;

  /**
   * @param databasePath - The database file
   * @param cause - SQLite's error
   */
  constructor(databasePath: string, cause: unknown) {
    super(
      PROJECTION_STORE_UNOPENABLE_CODE,
      `The projection store at ${databasePath} could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.databasePath = databasePath;
  }
}

/**
 * Whether `error` is a {@link StoreUnopenableError}.
 *
 * @param error - Anything thrown
 * @returns True when it is one
 */
export function isStoreUnopenableError(error: unknown): error is StoreUnopenableError {
  return isVatError(error, PROJECTION_STORE_UNOPENABLE_CODE) && error instanceof StoreUnopenableError;
}

/**
 * SQLite's primary result codes that say this connection may not use the store
 * file here: `SQLITE_READONLY` (8), its whole family (a read-only file, a
 * read-only directory for the journal, a recovery it may not run), and
 * `SQLITE_CANTOPEN` (14), its whole family (a read-only directory with no
 * database file yet, which SQLite cannot create). Mostly the machine's state,
 * not the file's; one member is not: `SQLITE_CANTOPEN_ISDIR` (a directory where
 * the store file should be) is in the family too, so an optional question
 * connection swallows it as well and goes without the store.
 */
const NOT_WRITABLE_HERE_RESULT_CODES: ReadonlySet<number> = new Set([8, 14]);

/**
 * Whether `error`, or any error in its `cause` chain, is a SQLite failure that
 * says the store cannot answer now: another connection holds it
 * (`SQLITE_BUSY`, `SQLITE_LOCKED`), this one may not write it
 * (`SQLITE_READONLY`), or this one cannot open or create it (`SQLITE_CANTOPEN`,
 * including `SQLITE_CANTOPEN_ISDIR`, a directory at the store's path, which is
 * not a sound file). For a caller whose use of the store is optional and that
 * would rather go without than wait or refuse; a caller that needs the store
 * does not ask, and meets these as themselves.
 *
 * @param error - Anything a store call or open threw
 * @returns True when the store is contended, read-only or cannot be opened here
 */
export function isStoreUnavailableNow(error: unknown): boolean {
  return someSqliteFault(error, (primary) => CONTENDED_RESULT_CODES.has(primary) || NOT_WRITABLE_HERE_RESULT_CODES.has(primary));
}

/**
 * Delete a store's database file and its `-wal`/`-shm` companions.
 *
 * For the database a {@link StoreUnopenableError} names: the store is a cache,
 * so a file SQLite cannot open is worth nothing and is rebuilt by the next
 * write. The companions go too — a `-wal` left beside a fresh database would
 * be replayed into it.
 *
 * @param databasePath - The database file to delete
 * @throws {FsFaultError} When the OS refuses to delete one of the files
 */
export function discardStoreDatabase(databasePath: string): void {
  for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      unlinkSync(file);
    } catch (error) {
      if (isPathAbsentError(error)) continue;
      throw classifyFsFault(error, { side: 'destination', action: 'discard the unopenable projection store', path: file });
    }
  }
}

/**
 * Whether another connection — in this process or any other — has the store
 * in `directory` open, so deleting it would pull it from under a
 * running VAT (another worktree's, or another release's, under a shared cache
 * root).
 *
 * Asks SQLite rather than guessing from `-wal`/`-shm` files, which outlive a
 * crashed process: a connection in exclusive locking mode cannot begin an
 * exclusive transaction while any other connection, reader or writer, holds
 * the WAL database open. The busy timeout is zero, so a held store answers at
 * once. Only contention (`SQLITE_BUSY`/`SQLITE_LOCKED`) means in use; a file
 * SQLite cannot read as a database is held by nothing. An absent file is never
 * created by asking.
 *
 * 🪤 A point-in-time answer: a process can open the store right after it says
 * "free". A caller that deletes on that answer narrows the window to the
 * delete itself; it cannot close it.
 *
 * @param directory - The store's directory, as {@link defaultStoreDirectory} names one
 * @returns True when another connection holds its database open
 */
export function isStoreInUse(directory: string): boolean {
  const databasePath = safePath.join(directory, DATABASE_FILENAME);
  if (!pathPresent(databasePath, 'entry', everywhere('destination'), 'probe')) return false;
  let probe: DatabaseSync | undefined;
  try {
    probe = new DatabaseSync(databasePath);
    probe.exec(NO_BUSY_WAIT_SQL);
    probe.exec('PRAGMA locking_mode = EXCLUSIVE');
    probe.exec('BEGIN EXCLUSIVE');
    probe.exec('ROLLBACK');
    return false;
  } catch (error) {
    const primary = sqlitePrimaryResultCode(error);
    if (primary === undefined) throw error;
    return CONTENDED_RESULT_CODES.has(primary);
  } finally {
    probe?.close();
  }
}

/**
 * Fold the WAL back into the database file before a close, so the store
 * directory holds one complete `projection.db` — what a CI cache save of
 * `VAT_CACHE_DIR` needs, since it may not carry `-wal` beside it.
 *
 * SQLite does this itself when the LAST connection closes; this covers a close
 * while another process still has the store open. `TRUNCATE` also empties the
 * `-wal` file.
 *
 * Best-effort, and that is safe rather than hopeful: a checkpoint never loses a
 * committed transaction — what it cannot copy (a reader pinned to an older
 * snapshot) stays in the WAL, where every connection still reads it, and the
 * last close folds it in. The busy timeout is dropped to zero first, so a
 * contended checkpoint returns at once instead of holding the close for the
 * full timeout; a `busy` result and a thrown `SQLITE_BUSY`/`SQLITE_LOCKED` are
 * both that case. Any other failure (`SQLITE_IOERR`, `SQLITE_FULL`,
 * `SQLITE_CORRUPT`) is the store or the machine failing, and surfaces — after
 * the connection is closed, see {@link SqliteFactStore.close}.
 * Pinned by `store-damage.integration.test.ts` (a reader mid-snapshot during close).
 *
 * @param database - The connection about to close
 */
function checkpointBestEffort(database: DatabaseSync): void {
  // Only contention is benign: see above — the WAL keeps what it could not copy.
  unlessContended(() => {
    database.exec(NO_BUSY_WAIT_SQL);
    database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  });
}

/**
 * Run `work`, treating a contended database (`SQLITE_BUSY`/`SQLITE_LOCKED`) as
 * work not done. Every other failure surfaces.
 *
 * @param work - A best-effort write whose loss under contention is harmless
 */
function unlessContended(work: () => void): void {
  try {
    work();
  } catch (error) {
    const primary = sqlitePrimaryResultCode(error);
    if (primary === undefined || !CONTENDED_RESULT_CODES.has(primary)) throw error;
  }
}

/**
 * Record that a read just served one extent, so retention evicts the least
 * recently USED tree rather than the least recently written: the revert after a
 * few edits finds its clean tree still held.
 *
 * A write on a read path, so it is best-effort on exactly
 * {@link checkpointBestEffort}'s terms. It runs after the read's snapshot has
 * committed, in its own autocommit transaction, with the busy timeout dropped
 * to zero: another connection holding the write lock costs this one stamp,
 * never the read and never the timeout's wait. A lost stamp leaves the tree
 * aged by its previous use, which is the order the store kept before. Any other
 * failure (`SQLITE_IOERR`, `SQLITE_FULL`, `SQLITE_READONLY`) is the store or the
 * machine failing, and surfaces.
 *
 * @param tables - The connection's statements
 * @param key - The extent the read served
 * @param busyTimeoutMs - The connection's own busy timeout, restored afterwards
 */
function recordExtentUseBestEffort(tables: StoreTables, key: ExtentKey, busyTimeoutMs: number): void {
  tables.database.exec(NO_BUSY_WAIT_SQL);
  try {
    unlessContended(() => tables.recordExtentUse.run(new Date().toISOString(), key.rootId, key.treeHash));
  } finally {
    tables.database.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
  }
}

/**
 * Put a fresh connection into the mode this store needs.
 *
 * @param database - A newly opened connection
 * @param busyTimeoutMs - How long to wait for a contended lock
 */
function configure(database: DatabaseSync, busyTimeoutMs: number): void {
  // FIRST. See this module's header — the WAL switch itself needs a busy
  // handler already installed, or it fails under contention.
  database.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
  // Before the schema exists, because that is the only moment it takes. SQLite
  // writes the auto-vacuum flag into the file header when the first table is
  // created and refuses to change it afterwards except through a full `VACUUM`,
  // so a store created before this line stays at `NONE` for its whole life —
  // which is correct rather than a gap: its freed pages go to the freelist and
  // are reused, so it stops GROWING even though it never shrinks, and the
  // namespace rotates on the next release anyway.
  //
  // Without it, `PRAGMA incremental_vacuum` is silently a no-op and every page a
  // prune frees stays in the file. An operator measuring the fix with `du` would
  // then see a 58 MB cache that "was fixed", which is the worst of both.
  database.exec('PRAGMA auto_vacuum = INCREMENTAL');
  enableWal(database);
  // NORMAL rather than FULL: a cache that loses its most recent commit to a
  // power cut is repopulated by the next run, and FULL costs an fsync per
  // transaction to protect data whose recovery procedure is "rescan".
  database.exec('PRAGMA synchronous = NORMAL');
}

/**
 * Put the database into WAL, tolerating another process doing the same thing at
 * the same moment.
 *
 * 🪤 **The busy handler does not cover this statement**, which is sharper than
 * "set `busy_timeout` first" and was measured rather than assumed: four
 * processes opening a fresh store simultaneously produced
 * `ERR_SQLITE_ERROR: database is locked` from `PRAGMA journal_mode = WAL` with a
 * 5,000 ms timeout already installed. Changing the journal mode takes an
 * exclusive lock that SQLite does not retry through the busy handler, so a
 * caller that treats one attempt as definitive fails on a cold cache exactly
 * when several `vat` invocations start together — the common case.
 *
 * What makes retrying correct rather than hopeful is that **WAL is a persistent
 * property of the file**, not of the connection: whichever process wins writes
 * it into the header and every other process then reads it back and has nothing
 * to do. So this checks first, attempts only if needed, and re-checks — a
 * losing racer usually finds the mode already switched.
 *
 * @param database - A connection with its busy timeout already set
 * @throws Error When the database is still not in WAL after every attempt
 */
function enableWal(database: DatabaseSync): void {
  for (let attempt = 0; attempt <= WAL_SWITCH_ATTEMPTS; attempt += 1) {
    if (journalMode(database) === 'wal') return;
    try {
      database.exec('PRAGMA journal_mode = WAL');
    } catch (error) {
      if (attempt === WAL_SWITCH_ATTEMPTS) {
        throw new Error(`Could not put the projection store into WAL mode: ${String(error)}`, { cause: error });
      }
    }
    sleepBriefly(WAL_SWITCH_BACKOFF_MS);
  }
  throw new Error('Could not put the projection store into WAL mode: it is still using a rollback journal');
}

/**
 * The journal mode the connection is currently in.
 *
 * @param database - An open connection
 * @returns The mode, lowercased, or the empty string if it cannot be read
 */
function journalMode(database: DatabaseSync): string {
  const row = database.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
  return typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : '';
}

/**
 * Block this thread briefly.
 *
 * `Atomics.wait` rather than a timer: everything on this path is synchronous,
 * and an `await` here would let a caller's next statement run against a
 * connection that is not configured yet.
 *
 * @param milliseconds - How long to wait
 */
function sleepBriefly(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Create every table this store uses, if it is not there already.
 *
 * @param database - An open, configured connection
 */
function createSchema(database: DatabaseSync): void {
  // Built from the declaration the shape digest hashes: a store written before a
  // bookkeeping column existed lives under another digest, so `IF NOT EXISTS`
  // never meets a table of another shape.
  for (const table of Object.values(STORE_BOOKKEEPING_TABLES)) {
    database.exec(createBookkeepingTableSql(table));
  }
  for (const spec of allSpecs()) {
    database.exec(createTableSql(spec));
  }
  for (const spec of rowSetSpecs()) {
    database.exec(createRowSetTableSql(spec));
  }
}

/**
 * How much of each tier a write keeps: see {@link SqliteStoreOptions}. The two
 * extent counts are already clamped to at least one; the budgets are validated at open.
 */
interface Retention {
  readonly extentsPerRoot: number;
  readonly roots: number;
  readonly blobTierBudgetBytes: number;
  readonly rowSetTierBudgetBytes: number;
}

/**
 * One byte-budgeted tier: its ledger's past-budget statement ({@link tierPastBudgetSql}), the
 * ledger columns naming a member in the order a held tuple lists them, and its budget. The blob
 * tier and the row-set tier are two of these, evicted by the one {@link evictPastBudget}.
 */
interface StoreTier {
  readonly pastBudget: StatementSync;
  readonly identity: readonly string[];
  readonly budgetBytes: number;
}

/**
 * One row-set table's prepared statements. Prepared once, for {@link TablePlan}'s reason; every
 * statement binds one row set as `(blob, variant)`, the instance being the table's own.
 */
interface RowSetPlan {
  readonly spec: RowSetTableEntry;
  /** Each declared column paired with what it holds, in registry order. */
  readonly columns: RowColumns;
  readonly insert: StatementSync;
  readonly select: StatementSync;
  readonly remove: StatementSync;
}

/**
 * One connection's prepared storage statements and the retention its writes
 * apply — what the row writers ({@link writeBlobRows}, {@link writeExtentRows})
 * and the fact store's reads run against. The fact store's alone: the run
 * database is filled by hydration, which neither clears, evicts nor vacuums.
 */
interface StoreTables {
  readonly database: DatabaseSync;
  readonly plans: readonly TablePlan[];
  readonly recordExtent: StatementSync;
  /** Re-stamp one extent's `usedAt` on a served read — see {@link recordExtentUseBestEffort}. */
  readonly recordExtentUse: StatementSync;
  readonly extentPresent: StatementSync;
  /** Eviction's two statements: which trees are past the window, and how to forget one. */
  readonly extentsPastRetention: StatementSync;
  readonly forgetExtent: StatementSync;
  /** Which roots are past the machine-wide root window — see {@link DEFAULT_RETAINED_ROOTS}. */
  readonly rootsPastRetention: StatementSync;
  /**
   * The blob tier's ledger statements — see {@link BLOB_KEYS_TABLE}. A replaced
   * key is recorded with the bytes this write inserted for it; a key the write
   * did not replace is re-stamped with its recorded bytes plus a delta (the bytes
   * of the pairs it re-inserted, less those of the stored pair rows it deleted).
   */
  readonly recordBlobKey: StatementSync;
  readonly restampBlobKey: StatementSync;
  /** Whether one key has a ledger row: the writer's "evicted since the read?" lookup. */
  readonly blobKeyPresent: StatementSync;
  readonly blobTier: StoreTier;
  readonly forgetBlobKey: StatementSync;
  /** The row-set tables' statements, in registry order. */
  readonly rowSetPlans: readonly RowSetPlan[];
  /**
   * The row-set tier's ledger statements — see {@link ROW_SET_KEYS_TABLE}, each bound by the
   * ledger's key `(contentKey, instance, variant)` first. A replaced row set is recorded with the
   * bytes this write inserted; a covered one still in the ledger is re-stamped with its own.
   */
  readonly recordRowSet: StatementSync;
  readonly restampRowSet: StatementSync;
  readonly rowSetPresent: StatementSync;
  readonly forgetRowSet: StatementSync;
  readonly rowSetTier: StoreTier;
  /** Blob-fact statements memoized by table and placeholder count — see {@link TablePlan}. */
  readonly blobStatements: Map<string, StatementSync>;
  readonly retention: Retention;
}

/**
 * Prepare every storage statement on one connection whose schema exists.
 *
 * @param database - An open connection holding the projection tables
 * @param retention - How many of each tier a write keeps
 * @returns The prepared statements
 */
function prepareStoreTables(database: DatabaseSync, retention: Retention): StoreTables {
  return {
    database,
    retention,
    plans: allSpecs().map((spec) => ({
      spec,
      columns: projectionColumnTypes(spec),
      insert: database.prepare(insertSql(spec)),
      ...(spec.scope === 'extent'
        ? {
            selectExtent: database.prepare(selectExtentSql(spec)),
            deleteExtent: database.prepare(deleteExtentSql(spec)),
            deleteRow: database.prepare(deleteRowByKeySql(spec)),
            keyColumns: keyColumnTypes(spec),
            // Guarded here rather than at run time: `deleteExtentContextSql`
            // throws for a table with no context column, and the three that
            // have none are merged row by row instead.
            ...(spec.contextColumn === undefined
              ? {}
              : { deleteExtentContext: database.prepare(deleteExtentContextSql(spec)) }),
          }
        : {}),
    })),
    recordExtent: database.prepare(
      `INSERT OR REPLACE INTO "${EXTENTS_TABLE}" ("storeRootId", "storeTreeHash", "${WRITTEN_AT_COLUMN}", "${USED_AT_COLUMN}") VALUES (?, ?, ?, ?)`,
    ),
    // A `REPLACE` rather than an `UPDATE`, so a use moves the row's `rowid` as a
    // write does and the tie-break below orders by use too. It carries `writtenAt`
    // over unchanged, and inserts nothing for a key with no manifest row.
    recordExtentUse: database.prepare(
      `INSERT OR REPLACE INTO "${EXTENTS_TABLE}" ("storeRootId", "storeTreeHash", "${WRITTEN_AT_COLUMN}", "${USED_AT_COLUMN}")`
      + ` SELECT "storeRootId", "storeTreeHash", "${WRITTEN_AT_COLUMN}", ? FROM "${EXTENTS_TABLE}"`
      + ' WHERE "storeRootId" = ? AND "storeTreeHash" = ?',
    ),
    extentPresent: database.prepare(
      `SELECT 1 FROM "${EXTENTS_TABLE}" WHERE "storeRootId" = ? AND "storeTreeHash" = ?`,
    ),
    // `LIMIT -1 OFFSET ?` is SQLite's spelling of "everything past the first N".
    // Least recently used first: `usedAt` is stamped by a write and by a served
    // read. The `rowid` tie-break is load-bearing: `usedAt` is an ISO-8601 string
    // with millisecond resolution, and two uses inside one millisecond are
    // ordinary, so ordering by it alone leaves the victim unspecified.
    extentsPastRetention: database.prepare(
      `SELECT "storeTreeHash" FROM "${EXTENTS_TABLE}" WHERE "storeRootId" = ?`
      + ` ORDER BY "${USED_AT_COLUMN}" DESC, "rowid" DESC LIMIT -1 OFFSET ?`,
    ),
    // A root is as recent as its most recently used tree. `MAX(rowid)` breaks the
    // tie for the same reason the per-root statement above uses `rowid`.
    rootsPastRetention: database.prepare(
      `SELECT "storeRootId" FROM "${EXTENTS_TABLE}" GROUP BY "storeRootId"`
      + ` ORDER BY MAX("${USED_AT_COLUMN}") DESC, MAX("rowid") DESC LIMIT -1 OFFSET ?`,
    ),
    forgetExtent: database.prepare(
      `DELETE FROM "${EXTENTS_TABLE}" WHERE "storeRootId" = ? AND "storeTreeHash" = ?`,
    ),
    // The blob tier's, mirroring the extent tier's above — including the `rowid`
    // tie-break among the keys the write does not hold. The ones it holds are
    // protected by key, not by the order (see tierPastBudgetSql).
    recordBlobKey: database.prepare(`${RECORD_BLOB_KEY_SQL} VALUES (?, ?, ?)`),
    // The sub-select reads the row the `REPLACE` is about to delete: SQLite
    // evaluates the values before it resolves the conflict.
    restampBlobKey: database.prepare(
      `${RECORD_BLOB_KEY_SQL} VALUES (?, ?, COALESCE((SELECT ${quoteIdentifier(TIER_BYTES_COLUMN)}`
      + ` FROM ${quoteIdentifier(BLOB_KEYS_TABLE)} WHERE ${quoteIdentifier(BLOB_KEY_COLUMN)} = ?), 0) + ?)`,
    ),
    blobKeyPresent: database.prepare(
      `SELECT 1 FROM ${quoteIdentifier(BLOB_KEYS_TABLE)} WHERE ${quoteIdentifier(BLOB_KEY_COLUMN)} = ?`,
    ),
    blobTier: {
      pastBudget: database.prepare(tierPastBudgetSql(STORE_BOOKKEEPING_TABLES.blobKeys, [BLOB_KEY_COLUMN])),
      identity: [BLOB_KEY_COLUMN],
      budgetBytes: retention.blobTierBudgetBytes,
    },
    forgetBlobKey: database.prepare(
      `DELETE FROM ${quoteIdentifier(BLOB_KEYS_TABLE)} WHERE ${quoteIdentifier(BLOB_KEY_COLUMN)} = ?`,
    ),
    rowSetPlans: rowSetSpecs().map((spec) => ({
      spec,
      columns: projectionColumnTypes(spec),
      insert: database.prepare(insertRowSetSql(spec)),
      select: database.prepare(selectRowSetSql(spec)),
      remove: database.prepare(deleteRowSetSql(spec)),
    })),
    recordRowSet: database.prepare(`${RECORD_ROW_SET_SQL} VALUES (?, ?, ?, ?, ?)`),
    // The sub-select reads the row the `REPLACE` is about to delete, as `restampBlobKey`'s does;
    // run only for a row set whose ledger row the same transaction just found.
    restampRowSet: database.prepare(
      `${RECORD_ROW_SET_SQL} VALUES (?, ?, ?, ?, (SELECT ${quoteIdentifier(TIER_BYTES_COLUMN)}`
      + ` FROM ${quoteIdentifier(ROW_SET_KEYS_TABLE)} WHERE ${ROW_SET_KEY_PREDICATE}))`,
    ),
    rowSetPresent: database.prepare(`SELECT 1 FROM ${quoteIdentifier(ROW_SET_KEYS_TABLE)} WHERE ${ROW_SET_KEY_PREDICATE}`),
    forgetRowSet: database.prepare(`DELETE FROM ${quoteIdentifier(ROW_SET_KEYS_TABLE)} WHERE ${ROW_SET_KEY_PREDICATE}`),
    rowSetTier: {
      pastBudget: database.prepare(tierPastBudgetSql(STORE_BOOKKEEPING_TABLES.rowSetKeys, ROW_SET_KEY_COLUMNS)),
      identity: ROW_SET_KEY_COLUMNS,
      budgetBytes: retention.rowSetTierBudgetBytes,
    },
    blobStatements: new Map<string, StatementSync>(),
  };
}

/** The ledger insert both blob-key statements share; the caller appends the `VALUES`. */
const RECORD_BLOB_KEY_SQL = `INSERT OR REPLACE INTO ${quoteIdentifier(BLOB_KEYS_TABLE)}`
  + ` (${[BLOB_KEY_COLUMN, WRITTEN_AT_COLUMN, TIER_BYTES_COLUMN].map((column) => quoteIdentifier(column)).join(', ')})`;

/** The ledger insert both row-set statements share: the key columns, then `writtenAt`, then `bytes`. */
const RECORD_ROW_SET_SQL = `INSERT OR REPLACE INTO ${quoteIdentifier(ROW_SET_KEYS_TABLE)}`
  + ` (${[...ROW_SET_KEY_COLUMNS, WRITTEN_AT_COLUMN, TIER_BYTES_COLUMN].map((column) => quoteIdentifier(column)).join(', ')})`;

/** One row set's ledger row by primary key, bound as {@link rowSetKeyValues}. */
const ROW_SET_KEY_PREDICATE = ROW_SET_KEY_COLUMNS.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');

/**
 * One row set's ledger key, in {@link ROW_SET_KEY_COLUMNS} order: read off the ledger's declared
 * key, so a reordered declaration reorders every binding with it.
 *
 * @param id - The row set
 * @returns Its key values
 * @throws TypeError When the ledger's key names a column a row-set id does not carry
 */
function rowSetKeyValues(id: RowSetId): readonly string[] {
  const fields: Readonly<Record<string, string>> = { contentKey: id.contentKey, instance: id.instance, variant: id.variant };
  return ROW_SET_KEY_COLUMNS.map((column) => {
    const value = fields[column];
    if (value === undefined) throw new TypeError(`${ROW_SET_KEYS_TABLE} keys on '${column}', which a row-set id does not carry`);
    return value;
  });
}

/** A table bundle seen structurally: table key to rows. */
type RowBundle = Record<string, readonly Record<string, unknown>[]>;

/**
 * Write blob facts: the row writer behind `FactStore.writeBlobFacts`.
 *
 * The held keys are the union of the content keys **every** blob-scoped table
 * names, not the keys `blobs` alone names — see
 * {@link uniqueContentKeys} for why the difference is the whole feature.
 *
 * ⛔ Except in a PARTITIONED table (`partitionColumn` — the harness tables),
 * where it clears only the `(blob, partition)` pairs this write carries rows
 * for: those rows are derived lazily, for what one tree reaches, so a run
 * over another root that holds the same bytes without reaching them must not
 * delete the facts this one derived.
 *
 * ## Replace what the read did not cover; re-stamp everything held
 *
 * The held keys are the content keys `write.rows` names. Inside one
 * `BEGIN IMMEDIATE` transaction:
 *
 * 1. each held key the caller's read covered is looked up in the ledger by
 *    primary key. That answers "was it evicted since the read", not "is it
 *    present": rows leave only with their ledger row, and are immutable per
 *    key, so a key still in the ledger is unchanged since the read;
 * 2. the held keys not covered at read, and the covered ones gone from the
 *    ledger, are replaced: every row of the key is deleted, in every table,
 *    partitioned ones included, then the write's rows are inserted. Every
 *    carried harness pair not settled at read of a key NOT replaced is replaced
 *    pair by pair. A covered key still in the ledger keeps its other rows;
 * 3. every held key is re-stamped, after the inserts, with its bytes: a replaced
 *    key with what this write inserted for it, any other with its recorded bytes
 *    plus what this write inserted for it less what it deleted of it;
 * 4. the newest keys whose bytes fit the budget are kept, the held ones always
 *    (by key: their bytes count first, and none of them is ever selected).
 *
 * ## The ledger is exact
 *
 * `blob_keys.bytes` equals `storedRowBytes` summed over the key's stored rows,
 * by step 3: a replaced key holds exactly the rows this write inserted (which is
 * why its clear takes its partitioned rows too — another root's lazily derived
 * pairs for those bytes are re-derived once, the cost of a key that was
 * uncovered or evicted), and a key not replaced loses exactly the stored rows
 * of the pairs it deletes, measured by an indexed read of each pair just before
 * its delete. Nothing sums the stored rows of the store under the lock.
 *
 * A write naming no content key writes nothing and counts nothing.
 *
 * @param tables - The connection's statements
 * @param write - The held rows and what the caller's read covered
 * @returns The keys whose stored rows the write changed: every key it replaced, and every key it
 *   added a partitioned row to; never a covered key it only re-stamped
 */
function writeBlobRows(tables: StoreTables, write: BlobFactsWrite): readonly string[] {
  const bundle = write.rows as unknown as RowBundle;
  const held = uniqueContentKeys(bundle);
  if (held.length === 0) return [];

  let evicted = 0;
  let written = 0;
  let changed: readonly string[] = [];
  inTransaction(tables.database, () => {
    const replaced = keysToReplace(tables, held, write.coveredAtRead);
    const replacing = rowsToReplace(bundle, replaced, write.settledAtRead);
    changed = uniqueContentKeys(replacing);
    const deleted = clearSpaceForBlobs(tables, replacing, replaced);
    const inserted = insertBlobBundle(tables, replacing);
    written = inserted.rows;
    // EVERY held key, AFTER the rows and BEFORE the eviction, for the reason
    // `writeExtentRows` records its manifest row before evicting: a key not
    // re-stamped keeps its old place in the ordering, so a budget smaller than
    // the store would evict a covered key this write holds.
    const writtenAt = new Date().toISOString();
    for (const key of held) {
      const added = inserted.bytes.get(key) ?? 0;
      if (replaced.has(key)) tables.recordBlobKey.run(key, writtenAt, added);
      else tables.restampBlobKey.run(key, writtenAt, key, added - (deleted.get(key) ?? 0));
    }
    evicted = evictBlobKeysPastBudget(tables, held);
  });
  countWrite(written);
  // Outside the transaction, because SQLite refuses `incremental_vacuum`
  // inside one — the same arrangement, and the same reason, as `writeExtentRows`.
  if (evicted > 0) tables.database.exec(INCREMENTAL_VACUUM_SQL);
  return changed;
}

/**
 * The held keys a blob write replaces: those its read did not cover, and the
 * covered ones evicted since — a ledger lookup per covered key, under the
 * write lock, so an eviction cannot land between the lookup and the insert.
 *
 * @param tables - The connection's statements
 * @param held - The keys the write holds rows for
 * @param coveredAtRead - The keys the caller's read covered
 * @returns The keys to delete and insert
 */
function keysToReplace(tables: StoreTables, held: readonly string[], coveredAtRead: readonly string[]): ReadonlySet<string> {
  const covered = new Set(coveredAtRead);
  return new Set(held.filter((key) => !covered.has(key) || tables.blobKeyPresent.get(key) === undefined));
}

/**
 * The rows of one blob write that replace what the store holds: every row of a
 * replaced key, and each partitioned row whose pair was not settled at read.
 *
 * @param bundle - The write's rows
 * @param replaced - {@link keysToReplace}
 * @param settledAtRead - The pairs the caller's read settled
 * @returns The rows to insert, every blob-scoped table present
 */
function rowsToReplace(bundle: RowBundle, replaced: ReadonlySet<string>, settledAtRead: BlobFactsWrite['settledAtRead']): RowBundle {
  const settled = new Set(settledAtRead.map((pair) => pairId(pair.contentKey, pair.harness)));
  const replacing: RowBundle = {};
  for (const spec of allSpecs().filter((candidate) => candidate.scope === 'blob')) {
    const column = blobKeyColumn(spec);
    const partition = spec.partitionColumn;
    replacing[spec.key] = (bundle[spec.key] ?? []).filter((row) => {
      const key = String(row[column]);
      if (replaced.has(key)) return true;
      return partition !== undefined && !settled.has(pairId(key, String(row[partition])));
    });
  }
  return replacing;
}

/** One row set a write holds: its id, and its rows by table key, every table of its instance. */
interface HeldRowSet {
  readonly id: RowSetId;
  readonly rows: Record<string, Record<string, unknown>[]>;
}

/**
 * A row-set write's row sets, by id: the held ids are the head tables' (one head row per row set),
 * and every other row files under the held id its `(blob, variant)` and table's instance name.
 *
 * @param rows - The write's rows
 * @returns Each held row set, by its text, every table of its instance present
 * @throws TypeError When a table of an instance holding row sets is missing from the write, or a
 *   row belongs to a row set the write carries no head row of: either would be written partially
 */
function heldRowSets(rows: Partial<RowSetRows>): ReadonlyMap<RowSetIdText, HeldRowSet> {
  const source = rows as unknown as Partial<RowBundle>;
  const held = new Map<RowSetIdText, HeldRowSet>();
  for (const spec of rowSetSpecs().filter((candidate) => candidate.head)) {
    for (const row of source[spec.key] ?? []) {
      const id = rowSetIdOfRow(spec, row);
      held.set(rowSetIdText(id), { id, rows: {} });
    }
  }
  const instances = new Set([...held.values()].map((set) => set.id.instance));
  for (const spec of rowSetSpecs().filter((candidate) => instances.has(candidate.instance))) {
    fileTableRows(held, spec, source[spec.key]);
  }
  return held;
}

/**
 * File one table's rows of a row-set write under the held row sets they belong to.
 *
 * @param held - The held row sets, by text; each of the table's instance gets the table, empty or not
 * @param spec - The table
 * @param tableRows - The write's rows of it
 * @throws TypeError When the table is missing, or a row belongs to no held row set
 */
function fileTableRows(
  held: ReadonlyMap<RowSetIdText, HeldRowSet>,
  spec: RowSetTableEntry,
  tableRows: readonly Record<string, unknown>[] | undefined,
): void {
  if (tableRows === undefined) throw new TypeError(`A row-set write holding ${spec.instance} row sets carries no '${spec.key}' table`);
  for (const set of held.values()) if (set.id.instance === spec.instance) set.rows[spec.key] = [];
  for (const row of tableRows) {
    const set = held.get(rowSetIdText(rowSetIdOfRow(spec, row)));
    if (set === undefined) throw new TypeError(`A row-set write carries a '${spec.key}' row of a row set with no head row`);
    set.rows[spec.key]?.push(row);
  }
}

/**
 * The row set one row-set row belongs to: its `(blob, variant)` and its table's instance.
 *
 * @param spec - The row's table
 * @param row - The row
 * @returns Its row set's id
 * @throws TypeError When the row's `blob` is not a content key
 */
function rowSetIdOfRow(spec: RowSetTableEntry, row: Readonly<Record<string, unknown>>): RowSetId {
  const blob = row['blob'];
  const contentKey = typeof blob === 'string' ? parseContentKey(blob) : undefined;
  if (contentKey === undefined) throw new TypeError(`A '${spec.key}' row's blob is not a content key: ${String(blob)}`);
  return { contentKey, instance: spec.instance, variant: row['variant'] as RowSetId['variant'] };
}

/**
 * Write row sets: the row writer behind `FactStore.writeRowSets`, the row-set tier's twin of
 * {@link writeBlobRows}. Inside one `BEGIN IMMEDIATE` transaction:
 *
 * 1. every held row set not covered at read is replaced: its rows deleted from every table of its
 *    instance, the write's inserted, and its ledger row recorded with their `storedRowBytes`;
 * 2. every covered one is looked up in the ledger by primary key. One still there is re-stamped
 *    with its recorded bytes; one gone since the read is left absent, since the write carries
 *    only its head row and inserting that would store it partially;
 * 3. the tier is evicted past its budget, never a held row set ({@link evictPastBudget}).
 *
 * A write holding no row set writes nothing and counts nothing.
 *
 * @param tables - The connection's statements
 * @param write - The held rows and the ids covered at read
 * @returns The row sets it replaced, whose decoded rows the caller forgets
 */
function writeRowSetRows(tables: StoreTables, write: RowSetWrite): readonly RowSetIdText[] {
  const held = heldRowSets(write.rows);
  if (held.size === 0) return [];
  const covered = new Set(write.coveredAtRead.map((id) => rowSetIdText(id)));
  const replaced: RowSetIdText[] = [];
  let written = 0;
  let evicted = 0;
  inTransaction(tables.database, () => {
    const writtenAt = new Date().toISOString();
    for (const [text, set] of held) {
      if (covered.has(text)) continue;
      const inserted = replaceRowSet(tables, set);
      tables.recordRowSet.run(...rowSetKeyValues(set.id), writtenAt, inserted.bytes);
      written += inserted.rows;
      replaced.push(text);
    }
    // EVERY held row set still in the ledger, AFTER the rows and BEFORE the eviction, as
    // `writeBlobRows` re-stamps every held key: one left at its old place would be the next
    // write's victim while this one holds it.
    for (const [text, set] of held) {
      if (!covered.has(text)) continue;
      const key = rowSetKeyValues(set.id);
      if (tables.rowSetPresent.get(...key) !== undefined) tables.restampRowSet.run(...key, writtenAt, ...key);
    }
    evicted = evictPastBudget(tables.rowSetTier, [...held.values()].map((set) => rowSetKeyValues(set.id)), (victims) => {
      forgetRowSets(tables, victims);
    });
  });
  countWrite(written);
  // Outside the transaction, as `writeBlobRows`'s: SQLite refuses `incremental_vacuum` inside one.
  if (evicted > 0) tables.database.exec(INCREMENTAL_VACUUM_SQL);
  return replaced;
}

/**
 * Replace one row set's rows: delete them from every table of its instance, then insert the
 * write's, measuring each as it is bound.
 *
 * @param tables - The connection's statements
 * @param set - The row set
 * @returns How many rows it inserted, and their `storedRowBytes`
 */
function replaceRowSet(tables: StoreTables, set: HeldRowSet): { rows: number; bytes: number } {
  let rows = 0;
  let bytes = 0;
  for (const plan of rowSetPlansOf(tables, set.id.instance)) {
    plan.remove.run(set.id.contentKey, set.id.variant);
    for (const row of set.rows[plan.spec.key] ?? []) {
      const values = encodeRow(plan.columns, row);
      plan.insert.run(...values);
      bytes += storedRowBytes(values);
      rows += 1;
    }
  }
  return { rows, bytes };
}

/**
 * Delete some row sets' rows from every table of their instance, and their ledger rows: what an
 * eviction reclaims and {@link evictRowSetForTest} removes.
 *
 * @param tables - The connection's statements
 * @param keys - Each row set's ledger key, in {@link ROW_SET_KEY_COLUMNS} order
 */
function forgetRowSets(tables: StoreTables, keys: readonly (readonly string[])[]): void {
  for (const key of keys) {
    const fields = Object.fromEntries(ROW_SET_KEY_COLUMNS.map((column, index) => [column, key[index]]));
    for (const plan of rowSetPlansOf(tables, String(fields['instance']))) plan.remove.run(String(fields['contentKey']), String(fields['variant']));
    tables.forgetRowSet.run(...key);
  }
}

/**
 * The plans of one instance's row-set tables, in registry order.
 *
 * @param tables - The connection's statements
 * @param instance - The instance
 * @returns Its tables' plans
 */
function rowSetPlansOf(tables: StoreTables, instance: string): readonly RowSetPlan[] {
  return tables.rowSetPlans.filter((plan) => plan.spec.instance === instance);
}

/**
 * The decode-ledger entry of one row set.
 *
 * @param text - The row set's text
 * @returns Its entry name in {@link DecodeLedger.decoded}
 */
function rowSetLedgerEntry(text: RowSetIdText): string {
  return `rowSet\0${text}`;
}

/**
 * Read some row sets' requested tables and which of them the ledger holds: the row reader behind
 * `FactStore.readRowSets`. One read transaction: each id's presence is its ledger row, looked up
 * by primary key in the rows' snapshot, and only a present id's rows are read. The ids are read
 * once each, in {@link compareRowSetIds} order, each table's rows in primary-key order.
 *
 * @param tables - The connection's statements
 * @param ids - The row sets
 * @param request - Which tables to read
 * @param observed - Whether to record each decoded row's ledger slot
 * @returns The rows, the ids present, how many rows it decoded, and their decode-ledger slots
 */
function readRowSetRows<Table extends RowSetTableName>(
  tables: StoreTables,
  ids: readonly RowSetId[],
  request: RowSetRequest<Table>,
  observed: boolean,
): RowSetRead<Table> & { decoded: number; slots: readonly (readonly [entry: string, slot: string])[] } {
  const unique = new Map(ids.map((id) => [rowSetIdText(id), id] as const));
  const ordered = [...unique.values()].sort(compareRowSetIds);
  const requested = new Set<string>(request.tables);
  const plans = tables.rowSetPlans.filter((plan) => requested.has(plan.spec.key));
  const result: Record<string, Record<string, unknown>[]> = Object.fromEntries(plans.map((plan) => [plan.spec.key, []]));
  const present = new Set<RowSetIdText>();
  const slots: (readonly [entry: string, slot: string])[] = [];
  let decoded = 0;
  inReadTransaction(tables.database, () => {
    for (const id of ordered) {
      if (tables.rowSetPresent.get(...rowSetKeyValues(id)) === undefined) continue;
      const text = rowSetIdText(id);
      present.add(text);
      for (const plan of plans.filter((candidate) => candidate.spec.instance === id.instance)) {
        const raw = plan.select.all(id.contentKey, id.variant);
        decoded += raw.length;
        // One at a time, never spread: a spread of a large read overflows the stack.
        for (const row of decodeRows(plan, raw)) result[plan.spec.key]?.push(row);
        if (observed) appendAll(slots, raw.map(() => [rowSetLedgerEntry(text), plan.spec.key] as const));
      }
    }
  });
  return { rows: result as unknown as Pick<RowSetRows, Table>, present, decoded, slots };
}

/**
 * Write the extent of one tree: the row writer behind `FactStore.writeExtent`.
 * Additive at context granularity — see the port.
 *
 * @param tables - The connection's statements
 * @param key - Which root, which tree
 * @param rows - The extent-scoped tables; any of them may be empty
 */
function writeExtentRows(tables: StoreTables, key: ExtentKey, rows: ExtentScopedRows): void {
  const bundle = rows as unknown as Record<string, readonly Record<string, unknown>[]>;
  const keyValues = [key.rootId, key.treeHash];
  const contexts = contextsNamedBy(bundle, plansOfScope(tables, 'extent'));
  let evicted = 0;
  let written = 0;
  inTransaction(tables.database, () => {
    for (const plan of plansOfScope(tables, 'extent')) {
      clearSpaceFor(plan, bundle, keyValues, contexts);
    }
    written = insertBundle(tables, bundle, 'extent', keyValues);
    // Recorded on every write, including one that names no context at all:
    // the manifest row is the only thing separating "written and empty" from
    // "never written", and an additive write is still a write.
    const now = new Date().toISOString();
    tables.recordExtent.run(key.rootId, key.treeHash, now, now);
    // AFTER the manifest row, inside the same transaction. Before it, this
    // write's own tree would not yet be in the ordering and a retention of one
    // would evict the newest tree the store had — the one it is replacing.
    evicted = evictPastRetention(tables, key.rootId) + evictRootsPastRetention(tables);
  });
  countWrite(written);
  // Outside the transaction, because SQLite refuses `incremental_vacuum`
  // inside one, and only when something was actually freed — an ordinary
  // steady-state write evicts nothing and must pay nothing.
  if (evicted > 0) tables.database.exec(INCREMENTAL_VACUUM_SQL);
}

/**
 * Count one committed fact-store write and the rows it inserted — the store's
 * writes, which ADR I10 bounds.
 *
 * After the transaction, so a write that rolled back is not counted as work
 * the store holds.
 *
 * @param rows - How many rows the write inserted
 */
function countWrite(rows: number): void {
  countWork('store.writes.persistent', 1);
  countWork('store.rows.written.persistent', rows);
}

/**
 * Run a unit of work with every statement in it committed together, or none.
 *
 * @param database - The connection
 * @param work - The statements to run
 * @throws Whatever `work` throws, after rolling back
 */
export function inTransaction(database: DatabaseSync, work: () => void): void {
  // IMMEDIATE, not deferred: a deferred transaction takes its write lock at
  // the first write, so two writers can both start, both read, and one then
  // fail to upgrade. Taking the lock up front turns that into an ordinary
  // wait the busy handler absorbs.
  database.exec('BEGIN IMMEDIATE');
  try {
    work();
    database.exec('COMMIT');
  } catch (error) {
    failAfter(error, () => database.exec('ROLLBACK'));
  }
}

/**
 * Run a unit of reads against one snapshot.
 *
 * @param database - The connection
 * @param work - The statements to run
 * @returns What `work` returns
 * @throws Whatever `work` throws, after rolling back
 */
function inReadTransaction<T>(database: DatabaseSync, work: () => T): T {
  // Explicit, not autocommit. Reading nine tables in autocommit is **nine
  // read transactions**, so a writer committing between two of them yields
  // exactly the torn read this store promises cannot happen — half of one
  // tree and half of another, with no error. One `BEGIN DEFERRED` gives every
  // statement inside it the same snapshot.
  //
  // 🪤 It also settles a staleness question. A connection that only ever runs
  // autocommit reads was measured returning an *empty* store 200,000 times
  // while another process committed 500 transactions to it — no error, exit 0
  // on both sides. Beginning and ending the read transaction explicitly makes
  // each read pick up the newest committed snapshot.
  database.exec('BEGIN DEFERRED');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    failAfter(error, () => database.exec('ROLLBACK'));
  }
}

/**
 * Clear what one blob write replaces: every row of a replaced key, in every
 * table, partitioned ones included; and, of a key not replaced, only the pairs
 * the write carries rows for in a partitioned table, each measured before its
 * delete.
 *
 * @param tables - The connection's statements
 * @param replacing - {@link rowsToReplace}: the rows the write inserts
 * @param replaced - {@link keysToReplace}
 * @returns Per key not replaced, the bytes of the stored rows it deleted
 */
function clearSpaceForBlobs(
  tables: StoreTables,
  replacing: RowBundle,
  replaced: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  forgetBlobKeys(tables, [...replaced]);
  const pairs = partitionPairs(replacing).filter(([blob]) => !replaced.has(blob));
  const deleted = new Map<string, number>();
  for (const { spec } of plansOfScope(tables, 'blob')) {
    if (spec.partitionColumn === undefined) continue;
    const { select, remove } = partitionStatements(tables, spec);
    for (const [blob, partition] of pairs) {
      const stored = select.all(blob, partition) as Record<string, SqliteResultValue>[];
      deleted.set(blob, (deleted.get(blob) ?? 0) + sumOf(stored.map((row) => storedRowBytes(Object.values(row)))));
      remove.run(blob, partition);
    }
  }
  return deleted;
}

/**
 * Insert every row of a blob bundle, measuring each as it is bound.
 *
 * @param tables - The connection's statements
 * @param bundle - Table key to rows, blob-scoped tables only
 * @returns How many rows it inserted, and per content key their `storedRowBytes`
 */
function insertBlobBundle(tables: StoreTables, bundle: RowBundle): { rows: number; bytes: ReadonlyMap<string, number> } {
  let rows = 0;
  const bytes = new Map<string, number>();
  for (const plan of plansOfScope(tables, 'blob')) {
    const keyColumn = blobKeyColumn(plan.spec);
    for (const row of bundle[plan.spec.key] ?? []) {
      const key = String(row[keyColumn]);
      bytes.set(key, (bytes.get(key) ?? 0) + storedRowBytes(insertRow(plan, [], row)));
      rows += 1;
    }
  }
  return { rows, bytes };
}

/**
 * The sum of some numbers.
 *
 * @param values - The numbers
 * @returns Their sum; 0 for none
 */
function sumOf(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Delete every blob-scoped row for a set of content keys, in every blob-scoped table.
 *
 * The range a write clears before filling it, and the range an eviction
 * reclaims: they are the same operation over different keys, which is why
 * there is one of it. 🪤 The keys are the union every blob-scoped table names, never
 * `blobs` alone — see {@link uniqueContentKeys}.
 *
 * @param tables - The connection's statements
 * @param contentKeys - The keys to clear
 */
function forgetBlobKeys(tables: StoreTables, contentKeys: readonly string[]): void {
  for (const batch of batched(contentKeys)) {
    for (const { spec } of plansOfScope(tables, 'blob')) {
      blobStatement(tables, 'delete', spec, batch.length).run(...batch);
    }
  }
}

/**
 * Drop every content key past the blob tier's byte budget, rows and manifest
 * alike — see {@link tierPastBudgetSql} for which.
 *
 * Called from inside {@link writeBlobRows}'s transaction, so a key's rows and
 * its manifest row can never be observed apart — a manifest row with no rows
 * would make the budget count bytes the store no longer holds, and rows with no
 * manifest row would be unevictable for good.
 *
 * ⛔ The keys this write holds are never selected, every one of which it
 * re-stamped, replaced or not, and they are excluded by key, not by their place
 * in the order. A cut by bytes alone would take the write's OWN oldest keys
 * whenever one write held more bytes than the budget — and because the coverage
 * check is all-or-nothing, a tree that size would then miss on every run while
 * paying for every write. The surplus is reclaimed by the next, smaller write.
 *
 * @param tables - The connection's statements
 * @param held - The keys the calling write holds and re-stamped
 * @returns How many keys were evicted
 */
function evictBlobKeysPastBudget(tables: StoreTables, held: readonly string[]): number {
  return evictPastBudget(tables.blobTier, held.map((key) => [key]), (victims) => {
    const keys = victims.map(([key]) => String(key));
    forgetBlobKeys(tables, keys);
    for (const key of keys) tables.forgetBlobKey.run(key);
  });
}

/**
 * Drop the members of one tier past its budget: the one eviction routine, for the blob tier and
 * the row-set tier alike. The members the write holds are named by identity and never selected —
 * see {@link tierPastBudgetSql} — and `forget` deletes each victim's rows and ledger row, inside
 * the write's transaction.
 *
 * @param tier - The tier
 * @param held - The members the calling write holds, each as its identity tuple
 * @param forget - Deletes some members' rows and ledger rows
 * @returns How many members were evicted
 */
function evictPastBudget(
  tier: StoreTier,
  held: readonly (readonly string[])[],
  forget: (victims: readonly (readonly string[])[]) => void,
): number {
  const rows = tier.pastBudget.all(JSON.stringify(held), tier.budgetBytes) as Record<string, SqliteResultValue>[];
  const victims = rows.map((row) => tier.identity.map((column) => String(row[column])));
  if (victims.length > 0) forget(victims);
  return victims.length;
}

/**
 * Drop every tree of one root past the retention window, rows and all.
 *
 * Called from inside {@link writeExtentRows}'s transaction, so an eviction and
 * the write that caused it commit together or not at all — a store can never be
 * observed holding the manifest row of a tree whose rows are already gone,
 * which would read as a hit and return an empty extent.
 *
 * The manifest row is deleted **last** for each victim. It is what
 * {@link readExtentRows} consults to tell a written-and-empty extent from an
 * unwritten one, so removing it first would open a window — inside this
 * transaction only, but a window all the same for anything later added to it —
 * where the key reads as present with nothing under it.
 *
 * @param tables - The connection's statements
 * @param rootId - The root whose trees are being aged out
 * @returns How many trees were evicted
 */
function evictPastRetention(tables: StoreTables, rootId: string): number {
  return forgetTrees(tables, rootId, tables.extentsPastRetention.all(rootId, tables.retention.extentsPerRoot));
}

/**
 * Drop every tree of every root past the machine-wide root window.
 *
 * Same transaction and same manifest-last ordering as
 * {@link evictPastRetention}. The writing root cannot be selected: its manifest
 * row was just recorded, so it is the newest root.
 *
 * @param tables - The connection's statements
 * @returns How many trees were evicted
 */
function evictRootsPastRetention(tables: StoreTables): number {
  const roots = tables.rootsPastRetention.all(tables.retention.roots) as { storeRootId: string }[];
  let evicted = 0;
  for (const { storeRootId } of roots) {
    evicted += forgetTrees(tables, storeRootId, tables.extentsPastRetention.all(storeRootId, 0));
  }
  return evicted;
}

/**
 * Delete some of one root's trees, rows first and manifest row last.
 *
 * @param tables - The connection's statements
 * @param rootId - The root
 * @param victims - The trees to forget
 * @returns How many were forgotten
 */
function forgetTrees(tables: StoreTables, rootId: string, victims: readonly Record<string, unknown>[]): number {
  for (const victim of victims) {
    const treeHash = String(victim['storeTreeHash']);
    for (const plan of plansOfScope(tables, 'extent')) {
      plan.deleteExtent?.run(rootId, treeHash);
    }
    tables.forgetExtent.run(rootId, treeHash);
  }
  return victims.length;
}

/**
 * Empty exactly the space one table's incoming rows are about to occupy, and
 * nothing beyond it.
 *
 * Two different clearances, because the tables are two different kinds of
 * fact:
 *
 * - **A table with a context column** is cleared one context at a time, for
 *   every context the *bundle* names — not only the contexts this table's own
 *   rows name. A rewrite that produces no condition row still has to remove
 *   the condition row the previous write left, and a per-table context set
 *   would name no context for that table and so delete nothing. The bundle is
 *   one command's answer for a set of contexts; the unit being replaced is
 *   the context, across every table that carries one.
 * - **A table without one** (`roots`, `resources`, `resource_tags`) is merged:
 *   the single row each incoming row's primary key names is deleted, then the
 *   insert puts the same identity back. Two commands that both realize a file
 *   contribute the same row, so whichever writes last writes the same bytes.
 *
 * @param plan - The table being written
 * @param bundle - Table key to rows, as the caller handed them over
 * @param keyValues - The extent key, bound ahead of everything else
 * @param contexts - Every resolution context this write declares
 */
function clearSpaceFor(
  plan: TablePlan,
  bundle: Record<string, readonly Record<string, unknown>[]>,
  keyValues: readonly string[],
  contexts: ReadonlySet<string>,
): void {
  if (plan.deleteExtentContext !== undefined) {
    for (const context of contexts) {
      plan.deleteExtentContext.run(...keyValues, context);
    }
    return;
  }
  for (const row of bundle[plan.spec.key] ?? []) {
    // The bind order is `storedPrimaryKey`'s: the two extent key columns, then
    // the row's own key columns in registry order. `deleteRowByKeySql` emits
    // its predicate from the same function, so the two cannot drift.
    plan.deleteRow?.run(
      ...keyValues,
      ...(plan.keyColumns ?? []).map(([column, { kind }]) => encodeKeyValue(kind, row[column])),
    );
  }
}

/**
 * Insert every row of a bundle into the tables of one scope.
 *
 * @param tables - The connection's statements
 * @param bundle - Table key to rows
 * @param scope - Which tables to expect in the bundle
 * @param leadingValues - Values bound before the row's own columns — the
 *   extent key, or nothing
 * @returns How many rows it inserted
 */
function insertBundle(
  tables: StoreTables,
  bundle: Record<string, readonly Record<string, unknown>[]>,
  scope: 'blob' | 'extent',
  leadingValues: readonly string[],
): number {
  let inserted = 0;
  for (const plan of plansOfScope(tables, scope)) {
    for (const row of bundle[plan.spec.key] ?? []) {
      insertRow(plan, leadingValues, row);
      inserted += 1;
    }
  }
  return inserted;
}

/**
 * Insert one row into its table.
 *
 * @param plan - The table's plan
 * @param leadingValues - Values bound before the row's own columns
 * @param row - The row
 * @returns The row's own values as bound, encoded (the leading values excluded)
 */
function insertRow(plan: TablePlan, leadingValues: readonly string[], row: Readonly<Record<string, unknown>>): readonly SqliteValue[] {
  const values = encodeRow(plan.columns, row);
  plan.insert.run(...leadingValues, ...values);
  return values;
}

/**
 * The plans for one scope's tables, in registry order.
 *
 * @param tables - The connection's statements
 * @param scope - Which scope
 * @returns Their plans
 */
function plansOfScope(tables: StoreTables, scope: 'blob' | 'extent'): readonly TablePlan[] {
  return tables.plans.filter((plan) => plan.spec.scope === scope);
}

/**
 * A blob-fact statement, prepared once per `(table, placeholder count)`.
 *
 * These cannot be prepared up front because their arity is the batch size, but
 * they must still be reused — see {@link TablePlan} for the snapshot-pinning
 * this closes. The key space is tiny in practice: a full batch and at most one
 * remainder per table.
 *
 * @param tables - The connection's statements
 * @param verb - Which statement
 * @param spec - A blob-scoped table's registry entry
 * @param keyCount - How many content keys the statement binds
 * @returns The prepared statement
 */
function blobStatement(tables: StoreTables, verb: 'select' | 'delete', spec: StoredTableSpec, keyCount: number): StatementSync {
  return cachedStatement(
    tables,
    `${verb}:${spec.name}:${keyCount}`,
    () => (verb === 'select' ? selectBlobFactsSql(spec, keyCount) : deleteBlobFactsSql(spec, keyCount)),
  );
}

/**
 * The cached pair-scoped `SELECT` and `DELETE` for one partitioned blob table.
 *
 * @param tables - The connection's statements
 * @param spec - A blob-scoped table declaring `partitionColumn`
 * @returns The prepared statements: the pair's stored rows, and their delete
 */
function partitionStatements(tables: StoreTables, spec: StoredTableSpec): { select: StatementSync; remove: StatementSync } {
  return {
    select: cachedStatement(tables, `select-partition:${spec.name}`, () => selectBlobPartitionSql(spec)),
    remove: cachedStatement(tables, `delete-partition:${spec.name}`, () => deleteBlobPartitionSql(spec)),
  };
}

/**
 * A statement prepared once per connection under a cache key.
 *
 * @param tables - The connection's statements
 * @param cacheKey - What names the statement
 * @param sql - Its text, built only on the first ask
 * @returns The prepared statement
 */
function cachedStatement(tables: StoreTables, cacheKey: string, sql: () => string): StatementSync {
  const cached = tables.blobStatements.get(cacheKey);
  if (cached !== undefined) return cached;
  const statement = tables.database.prepare(sql());
  tables.blobStatements.set(cacheKey, statement);
  return statement;
}

/**
 * The table whose rows a {@link BlobRequest}'s `referenceForms` filters, and the
 * column it filters on. Typed against the row, so a renamed column stops this
 * compiling rather than silently reading every form.
 */
const REFERENCE_TABLE = 'blobReferences' satisfies BlobScopedTableName;
const REFERENCE_FORM_COLUMN = 'syntacticForm' satisfies keyof BlobReferenceRow;

/**
 * The `SELECT` for one table of one batch under a request, with the values it
 * binds after the keys: the request's forms on {@link REFERENCE_TABLE} when it
 * names a set, each encoded as its column's kind is ({@link encodeValue}, as a
 * write binds it), nothing otherwise.
 *
 * @param tables - The connection's statements
 * @param plan - A blob-scoped table's plan
 * @param keyCount - The batch's size
 * @param forms - The request's forms, sorted, or `'all'`
 * @returns The statement and its trailing values
 * @throws Error when {@link REFERENCE_TABLE}'s plan declares no {@link REFERENCE_FORM_COLUMN}
 */
function blobSelect(
  tables: StoreTables,
  plan: TablePlan,
  keyCount: number,
  forms: readonly string[] | 'all',
): { statement: StatementSync; values: readonly SqliteValue[] } {
  const { spec } = plan;
  if (spec.key !== REFERENCE_TABLE || forms === 'all') return { statement: blobStatement(tables, 'select', spec, keyCount), values: [] };
  const formColumn = plan.columns.find(([column]) => column === REFERENCE_FORM_COLUMN);
  if (formColumn === undefined) throw new Error(`${spec.name} declares no ${REFERENCE_FORM_COLUMN} column to filter reference forms on`);
  const statement = cachedStatement(
    tables,
    `select-forms:${spec.name}:${keyCount}:${forms.join(',')}`,
    () => selectBlobFactsWhereSql(spec, keyCount, REFERENCE_FORM_COLUMN, forms.length),
  );
  const [, { kind }] = formColumn;
  return { statement, values: forms.map((form) => encodeKeyValue(kind, form)) };
}

/**
 * Which keys the blob ledger ({@link BLOB_KEYS_TABLE}) tracks: a read's
 * presence, which decodes no row and so counts as none. Run inside the read's
 * transaction, so it answers for the same snapshot as the rows.
 *
 * @param tables - The connection's statements
 * @param contentKeys - Distinct keys
 * @returns The keys the ledger holds: the requested keys themselves, never parsed back from the stored text
 */
function ledgerTracked(tables: StoreTables, contentKeys: readonly ContentKey[]): Set<ContentKey> {
  const present = new Set<ContentKey>();
  for (const batch of batched(contentKeys)) {
    const tracked = new Set(cachedStatement(tables, `present:${batch.length}`, () => selectBlobKeysPresentSql(batch.length))
      .all(...batch)
      .map((row) => String((row as Record<string, SqliteResultValue>)[BLOB_KEY_COLUMN])));
    for (const key of batch) if (tracked.has(key)) present.add(key);
  }
  return present;
}

/**
 * Read back the facts held for a set of content keys — see
 * `FactStore.readBlobFacts`. Reads only the requested tables, and of
 * `blobReferences` only the requested forms: a row not asked for is never
 * decoded, so it is not counted in `decoded`. Which keys are present is read
 * from the ledger ({@link BLOB_KEYS_TABLE}) in the same transaction, and is not
 * a decoded row.
 *
 * @param tables - The connection's statements
 * @param contentKeys - The keys to look up
 * @param request - Which tables and reference forms to read
 * @returns The rows, the keys the ledger holds, and how many stored rows were decoded
 */
function readBlobRows<Table extends BlobScopedTableName>(
  tables: StoreTables,
  contentKeys: readonly ContentKey[],
  request: BlobRequest<Table>,
  observed: boolean,
): BlobFactsRead<Table> & { decoded: number; slots: (readonly [entry: string, slot: string])[] } {
  const requested = new Set<string>(request.tables);
  const plans = plansOfScope(tables, 'blob').filter((plan) => requested.has(plan.spec.key));
  const forms = request.referenceForms === 'all' ? 'all' : [...request.referenceForms].sort(compareCodeUnits);
  let decoded = 0;
  const slots: (readonly [entry: string, slot: string])[] = [];
  let present: ReadonlySet<ContentKey> = new Set();
  const rows = inReadTransaction(tables.database, () => {
    present = ledgerTracked(tables, contentKeys);
    const result: Record<string, unknown[]> = {};
    for (const { spec } of plans) {
      result[spec.key] = [];
    }
    for (const batch of batched(contentKeys)) {
      for (const plan of plans) {
        // No form asked for: an `IN ()` cannot parse, and the answer is no rows.
        if (plan.spec.key === REFERENCE_TABLE && forms !== 'all' && forms.length === 0) continue;
        const { statement, values } = blobSelect(tables, plan, batch.length, forms);
        const raw = statement.all(...batch, ...values);
        decoded += raw.length;
        if (observed) appendAll(slots, blobSlots(plan, raw));
        const into = result[plan.spec.key];
        if (into !== undefined) appendAll(into, decodeRows(plan, raw));
      }
    }
    return result as unknown as Pick<BlobScopedRows, Table>;
  });
  return { rows, present, decoded, slots };
}

/**
 * Each decoded blob row's ledger slot: its key's entry, and its table (with its form for a
 * reference row).
 *
 * @param plan - The table the rows came from
 * @param raw - What SQLite returned
 * @returns One `[entry, slot]` per row
 */
function blobSlots(plan: TablePlan, raw: readonly unknown[]): (readonly [entry: string, slot: string])[] {
  const keyColumn = blobKeyColumn(plan.spec);
  const byForm = plan.spec.key === REFERENCE_TABLE;
  return raw.map((stored) => {
    const source = stored as Record<string, SqliteResultValue>;
    const slot = byForm ? `${plan.spec.key}\0${String(source[REFERENCE_FORM_COLUMN])}` : plan.spec.key;
    return [blobLedgerEntry(String(source[keyColumn])), slot] as const;
  });
}

/**
 * Read back the requested tables stored under one tree — see
 * `FactStore.readExtent`. A table not requested is never selected, so its rows
 * are not counted in `decoded`.
 *
 * @param tables - The connection's statements
 * @param key - Which root, which tree
 * @param request - Which tables to read
 * @returns The rows or `undefined` for a tree never written, and how many stored rows were decoded
 */
function readExtentRows<Table extends ExtentScopedTableName>(
  tables: StoreTables,
  key: ExtentKey,
  request: ExtentRequest<Table>,
  observed: boolean,
): { rows: Pick<ExtentScopedRows, Table> | undefined; decoded: number; slots: (readonly [entry: string, slot: string])[] } {
  const requested = new Set<string>(request.tables);
  const plans = plansOfScope(tables, 'extent').filter((plan) => requested.has(plan.spec.key));
  const entry = extentLedgerEntry(key);
  let decoded = 0;
  const slots: (readonly [entry: string, slot: string])[] = [];
  const rows = inReadTransaction(tables.database, () => {
    // An extent that was written but holds nothing is a hit with empty tables;
    // one that was never written is a miss. The manifest row is what tells
    // them apart, since both produce zero rows from every table — and it is
    // read inside the same snapshot as the tables, so a hit cannot be
    // followed by rows from a different write.
    if (tables.extentPresent.get(key.rootId, key.treeHash) === undefined) return undefined;

    const result: Record<string, unknown[]> = {};
    for (const plan of plans) {
      const raw = plan.selectExtent?.all(key.rootId, key.treeHash) ?? [];
      decoded += raw.length;
      // One slot per decoded row; pushed one at a time, since a spread of a large read overflows the stack.
      if (observed) for (const slot of Array.from(raw, () => [entry, plan.spec.key] as const)) slots.push(slot);
      result[plan.spec.key] = [...decodeRows(plan, raw)];
    }
    return result as unknown as Pick<ExtentScopedRows, Table>;
  });
  return { rows, decoded, slots };
}

/** A {@link SqliteFactStore}'s statements, for {@link evictRowSetForTest}; set by the class's static block. */
let tablesOfStore: (store: SqliteFactStore) => StoreTables;

/**
 * Evict one row set from a SQLite fact store, as the row-set budget would: its rows in every table
 * of its instance and its ledger row, in one transaction. A test seam, deliberately not a
 * {@link FactStore} member: no run evicts by hand, and a port member would oblige every backend.
 *
 * @param store - A store {@link openSqliteFactStore} opened
 * @param id - The row set
 * @throws TypeError When `store` is not a SQLite fact store
 * @throws Error When the store has been closed
 */
export function evictRowSetForTest(store: FactStore, id: RowSetId): void {
  if (!(store instanceof SqliteFactStore)) throw new TypeError('evictRowSetForTest evicts from a SQLite fact store only');
  const tables = tablesOfStore(store);
  inTransaction(tables.database, () => {
    forgetRowSets(tables, [rowSetKeyValues(id)]);
  });
}

/**
 * The {@link FactStore} port over one file-backed SQLite connection.
 *
 * It holds the port's operations and nothing else: no SQL and no derived
 * relation. SQL runs on the run database, a separate handle filled from a
 * projection (see `run-database.ts`), so a lens's rows can never reach this
 * database — one per VAT release, shared by every root on the machine.
 */
export class SqliteFactStore implements FactStore {
  readonly #tables: StoreTables;
  readonly #ledger: DecodeLedger;
  readonly #file: { readonly path: string; readonly busyTimeoutMs: number };
  #closed = false;

  /**
   * @param tables - The prepared statements of an open, configured connection
   * @param ledger - What this process has decoded from the connection's file
   * @param file - The connection's database file, and how long it waits on another writer
   */
  constructor(tables: StoreTables, ledger: DecodeLedger, file: { readonly path: string; readonly busyTimeoutMs: number }) {
    this.#tables = tables;
    this.#ledger = ledger;
    this.#file = file;
  }

  /** @inheritdoc */
  writeBlobFacts(write: BlobFactsWrite): Promise<void> {
    return promised(() => {
      this.#assertOpen();
      // Only a key whose stored rows changed leaves the ledger; a re-stamped key keeps its rows.
      for (const key of writeBlobRows(this.#tables, write)) this.#ledger.decoded.delete(blobLedgerEntry(key));
    });
  }

  /** @inheritdoc */
  readBlobFacts<Table extends BlobScopedTableName>(
    contentKeys: readonly ContentKey[],
    request: BlobRequest<Table>,
  ): Promise<BlobFactsRead<Table>> {
    return promised(() => {
      this.#assertOpen();
      const keys = [...new Set(contentKeys)];
      const observed = workCountsObserved();
      const { rows, present, decoded, slots } = readBlobRows(this.#tables, keys, request, observed);
      // Asking for no keys reads nothing.
      if (keys.length > 0) countRead('store.reads.blob', decoded, observed ? recordDecoded(this.#ledger, slots) : 0);
      return { rows, present };
    });
  }

  /** @inheritdoc */
  writeRowSets(write: RowSetWrite): Promise<void> {
    return promised(() => {
      this.#assertOpen();
      // Only a replaced row set's stored rows changed; a re-stamped one keeps its rows.
      for (const text of writeRowSetRows(this.#tables, write)) this.#ledger.decoded.delete(rowSetLedgerEntry(text));
    });
  }

  /** @inheritdoc */
  readRowSets<Table extends RowSetTableName>(ids: readonly RowSetId[], request: RowSetRequest<Table>): Promise<RowSetRead<Table>> {
    return promised(() => {
      this.#assertOpen();
      const observed = workCountsObserved();
      const { rows, present, decoded, slots } = readRowSetRows(this.#tables, ids, request, observed);
      countWork('rowSet.rows.decoded', decoded);
      countWork('store.rows.decoded.repeated', observed ? recordDecoded(this.#ledger, slots) : 0);
      return { rows, present };
    });
  }

  static {
    tablesOfStore = (store) => {
      store.#assertOpen();
      return store.#tables;
    };
  }

  /** @inheritdoc */
  writeExtent(key: ExtentKey, rows: ExtentScopedRows): Promise<void> {
    return promised(() => {
      this.#assertOpen();
      writeExtentRows(this.#tables, key, rows);
      // Every write rewrites the rows of each context it names, in every extent table.
      this.#ledger.decoded.delete(extentLedgerEntry(key));
    });
  }

  /** @inheritdoc */
  readExtent<Table extends ExtentScopedTableName>(
    key: ExtentKey,
    request: ExtentRequest<Table>,
  ): Promise<Pick<ExtentScopedRows, Table> | undefined> {
    return promised(() => {
      this.#assertOpen();
      const observed = workCountsObserved();
      const { rows, decoded, slots } = readExtentRows(this.#tables, key, request, observed);
      // A miss included: the manifest was read.
      countRead('store.reads.extent', decoded, observed ? recordDecoded(this.#ledger, slots) : 0);
      // A served read is a use; a miss has no row to stamp.
      if (rows !== undefined) recordExtentUseBestEffort(this.#tables, key, this.#file.busyTimeoutMs);
      return rows;
    });
  }

  /** @inheritdoc */
  close(): Promise<void> {
    return promised(() => {
      if (this.#closed) return;
      this.#closed = true;
      releaseDecodeLedger(this.#ledger);
      try {
        checkpointBestEffort(this.#tables.database);
      } finally {
        this.#tables.database.close();
      }
    });
  }

  /**
   * Attach this store's file to `target` READ-ONLY under `schema`, run `work`, and detach it before
   * returning, success or not: the one way another connection reads the store's rows inside SQLite.
   * It waits on another writer as this store's own connection does.
   *
   * A detach failing after `work` failed never masks `work`'s error; after a success it is thrown.
   *
   * @param target - Another connection, outside any transaction (`ATTACH` cannot run inside one)
   * @param schema - The name the store is attached under while `work` runs
   * @param work - What reads the attached store
   * @returns What `work` returns
   * @throws Error When the store has been closed
   */
  attachedTo<T>(target: StoreAttachTarget, schema: string, work: () => T): T {
    this.#assertOpen();
    target.exec(`PRAGMA busy_timeout = ${String(this.#file.busyTimeoutMs)}`);
    target.prepare(`ATTACH DATABASE ? AS ${quoteIdentifier(schema)}`).run(readOnlyDatabaseUri(this.#file.path));
    const detach = (): void => {
      target.exec(`DETACH DATABASE ${quoteIdentifier(schema)}`);
    };
    let result: T;
    try {
      result = work();
    } catch (error) {
      failAfter(error, detach);
    }
    detach();
    return result;
  }

  /**
   * @throws Error When the store has been closed
   */
  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('This projection store is closed');
    }
  }
}

/**
 * Run `cleanup` after `error`, then throw `error`, even when `cleanup` fails too.
 *
 * @param error - What failed
 * @param cleanup - What must still run
 * @throws `error`, always
 */
export function failAfter(error: unknown, cleanup: () => void): never {
  try {
    cleanup();
  } catch {
    throw error;
  }
  throw error;
}

/**
 * Count one completed read, against the port read it was (`store.reads.blob`
 * for `readBlobFacts`, `store.reads.extent` for `readExtent`), every row it
 * decoded, and of those the rows an earlier read on the same file had decoded
 * (`store.rows.decoded.repeated`, {@link DecodeLedger}).
 *
 * After the transaction, so a read that failed counts nothing, not even the
 * rows it decoded from the tables it reached first. Hydration is a counted
 * cost (ADR I10), and a row decoded outside the answer is exactly what the
 * decoded counter exposes.
 *
 * @param read - Which port read completed
 * @param decoded - How many stored rows the read decoded
 * @param repeated - How many of them this process had decoded before
 */
function countRead(read: 'store.reads.blob' | 'store.reads.extent', decoded: number, repeated: number): void {
  countWork(read, 1);
  countWork('store.rows.decoded.persistent', decoded);
  countWork('store.rows.decoded.repeated', repeated);
}

/**
 * Every resolution context a write declares, read off the rows themselves.
 *
 * The union across all five context-carrying tables, not a set per table: the
 * five are five views of one context, and `extentId` and `contextId` are two
 * spellings of the same relation. A context named by any of them is a context
 * this write is answering for, so it is cleared in all of them — see the store's
 * `#clearSpaceFor` on the stale row a per-table set would strand.
 *
 * Nothing else names the contexts. There is no parameter for them and no
 * manifest of them, deliberately: a caller stating a context list that its rows
 * disagreed with could delete a context it never wrote, which is the failure
 * this design removes rather than relocates.
 *
 * @param bundle - Table key to rows, as the caller handed them over
 * @param plans - The extent-scoped tables' plans
 * @returns The context ids, deduplicated
 */
function contextsNamedBy(
  bundle: Record<string, readonly Record<string, unknown>[]>,
  plans: readonly TablePlan[],
): ReadonlySet<string> {
  const contexts = new Set<string>();
  for (const { spec } of plans) {
    const column = spec.contextColumn;
    if (column === undefined) continue;
    for (const row of bundle[spec.key] ?? []) {
      contexts.add(String(row[column]));
    }
  }
  return contexts;
}

/**
 * A table's own key columns paired with what they hold, in comparison order.
 *
 * The extent key columns are *not* included: they are two plain strings the
 * caller already holds, and `projectionColumnTypes` only knows about columns the
 * row schema declares.
 *
 * @param spec - An extent-scoped table's registry entry
 * @returns Each key column with its type, in `primaryKey` order
 * @throws TypeError When a table keys on a column its row schema does not
 *   declare — which would otherwise bind `undefined` as SQL NULL and delete
 *   nothing, silently, forever
 */
function keyColumnTypes(spec: StoredTableSpec): readonly (readonly [string, ProjectionColumnType])[] {
  const types = new Map(projectionColumnTypes(spec));
  return spec.primaryKey.map((column) => {
    const type = types.get(column);
    if (type === undefined) {
      throw new TypeError(`Table "${spec.name}" keys on "${column}", which its row schema does not declare`);
    }
    return [column, type] as const;
  });
}

/**
 * Turn stored rows back into projection rows. The read that called it counts
 * them, once it completes.
 *
 * @param plan - The table the rows came from, with its column kinds
 * @param raw - What SQLite returned
 * @returns The decoded rows
 */
function decodeRows(plan: { readonly columns: RowColumns }, raw: readonly unknown[]): readonly Record<string, unknown>[] {
  return raw.map((stored) => decodeRow(plan.columns, stored as Record<string, SqliteResultValue>));
}

/**
 * Every content key a bundle names **anywhere**, across every blob-scoped
 * table, deduplicated.
 *
 * ## 🪤 Why the union, and not the `blobs` table alone
 *
 * A key can legitimately appear in a child table with **no `blobs` row of its
 * own**, and this is not an edge case: `blob-population.ts` records a
 * `BLOB_NOT_TEXT`, `BLOB_UNREADABLE` or `BLOB_CONTENT_CHANGED` condition
 * *instead of* a `blobs` row whenever it declines to parse a blob, and two of
 * those three could not carry a `blobs` row at any price — there are no
 * trustworthy bytes to measure. {@link FactStore.readBlobFacts} states the
 * rule directly: *a key is held when it has a `blobs` row **or** a
 * `blobConditions` row, and neither table alone answers the question.*
 *
 * This function used to read `blobs` alone, and a guard beside it (
 * `assertNoOrphanFacts`) then **rejected the whole bundle** whenever a child row
 * named a key `blobs` did not — so a single `.so`, `.pyc`, image or archive
 * anywhere under a root made every `writeBlobFacts` throw. Measured on a real
 * adopter plugin inside a large monorepo: 31 declined blobs against 8,076
 * parsed ones, enough to leave the store at its empty schema with **zero rows
 * in every table** where it now holds 193,021 — while the command
 * exited 0 throughout and a warm run stayed a full cold re-derivation.
 *
 * The concern that guard was defending is real and is what the union answers:
 * the write replaces the facts for exactly the keys it clears, so a row landing
 * outside that range would accumulate one copy per write, silently — and
 * `blob_conditions` keys on a nullable `line`, which SQLite's unique index
 * treats as distinct, so no conflict clause would catch it. Taking the range
 * from every table makes "every row written lands in a cleared range" true by
 * construction rather than by assertion, which is why the assertion is gone
 * rather than loosened.
 *
 * @param bundle - A blob-scoped row bundle
 * @returns The content keys, in first-seen order, `blobs` first
 */
function uniqueContentKeys(bundle: Record<string, readonly Record<string, unknown>[]>): readonly string[] {
  const keys = new Set<string>();
  for (const spec of allSpecs().filter((candidate) => candidate.scope === 'blob')) {
    const column = blobKeyColumn(spec);
    for (const row of bundle[spec.key] ?? []) keys.add(String(row[column]));
  }
  return [...keys];
}

/**
 * Every `(blob, partition)` pair a write's partitioned tables carry rows for —
 * the union across them, so a pair whose facts row arrived without import rows
 * still clears the stale import rows of that pair.
 *
 * @param bundle - Table key to rows, as the caller handed them over
 * @returns The pairs, deduplicated
 */
function partitionPairs(bundle: Record<string, readonly Record<string, unknown>[]>): readonly (readonly [string, string])[] {
  const pairs = new Map<string, readonly [string, string]>();
  for (const spec of allSpecs()) {
    const partition = spec.partitionColumn;
    if (spec.scope !== 'blob' || partition === undefined) continue;
    const column = blobKeyColumn(spec);
    for (const row of bundle[spec.key] ?? []) {
      const pair = [String(row[column]), String(row[partition])] as const;
      pairs.set(pairId(...pair), pair);
    }
  }
  return [...pairs.values()];
}

/**
 * One comparable string per `(blob, partition)` pair.
 *
 * @param blob - The content key
 * @param partition - The partition value (the harness)
 * @returns A string equal exactly when the pairs are
 */
function pairId(blob: string, partition: string): string {
  return `${blob}\0${partition}`;
}

/**
 * Split a key list into batches small enough for one `IN (…)`.
 *
 * @param keys - The keys
 * @yields Batches of at most {@link KEY_BATCH_SIZE}; nothing at all when empty
 */
function* batched<Key extends string>(keys: readonly Key[]): Generator<readonly Key[]> {
  for (let start = 0; start < keys.length; start += KEY_BATCH_SIZE) {
    yield keys.slice(start, start + KEY_BATCH_SIZE);
  }
}