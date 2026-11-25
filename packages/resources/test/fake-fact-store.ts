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

import { ContributorRegistry } from '../src/projection/contributor.js';
import { DEFAULT_CONTENT_DEMAND, FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../src/projection/crawl-source.js';
import { populate } from '../src/projection/merge.js';
import type { Projection } from '../src/projection/projection.js';
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
 * One held key's bundle with a later write's rows applied, as the real store's
 * deletes leave it: a replaced key takes the write's unpartitioned rows; in a
 * partitioned table the partitions it replaces (every carried one for a
 * replaced key, the unsettled ones otherwise) take the write's rows, and every
 * other row stays.
 *
 * @param held - What the double holds for the key, if anything
 * @param incoming - What the later write carries for it
 * @param replaces - Whether the key is replaced
 * @param settled - The partition values settled at read for this key
 * @returns The merged bundle
 */
function applyWrite(held: RowBundle | undefined, incoming: RowBundle, replaces: boolean, settled: ReadonlySet<string>): RowBundle {
  // A key not replaced keeps what the double holds, which is nothing when it
  // holds nothing: its unpartitioned rows are not written, as in the real store.
  const merged: RowBundle = replaces ? { ...incoming } : { ...(held ?? emptyBlobBundle()) };
  for (const [table, column] of PARTITION_COLUMNS) {
    const written = (incoming[table] ?? []).filter((row) => replaces || !settled.has(partitionValue(row, column)));
    const carried = new Set(written.map((row) => JSON.stringify(row[column])));
    merged[table] = [
      ...(held?.[table] ?? []).filter((row) => !carried.has(JSON.stringify(row[column]))),
      ...written,
    ];
  }
  return merged;
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
  readonly #blobs = new Map<string, RowBundle>();

  /**
   * The ledger: every held content key, oldest stamp first. A re-stamp deletes
   * and re-adds the key, so `Map` order is the real store's
   * `(writtenAt, rowid)` order.
   */
  readonly #ledger = new Set<string>();

  /** How many content keys a write keeps; unbounded unless a case says otherwise. */
  readonly #retainedBlobKeys: number;

  /** @param retainedBlobKeys - The blob window, as the real store's `retainedBlobKeys` */
  constructor(retainedBlobKeys = Number.POSITIVE_INFINITY) {
    this.#retainedBlobKeys = retainedBlobKeys;
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
    const copy = new FakeFactStore(this.#retainedBlobKeys);
    for (const [key, rows] of this.#extents) copy.#extents.set(key, rows);
    for (const [key, bundle] of this.#blobs) copy.#blobs.set(key, bundle);
    for (const key of this.#ledger) copy.#ledger.add(key);
    return copy;
  }

  /**
   * Record blob facts by the port's replace-and-re-stamp rule: a held key the
   * read did not cover, or that left the ledger since, is replaced; a covered
   * key still in the ledger keeps its rows; every held key is re-stamped; then
   * the window is applied past `max(retention, held keys)`. PARTITIONED rows
   * (the harness tables) are written per `(blob, partition)`, as the interface
   * requires — see {@link applyWrite}.
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
    for (const [key, bundle] of incoming) {
      const replaces = !covered.has(key) || !this.#ledger.has(key);
      const settled = new Set(write.settledAtRead.filter((pair) => pair.contentKey === key).map((pair) => pair.harness));
      this.#blobs.set(key, applyWrite(this.#blobs.get(key), bundle, replaces, settled));
    }
    for (const key of incoming.keys()) {
      this.#ledger.delete(key);
      this.#ledger.add(key);
    }
    const keep = Math.max(this.#retainedBlobKeys, incoming.size);
    const victims = [...this.#ledger].slice(0, Math.max(0, this.#ledger.size - keep));
    for (const key of victims) this.forgetBlobFacts(key);
  }

  /** A write's rows, one bundle per content key. */
  #bundlesByKey(rows: BlobScopedRows): Map<string, RowBundle> {
    const source = rows as unknown as RowBundle;
    const incoming = new Map<string, RowBundle>();
    for (const table of BLOB_TABLES) {
      for (const row of source[table] ?? []) {
        const column = blobKeyColumn(table);
        const key = row[column];
        if (typeof key !== 'string') {
          throw new TypeError(
            `the store double expected '${table}.${column}' to hold a string content key, got ${typeof key}`,
          );
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
    contentKeys: readonly string[],
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
   * count-window eviction of that key, which a real backend does in
   * `evictBlobKeysPastRetention`.
   *
   * @param contentKey - The key to forget
   */
  forgetBlobFacts(contentKey: string): void {
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
}


/** A store whose blob tier rejects, once told to, with an error carrying a filesystem errno. */
export class FailingBlobStore extends FakeFactStore {
  failBlobs = false;
  /** What the tier rejects with: a filesystem errno, which no lane may file as a file's. */
  readonly failure: Error = Object.assign(new Error('ENOENT: no such file or directory, open \'/store/blobs\''), { code: 'ENOENT', errno: -2, syscall: 'open', path: '/store/blobs' });

  override readBlobFacts<Table extends BlobScopedTableName>(
    contentKeys: readonly string[],
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
