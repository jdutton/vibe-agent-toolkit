/**
 * The simplest thing that satisfies {@link ProjectionStore} — and counts what it
 * was asked to do. Shared by every suite that drives `populate` through a
 * cache, so the double cannot drift between them.
 *
 * ## Why the double lives here and not in `projection-sqlite`
 *
 * `resources` must never import `@vibe-agent-toolkit/projection-sqlite`. That is
 * the architectural seam the whole storage design exists to preserve — the
 * driver is written against {@link ProjectionStore} and against nothing else, so
 * a second backend cannot quietly change what a hit means. Importing the shipped
 * backend to test the driver would dissolve that seam in the one place it is
 * most load-bearing.
 *
 * So {@link FakeProjectionStore} is deliberately the dumbest store that can
 * answer: one bundle per `(rootId, treeHash)`, one bundle per content key, and a
 * counter on every method. It does **not** implement `writeExtent`'s
 * additive-per-context semantics; that contract is a property of a *backend* and
 * is tested against the real one in `projection-sqlite`. What is under test
 * through it is the driver's *reuse rule*, which is backend-independent by
 * construction.
 */

import { GitTracker } from '@vibe-agent-toolkit/utils/git';

import { ContributorRegistry } from '../src/projection/contributor.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { DISCARD_BLOB_POPULATION, populate } from '../src/projection/merge.js';
import type { Projection } from '../src/projection/projection.js';
import type {
  BlobScopedRows,
  ExtentKey,
  ExtentScopedRows,
  ProjectionStore,
} from '../src/projection/store.js';
import { PROJECTION_TABLES } from '../src/projection/table-registry.js';


/** A table bundle seen structurally, which is how the double walks every table. */
type RowBundle = Record<string, readonly Record<string, unknown>[]>;

/** {@link ProjectionTableSpec.scope} for the content-keyed half. */
const BLOB_SCOPE = 'blob';

/** The column three of the four blob-scoped tables name their key in. */
const BLOB_COLUMN = 'blob';

/**
 * The blob-scoped tables, read off the registry rather than written out, so a
 * fourteenth one is stored rather than silently dropped on the floor.
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
  blobClaudeImports: BLOB_COLUMN,
};

/**
 * The key column of one blob-scoped table.
 *
 * Throws rather than defaulting: a fourteenth blob table whose rows this double
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
 * An empty blob bundle, one array per blob-scoped table.
 *
 * @returns Four empty tables
 */
function emptyBlobBundle(): RowBundle {
  const bundle: RowBundle = {};
  for (const table of BLOB_TABLES) bundle[table] = [];
  return bundle;
}

/**
 * The simplest thing that satisfies {@link ProjectionStore} — and counts what it
 * was asked to do.
 *
 * The counters are the point. "The store answered" is only observable from the
 * outside as *work that did not happen*: a hit runs no contributor and writes
 * nothing, and without a count of the write calls a hit and a miss that happened
 * to produce identical rows are the same observation.
 */
export class FakeProjectionStore implements ProjectionStore {
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
   * Record blob facts, idempotently.
   *
   * A key the double already holds is left alone, matching the interface's own
   * promise — and not merely for fidelity: appending instead would duplicate
   * every row on the second write, and a hydration carrying doubled rows would
   * fail the byte-identical oracle for a reason that is the double's fault
   * rather than the driver's.
   *
   * @param rows - The four blob-scoped tables
   */
  async writeBlobFacts(rows: BlobScopedRows): Promise<void> {
    this.writeBlobFactsCalls++;
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
    for (const [key, bundle] of incoming) {
      if (!this.#blobs.has(key)) this.#blobs.set(key, bundle);
    }
  }

  /**
   * Read back what is held for a set of keys.
   *
   * A key never seen contributes no rows, which is a miss and not an error —
   * deciding what an incomplete answer means is `blobFactsCover`'s job, not a
   * backend's.
   *
   * @param contentKeys - The keys to look up
   * @returns The rows held for them
   */
  async readBlobFacts(contentKeys: readonly string[]): Promise<BlobScopedRows> {
    this.readBlobFactsCalls++;
    const merged = emptyBlobBundle();
    for (const key of contentKeys) {
      const held = this.#blobs.get(key);
      if (held === undefined) continue;
      for (const table of BLOB_TABLES) {
        merged[table] = [...(merged[table] ?? []), ...(held[table] ?? [])];
      }
    }
    return merged as unknown as BlobScopedRows;
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
  async writeExtent(key: ExtentKey, rows: ExtentScopedRows): Promise<void> {
    this.writeExtentCalls++;
    this.#extents.set(extentKeyOf(key), rows);
  }

  /**
   * Read back everything stored under one tree.
   *
   * @param key - Which root, which tree
   * @returns The eight tables, or `undefined` when this tree was never written
   */
  async readExtent(key: ExtentKey): Promise<ExtentScopedRows | undefined> {
    this.readExtentCalls++;
    return this.#extents.get(extentKeyOf(key));
  }

  /** Release nothing. */
  async close(): Promise<void> {
    // Nothing is held open.
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
 * Reports whether a contributor ran, i.e. whether the store hit was refused.
 */
export async function populateExtentThrough(
  root: string,
  store: FakeProjectionStore,
  treeHash: string,
): Promise<{ projection: Projection; contributorRan: boolean }> {
  const tracker = new GitTracker(root);
  await tracker.initialize();
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());
  let contributorRan = false;
  const projection = await populate({
    root,
    registry,
    gitTracker: tracker,
    onBlobPopulation: DISCARD_BLOB_POPULATION,
    onContributorTiming: () => {
      contributorRan = true;
    },
    cache: { store, treeUnchanged: () => true, treeHash },
  });
  return { projection, contributorRan };
}
