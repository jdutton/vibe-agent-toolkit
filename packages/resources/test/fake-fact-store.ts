/**
 * The simplest thing that satisfies {@link FactStore} — and counts what it
 * was asked to do. Shared by every suite that drives `populate` through a
 * cache, so the double cannot drift between them.
 *
 * ## Why the double lives here and not in `projection-sqlite`
 *
 * `resources` must never import `@vibe-agent-toolkit/projection-sqlite`. That is
 * the architectural seam the whole storage design exists to preserve — the
 * driver is written against {@link FactStore} and against nothing else, so
 * a second backend cannot quietly change what a hit means. Importing the shipped
 * backend to test the driver would dissolve that seam in the one place it is
 * most load-bearing.
 *
 * So {@link FakeFactStore} is deliberately the dumbest store that can
 * answer: one bundle per `(rootId, treeHash)`, one bundle per content key, and a
 * counter on every method. It does **not** implement `writeExtent`'s
 * additive-per-context semantics; that contract is a property of a *backend* and
 * is tested against the real one in `projection-sqlite`. What is under test
 * through it is the driver's *reuse rule*, which is backend-independent by
 * construction.
 */

import { promised } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';

import { type ContentKey, parseContentKey } from '../src/content-key.js';
import { type ProjectionColumnKind, projectionColumnTypes } from '../src/projection/column-kinds.js';
import { ContributorRegistry } from '../src/projection/contributor.js';
import { DEFAULT_CONTENT_DEMAND, FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../src/projection/crawl-source.js';
import { populate } from '../src/projection/merge.js';
import type { Projection } from '../src/projection/projection.js';
import { blobRowBytes, type EncodedStoreValue } from '../src/projection/store-bookkeeping.js';
import type {
  BlobFactsWrite,
  BlobRequest,
  BlobScopedRows,
  BlobScopedTableName,
  ExtentKey,
  ExtentRequest,
  ExtentScopedRows,
  ExtentScopedTableName,
  FactStore,
} from '../src/projection/store.js';
import { PROJECTION_TABLES } from '../src/projection/table-registry.js';
import type { ReferenceSyntacticForm } from '../src/schemas/projection-blobs.js';

import { inOwnRun } from './helpers/population-run.js';


/** A table bundle seen structurally, which is how the double walks every table. */
type RowBundle = Record<string, readonly Record<string, unknown>[]>;

/** {@link ProjectionTableSpec.scope} for the content-keyed half. */
const BLOB_SCOPE = 'blob';

/** The column every blob-scoped table but `blobs` names its key in. */
const BLOB_COLUMN = 'blob';

/**
 * The blob-scoped tables, read off the registry rather than written out, so a
 * further one is stored rather than silently dropped on the floor.
 */
const BLOB_TABLES: readonly string[] = Object.values(PROJECTION_TABLES)
  .filter((spec) => spec.scope === BLOB_SCOPE)
  .map((spec) => spec.key);

/** Which column each blob-scoped table names its content key in. */
const BLOB_KEY_COLUMNS: Readonly<Record<string, string>> = {
  blobs: 'contentKey',
  blobReferences: BLOB_COLUMN,
  blobSections: BLOB_COLUMN,
  blobConditions: BLOB_COLUMN,
  harnessBlobFacts: BLOB_COLUMN,
  harnessBlobImports: BLOB_COLUMN,
  skillTextFacts: BLOB_COLUMN,
  skillTextMatches: BLOB_COLUMN,
};

/**
 * The key column of one blob-scoped table.
 *
 * Throws rather than defaulting: a further blob table whose rows this double
 * filed under `undefined` would make every coverage check pass by accident,
 * which is the shape of bug this whole file is written to catch.
 *
 * @param table - The {@link Projection} field name
 * @returns The column holding the content key
 */
function blobKeyColumn(table: string): string {
  const column = BLOB_KEY_COLUMNS[table];
  if (column === undefined) {
    throw new Error(
      `the store double does not know which column '${table}' keys its blob by.`
      + ' A blob-scoped table was added; teach BLOB_KEY_COLUMNS about it.',
    );
  }
  return column;
}

/**
 * The partitioned blob tables and the column each is partitioned by — read off
 * the registry, as {@link BLOB_TABLES} is.
 */
const PARTITION_COLUMNS: ReadonlyMap<string, string> = new Map(
  Object.values(PROJECTION_TABLES).flatMap((spec) => {
    const column: string | undefined = 'partitionColumn' in spec ? spec.partitionColumn : undefined;
    return spec.scope === BLOB_SCOPE && column !== undefined ? [[spec.key, column] as const] : [];
  }),
);

/**
 * A row's partition value — the harness path every partitioned blob table is
 * keyed by. Settled pairs name it as a string, so any other value is a fixture
 * error, not a partition.
 *
 * @param row - A partitioned table's row
 * @param column - The table's partition column
 * @returns The partition value
 */
function partitionValue(row: Readonly<Record<string, unknown>>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new TypeError(`partition column ${column} holds a ${typeof value}, not a string`);
  }
  return value;
}

/**
 * A NOT-replaced key's bundle with a later write's rows applied, as the real
 * store's pair deletes leave it: its unpartitioned rows stay; in a partitioned
 * table each unsettled partition the write carries takes the write's rows, and
 * every other row stays. (A replaced key simply takes the write's rows, every
 * table, partitioned ones included.)
 *
 * @param held - What the double holds for the key
 * @param incoming - What the later write carries for it
 * @param settled - The partition values settled at read for this key
 * @returns The merged bundle, and the bytes the write added and deleted
 */
function applyPairWrite(
  held: RowBundle,
  incoming: RowBundle,
  settled: ReadonlySet<string>,
): { merged: RowBundle; added: number; deleted: number } {
  const merged: RowBundle = { ...held };
  let added = 0;
  let deleted = 0;
  for (const [table, column] of PARTITION_COLUMNS) {
    const written = (incoming[table] ?? []).filter((row) => !settled.has(partitionValue(row, column)));
    const carried = new Set(written.map((row) => JSON.stringify(row[column])));
    const [removed, kept] = partitioned(held[table] ?? [], (row) => carried.has(JSON.stringify(row[column])));
    merged[table] = [...kept, ...written];
    added += tableBytes(table, written);
    deleted += tableBytes(table, removed);
  }
  return { merged, added, deleted };
}

/**
 * Split rows by a predicate.
 *
 * @param rows - The rows
 * @param matches - The predicate
 * @returns The matching rows, then the rest
 */
function partitioned<Row>(rows: readonly Row[], matches: (row: Row) => boolean): readonly [Row[], Row[]] {
  return [rows.filter((row) => matches(row)), rows.filter((row) => !matches(row))];
}

/**
 * One value as the SQLite store binds it, by its column's kind — what
 * `blobRowBytes` measures. The double keeps rows unencoded, so it encodes to
 * measure: a boolean is 0 or 1, an instant its ISO-8601 text, a JSON value its
 * serialized text, anything else itself.
 *
 * @param kind - The column's kind
 * @param value - The row's value
 * @returns The encoded value
 */
function encodedForMeasure(kind: ProjectionColumnKind, value: unknown): EncodedStoreValue {
  if (value === null || value === undefined) return null;
  if (kind === 'boolean') return value === true ? 1 : 0;
  if (kind === 'timestamp') return timestampText(value);
  if (kind === 'json') return JSON.stringify(value);
  return value as EncodedStoreValue;
}

/**
 * A timestamp column's value as the ISO text SQLite stores.
 *
 * @param value - A `Date`, or the text or epoch milliseconds of one
 * @returns Its ISO text
 * @throws TypeError for any other value: a fixture carrying one is the defect
 */
function timestampText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).toISOString();
  throw new TypeError(`not a timestamp: ${typeof value}`);
}

/** Each blob-scoped table's columns and kinds, read off the registry. */
const BLOB_COLUMN_TYPES: ReadonlyMap<string, ReturnType<typeof projectionColumnTypes>> = new Map(
  Object.values(PROJECTION_TABLES)
    .filter((spec) => spec.scope === BLOB_SCOPE)
    .map((spec) => [spec.key, projectionColumnTypes(spec)] as const),
);

/**
 * The `blobRowBytes` of some rows of one blob-scoped table.
 *
 * @param table - The table's {@link Projection} field name
 * @param rows - Its rows
 * @returns Their bytes, summed
 */
function tableBytes(table: string, rows: readonly Readonly<Record<string, unknown>>[]): number {
  const columns = BLOB_COLUMN_TYPES.get(table) ?? [];
  return rows.reduce((total, row) => total + blobRowBytes(columns.map(([column, { kind }]) => encodedForMeasure(kind, row[column]))), 0);
}

/**
 * The `blobRowBytes` of every row of a bundle.
 *
 * @param bundle - One key's bundle
 * @returns Their bytes, summed
 */
function bundleBytes(bundle: RowBundle): number {
  return Object.entries(bundle).reduce((total, [table, rows]) => total + tableBytes(table, rows), 0);
}

/**
 * An empty blob bundle, one array per blob-scoped table.
 *
 * @returns One empty array per blob-scoped table
 */
function emptyBlobBundle(): RowBundle {
  const bundle: RowBundle = {};
  for (const table of BLOB_TABLES) bundle[table] = [];
  return bundle;
}

/**
 * A blob-tier budget no test corpus reaches: for a test that is not about
 * eviction, so its keys stay whatever it writes.
 */
export const WIDE_BLOB_BUDGET_BYTES = 1_000_000_000;

/**
 * The simplest thing that satisfies {@link FactStore} — and counts what it
 * was asked to do.
 *
 * The counters are the point. "The store answered" is only observable from the
 * outside as *work that did not happen*: a hit runs no contributor and writes
 * nothing, and without a count of the write calls a hit and a miss that happened
 * to produce identical rows are the same observation.
 */
export class FakeFactStore implements FactStore {
  /** How many times {@link readExtent} was asked. */
  readExtentCalls = 0;

  /** How many times {@link writeExtent} was asked. */
  writeExtentCalls = 0;

  /** How many times {@link readBlobFacts} was asked. */
  readBlobFactsCalls = 0;

  /** How many times {@link writeBlobFacts} was asked. */
  writeBlobFactsCalls = 0;

  /** One bundle per `(rootId, treeHash)`; a later write replaces the earlier one. */
  readonly #extents = new Map<string, ExtentScopedRows>();

  /** One bundle per content key, which is the granularity the real read takes. */
  readonly #blobs = new Map<ContentKey, RowBundle>();

  /**
   * The ledger: every held content key and its recorded bytes, oldest stamp
   * first. A re-stamp deletes and re-adds the key, so `Map` order is the real
   * store's `(writtenAt, rowid)` order.
   */
  readonly #ledger = new Map<ContentKey, number>();

  /** The blob tier's budget, in `blobRowBytes`. */
  readonly #blobTierBudgetBytes: number;

  /**
   * @param blobTierBudgetBytes - The blob tier's budget, as the real store's
   *   `blobTierBudgetBytes`; refused unless a positive finite number, as there
   */
  constructor(blobTierBudgetBytes: number) {
    if (!Number.isFinite(blobTierBudgetBytes) || blobTierBudgetBytes <= 0) {
      throw new RangeError(`the store double needs a positive finite blob budget, not ${String(blobTierBudgetBytes)}`);
    }
    this.#blobTierBudgetBytes = blobTierBudgetBytes;
  }

  /** The ledger as it stands: each tracked key and its recorded bytes. */
  ledgerBytes(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.#ledger);
  }

  /** `blobRowBytes` over each held key's rows, measured from the rows. */
  storedBytes(): Readonly<Record<string, number>> {
    return Object.fromEntries([...this.#blobs].map(([key, bundle]) => [key, bundleBytes(bundle)]));
  }

  /**
   * A store holding what this one holds, with every counter at zero: one warm
   * store filed once, and a copy per case that writes or evicts in its own.
   *
   * The maps are copied and the bundles shared: nothing here changes a held
   * bundle in place (a write files a new one, an eviction deletes the entry), so
   * no change to the copy reaches this store.
   *
   * @returns The copy
   */
  copy(): FakeFactStore {
    const copy = new FakeFactStore(this.#blobTierBudgetBytes);
    for (const [key, rows] of this.#extents) copy.#extents.set(key, rows);
    for (const [key, bundle] of this.#blobs) copy.#blobs.set(key, bundle);
    for (const [key, bytes] of this.#ledger) copy.#ledger.set(key, bytes);
    return copy;
  }

  /**
   * Record blob facts by the port's replace-and-re-stamp rule: a held key the
   * read did not cover, or that left the ledger since, is replaced whole; a
   * covered key still in the ledger keeps its rows but for its unsettled
   * PARTITIONED pairs, written per `(blob, partition)` as the interface requires
   * (see {@link applyPairWrite}); every held key is re-stamped with its bytes;
   * then the newest keys whose bytes fit the budget are kept, the held ones always.
   *
   * @param write - The held rows and what the read covered
   */
  writeBlobFacts(write: BlobFactsWrite): Promise<void> {
    this.writeBlobFactsCalls++;
    return promised(() => this.#mergeBlobFacts(write));
  }

  /** The synchronous body of {@link writeBlobFacts}. */
  #mergeBlobFacts(write: BlobFactsWrite): void {
    const incoming = this.#bundlesByKey(write.rows);
    const covered = new Set(write.coveredAtRead);
    const recorded = new Map<ContentKey, number>();
    for (const [key, bundle] of incoming) {
      const stored = this.#ledger.get(key);
      const held = this.#blobs.get(key);
      if (!covered.has(key) || stored === undefined || held === undefined) {
        this.#blobs.set(key, bundle);
        recorded.set(key, bundleBytes(bundle));
        continue;
      }
      const settled = new Set(write.settledAtRead.filter((pair) => pair.contentKey === key).map((pair) => pair.harness));
      const { merged, added, deleted } = applyPairWrite(held, bundle, settled);
      this.#blobs.set(key, merged);
      recorded.set(key, stored + added - deleted);
    }
    for (const [key, bytes] of recorded) {
      this.#ledger.delete(key);
      this.#ledger.set(key, bytes);
    }
    for (const key of this.#pastBudget(new Set(incoming.keys()))) this.forgetBlobFacts(key);
  }

  /**
   * The keys past the budget, as the real store's `BLOB_KEYS_PAST_BUDGET_SQL`:
   * the write's own keys are never selected (by key, not by their place in the
   * order) and their bytes count first; the rest follow newest first, and a key
   * goes once the running sum of recorded bytes passes the budget.
   *
   * @param held - The keys the write held
   * @returns The keys to evict
   */
  #pastBudget(held: ReadonlySet<ContentKey>): readonly ContentKey[] {
    const newestFirst = [...this.#ledger].reverse();
    let running = 0;
    for (const [key, bytes] of newestFirst) if (held.has(key)) running += bytes;
    return newestFirst.filter(([key, bytes]) => {
      if (held.has(key)) return false;
      running += bytes;
      return running > this.#blobTierBudgetBytes;
    }).map(([key]) => key);
  }

  /** A write's rows, one bundle per content key. */
  #bundlesByKey(rows: BlobScopedRows): Map<ContentKey, RowBundle> {
    const source = rows as unknown as RowBundle;
    const incoming = new Map<ContentKey, RowBundle>();
    for (const table of BLOB_TABLES) {
      for (const row of source[table] ?? []) {
        const column = blobKeyColumn(table);
        const value = row[column];
        const key = typeof value === 'string' ? parseContentKey(value) : undefined;
        if (key === undefined) {
          throw new TypeError(`the store double expected '${table}.${column}' to hold a content key, got ${String(value)}`);
        }
        const bundle = incoming.get(key) ?? emptyBlobBundle();
        incoming.set(key, bundle);
        bundle[table] = [...(bundle[table] ?? []), row];
      }
    }
    return incoming;
  }

  /**
   * Read back what is held for a set of keys.
   *
   * A key never seen contributes no rows, which is a miss and not an error —
   * deciding what an incomplete answer means is `blobFactsCover`'s job, not a
   * backend's.
   *
   * Honours the request as a real backend does: only the requested tables,
   * and of `blobReferences` only the requested forms.
   *
   * @param contentKeys - The keys to look up
   * @param request - Which tables and reference forms to read
   * @returns The rows held for them, in the requested tables
   */
  readBlobFacts<Table extends BlobScopedTableName>(
    contentKeys: readonly ContentKey[],
    request: BlobRequest<Table>,
  ): Promise<Pick<BlobScopedRows, Table>> {
    this.readBlobFactsCalls++;
    const forms = request.referenceForms;
    const kept = (table: string, row: unknown): boolean =>
      table !== 'blobReferences' || forms === 'all' || forms.has((row as { syntacticForm: ReferenceSyntacticForm }).syntacticForm);
    const merged: Record<string, unknown[]> = {};
    for (const table of request.tables) merged[table] = [];
    for (const key of contentKeys) {
      const held = this.#blobs.get(key);
      if (held === undefined) continue;
      for (const table of request.tables) {
        merged[table] = [...(merged[table] ?? []), ...(held[table] ?? []).filter((row) => kept(table, row))];
      }
    }
    return Promise.resolve(merged as unknown as Pick<BlobScopedRows, Table>);
  }

  /**
   * Drop every blob row held for one content key, and its ledger entry — a
   * byte-budget eviction of that key, which a real backend does in
   * `evictBlobKeysPastBudget`.
   *
   * @param contentKey - The key to forget
   */
  forgetBlobFacts(contentKey: ContentKey): void {
    this.#blobs.delete(contentKey);
    this.#ledger.delete(contentKey);
  }

  /**
   * Store one tree's extent under its key.
   *
   * Wholesale replacement, not the additive-per-context merge a real backend
   * owes — see this file's header on why that contract is tested elsewhere.
   *
   * @param key - Which root, which tree
   * @param rows - The eight extent-scoped tables
   */
  writeExtent(key: ExtentKey, rows: ExtentScopedRows): Promise<void> {
    this.writeExtentCalls++;
    this.#extents.set(extentKeyOf(key), rows);
    return Promise.resolve();
  }

  /**
   * Read back the requested tables stored under one tree, honouring the
   * request as a real backend does: a table not requested is absent.
   *
   * @param key - Which root, which tree
   * @param request - Which tables to read
   * @returns The requested tables, or `undefined` when this tree was never written
   */
  readExtent<Table extends ExtentScopedTableName>(
    key: ExtentKey,
    request: ExtentRequest<Table>,
  ): Promise<Pick<ExtentScopedRows, Table> | undefined> {
    this.readExtentCalls++;
    const held = this.#extents.get(extentKeyOf(key));
    if (held === undefined) return Promise.resolve(undefined);
    const picked = Object.fromEntries(request.tables.map((table) => [table, held[table]]));
    return Promise.resolve(picked as unknown as Pick<ExtentScopedRows, Table>);
  }

  /** Release nothing. */
  async close(): Promise<void> {
    // Nothing is held open.
  }

  /** A store in memory has no database file to attach. */
  attachedTo(): never {
    return noDatabaseFile();
  }
}

/**
 * The `attachedTo` of a test double with no database file: it refuses.
 *
 * @throws Error Always
 */
export function noDatabaseFile(): never {
  throw new Error('This fact store double has no database file to attach.');
}


/** A store whose blob tier rejects, once told to, with an error carrying a filesystem errno. */
export class FailingBlobStore extends FakeFactStore {
  failBlobs = false;
  /** What the tier rejects with: a filesystem errno, which no lane may file as a file's. */
  readonly failure: Error = Object.assign(new Error('ENOENT: no such file or directory, open \'/store/blobs\''), { code: 'ENOENT', errno: -2, syscall: 'open', path: '/store/blobs' });

  override readBlobFacts<Table extends BlobScopedTableName>(
    contentKeys: readonly ContentKey[],
    request: BlobRequest<Table>,
  ): Promise<Pick<BlobScopedRows, Table>> {
    if (!this.failBlobs) return super.readBlobFacts(contentKeys, request);
    return Promise.reject(this.failure);
  }
}


/**
 * One comparable string per {@link ExtentKey}.
 *
 * Both halves, because that is the whole claim the key makes: a tree hash filed
 * under the wrong root is a cross-corpus hit, which is the one failure the key
 * exists to make impossible.
 *
 * @param key - The key to flatten
 * @returns A string equal exactly when the keys are
 */
export function extentKeyOf(key: ExtentKey): string {
  return `${key.rootId} ${key.treeHash}`;
}

/**
 * One filesystem-extent population of `root` through `store`, with the tree
 * reported unchanged under a CONSTANT `treeHash` — the shape every store-freshness
 * suite needs, since the hazard it pins is a fact the tree hash does not cover.
 * Reports whether the run derived, i.e. whether the store hit was refused —
 * read off `populate()`'s outcome.
 */
export async function populateExtentThrough(
  root: string,
  store: FakeFactStore,
  treeHash: string,
): Promise<{ projection: Projection; derived: boolean }> {
  const tracker = new GitTracker(root);
  await tracker.initialize();
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor((at) => crawlSourceFor(at, []), DEFAULT_CONTENT_DEMAND));
  const { projection, outcome } = await inOwnRun(populate, {
    root,
    registry,
    gitTracker: tracker,
    cache: { store, treeUnchanged: () => true, treeHash },
  });
  return { projection, derived: outcome.stored !== 'hit' };
}
