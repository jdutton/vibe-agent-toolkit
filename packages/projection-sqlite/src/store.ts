/**
 * The `ProjectionStore` implemented on Node's built-in `node:sqlite`, in WAL
 * mode.
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
 * `writeBlobFacts` deletes the four tables' rows for the content keys it is
 * about to write and inserts those. Replace rather than insert-if-absent for a
 * specific reason — see `schema-sql.ts` on SQLite's treatment of NULL in a
 * primary key, which makes a conflict clause unable to dedup three of the twelve
 * tables. 🪤 The keys it clears are the union of what **all four** tables name,
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
 * ## Eviction: the newest few trees per root, pruned by the write that grew it
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
 * So {@link SqliteProjectionStore.writeExtent} keeps the
 * {@link SqliteStoreOptions.retainedExtentsPerRoot} most recently written trees
 * of the root it is writing and drops the rest, **inside its own transaction**.
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
 *   the most recently written one, so recency ordering cannot select it. This is
 *   what keeps `vat build`'s second phase able to read what its first phase
 *   wrote, with no pin, no lease and no lock.
 * - **It cannot tear a concurrent read.** Reads run under `BEGIN DEFERRED` (see
 *   {@link SqliteProjectionStore} on why autocommit reads go stale), and in WAL
 *   a reader stays on the snapshot it opened with. A delete committed by another
 *   process becomes visible to that reader only after it ends its transaction.
 *
 * Retention is **per root**, never global: two projects share one cache
 * namespace, and an age ordering across the whole manifest would let a busy
 * repository evict a quiet one's only extent.
 *
 * ## What eviction deliberately does NOT reclaim
 *
 * **Blob-scoped rows.** They are a pure function of bytes, shared by every tree
 * and every root that contains those bytes, so they cannot be attributed to the
 * extent being evicted without scanning every surviving extent's realizations —
 * and a scan that ran between another process's `writeBlobFacts` and its
 * `writeExtent` would collect rows that are about to be referenced. They also do
 * not exhibit the defect being fixed: an edit changes one file's content key, so
 * the blob tier grows by one file's rows where the extent tier grows by a whole
 * corpus. That tier is still bounded only by the namespace rotation, which is
 * stated here rather than left for someone to discover.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';

import {
  type BlobScopedRows,
  type ExtentKey,
  type ExtentScopedRows,
  type ProjectionColumnType,
  type ProjectionStore,
  projectionColumnTypes,
  projectionShapeDigest,
  vatCacheNamespaceRoot,
} from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';

import {
  CREATE_EXTENTS_TABLE_SQL,
  EXTENTS_TABLE,
  WRITTEN_AT_COLUMN,
  type StoredTableSpec,
  allSpecs,
  blobKeyColumn,
  createTableSql,
  deleteBlobFactsSql,
  deleteExtentContextSql,
  deleteExtentSql,
  deleteRowByKeySql,
  insertSql,
  selectBlobFactsSql,
  selectExtentSql,
} from './schema-sql.js';
import { decodeValue, encodeValue, type SqliteResultValue } from './values.js';

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
   * How many of a root's most recently written trees survive a write.
   *
   * Defaults to {@link DEFAULT_RETAINED_EXTENTS_PER_ROOT}. Clamped to at least
   * one: a retention of zero would delete the extent the caller is writing the
   * moment it committed, which is a cache that cannot hit rather than a cache
   * that holds nothing.
   */
  readonly retainedExtentsPerRoot?: number;
}

/**
 * Where a projection store lives when the caller does not say.
 *
 * Under the VAT cache namespace — which already separates one release's cache
 * from another's — and then under the projection's own **shape digest**, so a
 * change to the row schemas lands in a different file rather than being read
 * back as rows this build would misinterpret. No version, no migration: the old
 * directory simply goes cold and the tmpdir purge reclaims it.
 *
 * @returns Absolute path, forward-slashed
 */
export function defaultStoreDirectory(): string {
  return safePath.join(vatCacheNamespaceRoot(), `projection-${projectionShapeDigest()}`);
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
  readonly columns: readonly (readonly [column: string, type: ProjectionColumnType])[];
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
 * Open a SQLite-backed projection store.
 *
 * The directory is created if absent, the schema is created if absent, and the
 * connection is configured before either — see this module's note on pragma
 * ordering.
 *
 * @param options - Where to put it and how patient to be
 * @returns An open store; close it when done
 *
 * @example
 * const store = openSqliteProjectionStore();
 * const { blobs, extent } = splitProjectionByScope(projection);
 * await store.writeBlobFacts(blobs);
 * await store.writeExtent({ rootId, treeHash }, extent);
 * await store.close();
 */
export function openSqliteProjectionStore(options: SqliteStoreOptions = {}): ProjectionStore {
  const directory = options.directory ?? defaultStoreDirectory();
  // 0o700: this cache holds link text, heading text and frontmatter source from
  // a corpus that may be private. The mode is a POSIX mechanism — on Windows it
  // only toggles the read-only bit — so it narrows exposure rather than
  // eliminating it.
  mkdirSyncReal(directory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(safePath.join(directory, DATABASE_FILENAME));
  configure(database, options.busyTimeoutMs ?? BUSY_TIMEOUT_MS);
  createSchema(database);
  return new SqliteProjectionStore(
    database,
    Math.max(1, Math.trunc(options.retainedExtentsPerRoot ?? DEFAULT_RETAINED_EXTENTS_PER_ROOT)),
  );
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
        throw new Error(`Could not put the projection store into WAL mode: ${String(error)}`);
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
  database.exec(CREATE_EXTENTS_TABLE_SQL);
  for (const spec of allSpecs()) {
    database.exec(createTableSql(spec));
  }
}

/** The `ProjectionStore` contract over one SQLite connection. */
class SqliteProjectionStore implements ProjectionStore {
  readonly #database: DatabaseSync;
  readonly #plans: readonly TablePlan[];
  readonly #recordExtent: StatementSync;
  readonly #extentPresent: StatementSync;
  /** Eviction's two statements: which trees are past the window, and how to forget one. */
  readonly #extentsPastRetention: StatementSync;
  readonly #forgetExtent: StatementSync;
  readonly #retainedExtentsPerRoot: number;
  /** Blob-fact statements memoized by table and placeholder count — see {@link TablePlan}. */
  readonly #blobStatements = new Map<string, StatementSync>();
  #closed = false;

  /**
   * @param database - An open, configured connection whose schema exists
   * @param retainedExtentsPerRoot - How many of a root's newest trees survive a
   *   write. Already clamped to at least one by {@link openSqliteProjectionStore}
   */
  constructor(database: DatabaseSync, retainedExtentsPerRoot: number) {
    this.#database = database;
    this.#retainedExtentsPerRoot = retainedExtentsPerRoot;
    this.#plans = allSpecs().map((spec) => ({
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
    }));
    this.#recordExtent = database.prepare(
      `INSERT OR REPLACE INTO "${EXTENTS_TABLE}" ("storeRootId", "storeTreeHash", "${WRITTEN_AT_COLUMN}") VALUES (?, ?, ?)`,
    );
    this.#extentPresent = database.prepare(
      `SELECT 1 FROM "${EXTENTS_TABLE}" WHERE "storeRootId" = ? AND "storeTreeHash" = ?`,
    );
    // `LIMIT -1 OFFSET ?` is SQLite's spelling of "everything past the first N".
    // The `rowid` tie-break is load-bearing: `writtenAt` is an ISO-8601 string
    // with millisecond resolution, and two writes inside one millisecond are
    // ordinary, so ordering by it alone leaves the victim unspecified.
    this.#extentsPastRetention = database.prepare(
      `SELECT "storeTreeHash" FROM "${EXTENTS_TABLE}" WHERE "storeRootId" = ?`
      + ` ORDER BY "${WRITTEN_AT_COLUMN}" DESC, "rowid" DESC LIMIT -1 OFFSET ?`,
    );
    this.#forgetExtent = database.prepare(
      `DELETE FROM "${EXTENTS_TABLE}" WHERE "storeRootId" = ? AND "storeTreeHash" = ?`,
    );
  }

  /**
   * @inheritdoc
   *
   * The range this write clears is the union of the content keys **all four**
   * tables name, not the keys `blobs` alone names — see
   * {@link uniqueContentKeys} for why the difference is the whole feature.
   */
  async writeBlobFacts(rows: BlobScopedRows): Promise<void> {
    this.#assertOpen();
    const bundle = rows as unknown as Record<string, readonly Record<string, unknown>[]>;
    const contentKeys = uniqueContentKeys(bundle);
    if (contentKeys.length === 0) return;

    this.#transaction(() => {
      for (const batch of batched(contentKeys)) {
        for (const { spec } of this.#plansOfScope('blob')) {
          this.#blobStatement('delete', spec, batch.length).run(...batch);
        }
      }
      this.#insertBundle(bundle, 'blob', []);
    });
  }

  /** @inheritdoc */
  async readBlobFacts(contentKeys: readonly string[]): Promise<BlobScopedRows> {
    this.#assertOpen();
    return this.#readTransaction(() => {
      const result: Record<string, unknown[]> = {};
      for (const { spec } of this.#plansOfScope('blob')) {
        result[spec.key] = [];
      }
      for (const batch of batched([...new Set(contentKeys)])) {
        for (const plan of this.#plansOfScope('blob')) {
          const raw = this.#blobStatement('select', plan.spec, batch.length).all(...batch);
          result[plan.spec.key]?.push(...decodeRows(plan, raw));
        }
      }
      return result as unknown as BlobScopedRows;
    });
  }

  /** @inheritdoc */
  async writeExtent(key: ExtentKey, rows: ExtentScopedRows): Promise<void> {
    this.#assertOpen();
    const bundle = rows as unknown as Record<string, readonly Record<string, unknown>[]>;
    const keyValues = [key.rootId, key.treeHash];
    const contexts = contextsNamedBy(bundle, this.#plansOfScope('extent'));
    let evicted = 0;
    this.#transaction(() => {
      for (const plan of this.#plansOfScope('extent')) {
        this.#clearSpaceFor(plan, bundle, keyValues, contexts);
      }
      this.#insertBundle(bundle, 'extent', keyValues);
      // Recorded on every write, including one that names no context at all:
      // the manifest row is the only thing separating "written and empty" from
      // "never written", and an additive write is still a write.
      this.#recordExtent.run(key.rootId, key.treeHash, new Date().toISOString());
      // AFTER the manifest row, inside the same transaction. Before it, this
      // write's own tree would not yet be in the ordering and a retention of one
      // would evict the newest tree the store had — the one it is replacing.
      evicted = this.#evictPastRetention(key.rootId);
    });
    // Outside the transaction, because SQLite refuses `incremental_vacuum`
    // inside one, and only when something was actually freed — an ordinary
    // steady-state write evicts nothing and must pay nothing.
    if (evicted > 0) this.#database.exec('PRAGMA incremental_vacuum');
  }

  /** @inheritdoc */
  async readExtent(key: ExtentKey): Promise<ExtentScopedRows | undefined> {
    this.#assertOpen();
    return this.#readTransaction(() => {
      // An extent that was written but holds nothing is a hit with empty tables;
      // one that was never written is a miss. The manifest row is what tells
      // them apart, since both produce zero rows from every table — and it is
      // read inside the same snapshot as the tables, so a hit cannot be
      // followed by rows from a different write.
      if (this.#extentPresent.get(key.rootId, key.treeHash) === undefined) return undefined;

      const result: Record<string, unknown[]> = {};
      for (const plan of this.#plansOfScope('extent')) {
        const raw = plan.selectExtent?.all(key.rootId, key.treeHash) ?? [];
        result[plan.spec.key] = [...decodeRows(plan, raw)];
      }
      return result as unknown as ExtentScopedRows;
    });
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  /**
   * Run a unit of work with every statement in it committed together, or none.
   *
   * @param work - The statements to run
   * @throws Whatever `work` throws, after rolling back
   */
  #readTransaction<T>(work: () => T): T {
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
    this.#database.exec('BEGIN DEFERRED');
    try {
      const result = work();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Run a unit of work with every statement in it committed together, or none.
   *
   * @param work - The statements to run
   * @throws Whatever `work` throws, after rolling back
   */
  #transaction(work: () => void): void {
    // IMMEDIATE, not deferred: a deferred transaction takes its write lock at
    // the first write, so two writers can both start, both read, and one then
    // fail to upgrade. Taking the lock up front turns that into an ordinary
    // wait the busy handler absorbs.
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Drop every tree of one root past the retention window, rows and all.
   *
   * Called from inside {@link SqliteProjectionStore.writeExtent}'s transaction,
   * so an eviction and the write that caused it commit together or not at all —
   * a store can never be observed holding the manifest row of a tree whose rows
   * are already gone, which would read as a hit and return an empty extent.
   *
   * The manifest row is deleted **last** for each victim. It is what
   * {@link SqliteProjectionStore.readExtent} consults to tell a written-and-empty
   * extent from an unwritten one, so removing it first would open a window —
   * inside this transaction only, but a window all the same for anything later
   * added to it — where the key reads as present with nothing under it.
   *
   * @param rootId - The root whose trees are being aged out
   * @returns How many trees were evicted
   */
  #evictPastRetention(rootId: string): number {
    const victims = this.#extentsPastRetention.all(rootId, this.#retainedExtentsPerRoot) as {
      storeTreeHash: string;
    }[];
    for (const victim of victims) {
      for (const plan of this.#plansOfScope('extent')) {
        plan.deleteExtent?.run(rootId, victim.storeTreeHash);
      }
      this.#forgetExtent.run(rootId, victim.storeTreeHash);
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
  #clearSpaceFor(
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
        ...(plan.keyColumns ?? []).map(([column, { kind }]) => encodeValue(kind, row[column])),
      );
    }
  }

  /**
   * Insert every row of a bundle into the tables of one scope.
   *
   * @param bundle - Table key to rows
   * @param scope - Which tables to expect in the bundle
   * @param leadingValues - Values bound before the row's own columns — the
   *   extent key, or nothing
   */
  #insertBundle(
    bundle: Record<string, readonly Record<string, unknown>[]>,
    scope: 'blob' | 'extent',
    leadingValues: readonly string[],
  ): void {
    for (const plan of this.#plansOfScope(scope)) {
      for (const row of bundle[plan.spec.key] ?? []) {
        plan.insert.run(...leadingValues, ...plan.columns.map(([column, { kind }]) => encodeValue(kind, row[column])));
      }
    }
  }

  /**
   * The plans for one scope's tables, in registry order.
   *
   * @param scope - Which scope
   * @returns Their plans
   */
  #plansOfScope(scope: 'blob' | 'extent'): readonly TablePlan[] {
    return this.#plans.filter((plan) => plan.spec.scope === scope);
  }

  /**
   * A blob-fact statement, prepared once per `(table, placeholder count)`.
   *
   * These cannot be prepared in the constructor because their arity is the
   * batch size, but they must still be reused — see {@link TablePlan} for the
   * snapshot-pinning this closes. The key space is tiny in practice: a full
   * batch and at most one remainder per table.
   *
   * @param verb - Which statement
   * @param spec - A blob-scoped table's registry entry
   * @param keyCount - How many content keys the statement binds
   * @returns The prepared statement
   */
  #blobStatement(verb: 'select' | 'delete', spec: StoredTableSpec, keyCount: number): StatementSync {
    const cacheKey = `${verb}:${spec.name}:${keyCount}`;
    const cached = this.#blobStatements.get(cacheKey);
    if (cached !== undefined) return cached;

    const sql = verb === 'select' ? selectBlobFactsSql(spec, keyCount) : deleteBlobFactsSql(spec, keyCount);
    const statement = this.#database.prepare(sql);
    this.#blobStatements.set(cacheKey, statement);
    return statement;
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
 * Turn stored rows back into projection rows.
 *
 * @param plan - The table the rows came from, with its column kinds
 * @param raw - What SQLite returned
 * @returns The decoded rows
 */
function decodeRows(plan: TablePlan, raw: readonly unknown[]): readonly Record<string, unknown>[] {
  return raw.map((stored) => {
    const source = stored as Record<string, SqliteResultValue>;
    const row: Record<string, unknown> = {};
    for (const [column, { kind }] of plan.columns) {
      row[column] = decodeValue(kind, source[column] ?? null);
    }
    return row;
  });
}

/**
 * Every content key a bundle names **anywhere**, across all four blob-scoped
 * tables, deduplicated.
 *
 * ## 🪤 Why the union, and not the `blobs` table alone
 *
 * A key can legitimately appear in a child table with **no `blobs` row of its
 * own**, and this is not an edge case: `blob-population.ts` records a
 * `BLOB_NOT_TEXT`, `BLOB_UNREADABLE` or `BLOB_CONTENT_CHANGED` condition
 * *instead of* a `blobs` row whenever it declines to parse a blob, and two of
 * those three could not carry a `blobs` row at any price — there are no
 * trustworthy bytes to measure. {@link ProjectionStore.readBlobFacts} states the
 * rule directly: *a key is held when it has a `blobs` row **or** a
 * `blobConditions` row, and neither table alone answers the question.*
 *
 * This function used to read `blobs` alone, and a guard beside it (
 * `assertNoOrphanFacts`) then **rejected the whole bundle** whenever a child row
 * named a key `blobs` did not — so a single `.so`, `.pyc`, image or archive
 * anywhere under a root made every `writeBlobFacts` throw. Measured on a real
 * adopter plugin inside a large monorepo: 31 declined blobs against 8,076
 * parsed ones, enough to leave the store at its empty schema with **zero rows
 * in all thirteen tables** where it now holds 193,021 — while the command
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
 * Split a key list into batches small enough for one `IN (…)`.
 *
 * @param keys - The keys
 * @yields Batches of at most {@link KEY_BATCH_SIZE}; nothing at all when empty
 */
function* batched(keys: readonly string[]): Generator<readonly string[]> {
  for (let start = 0; start < keys.length; start += KEY_BATCH_SIZE) {
    yield keys.slice(start, start + KEY_BATCH_SIZE);
  }
}
