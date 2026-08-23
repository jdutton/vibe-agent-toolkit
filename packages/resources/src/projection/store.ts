/**
 * The seam a projection **store** implements — the named interface that lets a
 * storage backend be swapped without changing anything above it.
 *
 * A store is a cache, not an export. Nothing here promises durability, a stable
 * on-disk format, or a migration path: recovery is always "populate it again".
 * What it promises is that a second run over an unchanged tree does not have to
 * re-derive what the first one already knew.
 *
 * ## The seam is semantic, and that is the whole design
 *
 * The obvious shape — *publish an immutable batch of files, resolve the set of
 * files to read* — is a **columnar file store's** physical model, and writing it
 * down as the interface would force every other backend to imitate a file set it
 * has no reason to have. A SQLite backend implementing "publish a batch" would
 * be emulating immutable extents on top of a store whose entire advantage is
 * that it can update a row in place.
 *
 * So the operations are stated in the vocabulary of the projection itself —
 * **facts about blobs**, and **the extent of a tree** — and each backend owns
 * its physical strategy underneath. The test this interface had to pass was that
 * the same two writes land naturally in either physical model:
 *
 * | | `projection-sqlite` | a file-per-table backend |
 * |---|---|---|
 * | {@link ProjectionStore.writeBlobFacts} | `INSERT … ON CONFLICT DO NOTHING`, one transaction | a staged file per table, renamed into a content-addressed directory |
 * | {@link ProjectionStore.writeExtent} | delete-then-insert under the key, one transaction | a file per table under `root=…/tree=…/`, published through a manifest |
 * | {@link ProjectionStore.readExtent} | `SELECT … WHERE rootId = ? AND treeHash = ?` | read the manifest, then scan exactly the files it lists |
 *
 * Neither column is awkward, which is what the seam had to demonstrate. Only the
 * first column ships: a columnar backend was built and then **removed**, because
 * the access pattern a cache actually needs is a keyed point lookup — read one
 * extent, read the facts for a set of content keys — which is the one shape a
 * scan-oriented format is worst at.
 *
 * ## Why the two scopes are separate operations
 *
 * {@link ProjectionTableScope} splits the twelve tables in two, and the split is
 * a difference in *lifetime*, not a tidy grouping:
 *
 * - Blob-scoped rows are a pure function of bytes, so they are **global**. Two
 *   unrelated corpora containing the same file share the row, and a row stays
 *   correct forever. Writing them per-tree would re-derive, per tree, facts the
 *   store already holds.
 * - Extent-scoped rows only mean anything in company with the tree they were
 *   observed in, so they are keyed by {@link ExtentKey}. Keyed that way they are
 *   *also* immutable — the extent of a given tree is a pure function of that
 *   tree — which is what removes any need for locking, generation swapping or
 *   last-writer-wins between concurrent writers.
 *
 * One combined `write(projection)` would have to guess a lifetime for each
 * table, and that guess is exactly what the registry's `scope` already states.
 *
 * ## What is deliberately absent
 *
 * - **No query.** Querying the projection is a lens's job over the rows, and
 *   putting a SQL string in this interface would make every backend owe an
 *   engine. A store reads rows back; a lens decides what they mean.
 * - **No eviction operation.** A backend prunes internally on its own schedule —
 *   `projection-sqlite` keeps the newest few trees per root and drops the rest as
 *   it writes — and no caller is offered a lever it would have to know when to
 *   pull. Beyond that, the cache lives under `vatCacheNamespaceRoot()` and
 *   inherits that tenant's policy: the namespace moves on every release, and OS
 *   tmpdir purge is what reclaims a directory this build no longer opens.
 * - **No version or format discriminator in the data.** What separates one
 *   build's rows from another's is {@link projectionShapeDigest}, in the path —
 *   derived from the schemas, never declared.
 */

import { createHash } from 'node:crypto';

import { schemaShapeSource } from '../schemas/parse-facts.js';

import type { Projection } from './projection.js';
import { PROJECTION_TABLES, type ProjectionRow, type ProjectionTableName } from './table-registry.js';

/** Hex digits kept from the shape digest. Short on purpose — it is a path component. */
const SHAPE_DIGEST_LENGTH = 12;

/** Pure and mildly expensive: twelve schemas through the JSON Schema converter. */
let memoizedShapeDigest: string | undefined;

/**
 * The table names of one scope, split in the type system rather than by hand.
 *
 * Reads each entry's declared `scope` back out of {@link PROJECTION_TABLES},
 * so a thirteenth table joins the right bundle by declaring its scope in the
 * registry and nowhere else. A hand-written union here would be a second list
 * to keep in sync, which is the drift the registry exists to prevent.
 */
export type ProjectionTableNamesOfScope<Scope extends string> = {
  [Name in ProjectionTableName]: (typeof PROJECTION_TABLES)[Name]['scope'] extends Scope ? Name : never;
}[ProjectionTableName];

/** The four tables whose rows are a pure function of a blob's bytes. */
export type BlobScopedTableName = ProjectionTableNamesOfScope<'blob'>;

/** The eight tables whose rows describe what is present in one tree. */
export type ExtentScopedTableName = ProjectionTableNamesOfScope<'extent'>;

/** Some of the projection's tables, each as a flat row array. */
type ProjectionTablesOf<Names extends ProjectionTableName> = {
  readonly [Name in Names]: readonly ProjectionRow<Name>[];
};

/**
 * The blob-keyed half of a projection: `blobs` and the three tables that hang
 * off it.
 */
export type BlobScopedRows = ProjectionTablesOf<BlobScopedTableName>;

/** The tree-scoped half of a projection: everything that is not blob-keyed. */
export type ExtentScopedRows = ProjectionTablesOf<ExtentScopedTableName>;

/**
 * Names one immutable snapshot of one corpus.
 *
 * Both halves are required, and neither is sufficient alone. `treeHash` without
 * a root would let two projects sharing a cache namespace serve each other's
 * rows; a root without a tree hash names a directory whose contents change
 * under it, which is the mutable-snapshot problem this key exists to dissolve.
 */
export interface ExtentKey {
  /**
   * The corpus root, as `rootIdFor()` mints it — a hash of the resolved real
   * path, not the path itself.
   */
  readonly rootId: string;
  /**
   * A hash naming this tree's exact contents.
   *
   * In a repository this is a git tree hash, which `@vibe-validate/git`'s
   * `getGitTreeHash()` produces for a **dirty** working tree as well as a clean
   * one (it writes a tree against a temporary index). 🪤 It is specifically not
   * `git stash create`, whose commit object bakes in a timestamp — two calls on
   * byte-identical content would give different hashes moments apart, and every
   * read would miss.
   *
   * Outside a repository there is no such hash by construction, and the caller
   * supplies a digest of the extent itself in this slot. The store neither
   * produces nor interprets the value: any two runs that agree on the contents
   * must agree on this string, and that is the store's whole requirement.
   */
  readonly treeHash: string;
}

/**
 * A storage backend for the resource projection.
 *
 * Every method is asynchronous because a backend may be — one running its engine
 * out of process, or over a network, has no synchronous option. A synchronous
 * backend — `projection-sqlite` is entirely synchronous — simply returns
 * already-resolved promises, which costs it nothing and keeps one interface.
 */
export interface ProjectionStore {
  /**
   * Record facts about blobs, keyed by content.
   *
   * **Idempotent.** A content key the store already holds is left alone rather
   * than rewritten: identical bytes yield identical rows, so a re-write would
   * be a no-op that only costs I/O. This is what makes concurrent writers safe
   * without any coordination — the worst case is duplicated work, never
   * disagreeing data.
   *
   * @param rows - The four blob-scoped tables; any of them may be empty
   */
  writeBlobFacts(rows: BlobScopedRows): Promise<void>;

  /**
   * Read back the facts held for a set of content keys.
   *
   * Returns only what the store holds — a key it has never seen contributes no
   * rows, and that is a miss rather than an error.
   *
   * 🪤 **A key is "held" when it has a `blobs` row OR a `blobConditions` row,
   * and neither table alone answers the question.** A blob with no references
   * legitimately has zero `blobReferences` rows, so inferring "not cached" from
   * an empty child table would re-parse every reference-free file forever — but
   * `blobs` alone is not the oracle either, because the derivation stage
   * declines to parse a blob that is unreadable, changed under it, or **binary**
   * (see `blob-population.ts`'s NUL sniff), and records a `blobConditions` row
   * *instead of* a `blobs` row. Any corpus shipping one image or archive has
   * such keys, so a caller checking `blobs` alone would call every real corpus a
   * miss forever.
   *
   * @param contentKeys - The keys to look up; may be empty
   * @returns The rows held for those keys, across all four blob-scoped tables
   */
  readBlobFacts(contentKeys: readonly string[]): Promise<BlobScopedRows>;

  /**
   * Record the extent of one tree — **additively, at context granularity**.
   *
   * **Atomic across the eight tables.** A reader must never observe one table
   * updated and another not — a projection half from one tree and half from
   * another is not a projection of anything.
   *
   * ## 🔑 A write replaces the contexts it carries, and nothing else
   *
   * {@link ExtentKey} names a *tree*, not a *question*, and two commands over
   * one tree ask different questions of it: `vat inventory` declares the
   * filesystem extent plus one closure extent per skill, `vat resources scan`
   * declares the filesystem extent alone. A write that replaced the whole key
   * range would let the narrow run silently delete the broad run's closure
   * extents — the same key, a strictly smaller answer, and no error.
   *
   * So a write replaces exactly the resolution contexts its own rows name (see
   * {@link ProjectionTableSpec.contextColumn}) and leaves every other context
   * under that key alone. The filesystem extent is written once and read by
   * every command; each command adds its own closure extents; nobody clobbers
   * anybody.
   *
   * The alternative — folding a digest of the request into `treeHash` — was
   * rejected deliberately: it gives two commands disjoint keys, so they share
   * nothing but the blob tier, and enumeration is over half of what the cache
   * exists to save.
   *
   * The three tables with no context column (`roots`, `resources`,
   * `resourceTags`) are facts about the tree or about an identity rather than
   * about one extent's view of it, so they are **merged by primary key**: two
   * commands that both realize a file contribute the same identity row, and
   * whichever writes last writes the same bytes.
   *
   * @param key - Which root, which tree
   * @param rows - The eight extent-scoped tables; any of them may be empty
   */
  writeExtent(key: ExtentKey, rows: ExtentScopedRows): Promise<void>;

  /**
   * Read back everything stored under one tree.
   *
   * Returns **every** context written under the key, not only the ones the
   * caller is about to ask about — the store does not know what a caller wants,
   * and narrowing it here would need a second parameter that duplicates the
   * `zone_provenance` rows the answer already carries. Selecting the subset a
   * run is owed is `store-hydration.ts`'s job, which is also where the rule for
   * the three context-less tables lives.
   *
   * @param key - Which root, which tree
   * @returns The eight tables, or `undefined` when this tree was never written.
   *   The two are distinguishable on purpose: a tree can legitimately hold no
   *   resources at all, and an empty projection is a different answer from a
   *   cache miss.
   */
  readExtent(key: ExtentKey): Promise<ExtentScopedRows | undefined>;

  /**
   * Release whatever the backend holds open.
   *
   * Idempotent: closing twice is not an error. A store that has been closed
   * rejects further calls rather than silently reopening — a reopen would hide
   * a lifetime bug in the caller.
   */
  close(): Promise<void>;
}

/**
 * A digest of what a *stored* projection looks like — the thing a backend puts
 * in its path so two incompatible shapes cannot share a directory.
 *
 * `schemas/projection-shared.ts` records that `PROJECTION_SCHEMA_VERSION` was
 * removed, and states exactly what replaces it if a projection is ever stored
 * rather than returned in-process: *"a **derived** digest of the row schemas'
 * own shape, exactly as the parse cache does with `parseFactsShapeSource()` —
 * not this constant reinstated."* Storing a projection is that moment, and this
 * is that digest.
 *
 * It is not a version. Nobody bumps it, no reader branches on it, and there is
 * no migration path — a schema edit simply lands in a different directory, the
 * old one is cold, and the OS tmpdir purge that already owns this cache's
 * eviction reclaims it. That is the whole mechanism.
 *
 * Four inputs, because all four change what is stored:
 *
 * - each table's **row schema shape**, prose stripped, so rewording a
 *   `.describe()` cannot cool the cache while adding an optional field does;
 * - its **primary key**, which is the stored table's key and cannot be read
 *   back out of a Zod object;
 * - its **scope**, which decides which partition a row is filed under, so
 *   moving a table between them must invalidate both;
 * - its **context column**, which decides what a write replaces. Rows already
 *   filed under one partitioning would survive a write that partitions
 *   differently, so a store written before the change and read after it holds
 *   rows this build would never have kept.
 *
 * @returns Twelve lowercase hex digits, stable across processes and rebuilds
 *
 * @example
 * safePath.join(vatCacheNamespaceRoot(), `projection-${projectionShapeDigest()}`)
 */
export function projectionShapeDigest(): string {
  if (memoizedShapeDigest !== undefined) return memoizedShapeDigest;

  const hash = createHash('sha256').update('vat-projection-shape');
  // Registry declaration order, which is `Projection`'s own field order — a
  // reordering is a different document (see `exportProjection`), so letting it
  // move the digest is correct rather than merely tolerable.
  for (const spec of Object.values(PROJECTION_TABLES)) {
    hash.update(
      `\0${spec.name}\0${spec.scope}\0${spec.primaryKey.join(',')}`
      + `\0${spec.contextColumn ?? ''}\0${schemaShapeSource(spec.schema)}`,
    );
  }
  memoizedShapeDigest = hash.digest('hex').slice(0, SHAPE_DIGEST_LENGTH);
  return memoizedShapeDigest;
}

/**
 * Split a projection into the two halves a store writes separately.
 *
 * A caller holds one {@link Projection} and the store takes two bundles; doing
 * the split here rather than at each call site means the table-to-scope mapping
 * is read from the registry exactly once.
 *
 * @param projection - A populated projection
 * @returns Its blob-scoped and extent-scoped rows
 *
 * @example
 * const { blobs, extent } = splitProjectionByScope(projection);
 * await store.writeBlobFacts(blobs);
 * await store.writeExtent(key, extent);
 */
export function splitProjectionByScope(
  projection: Projection,
): { readonly blobs: BlobScopedRows; readonly extent: ExtentScopedRows } {
  const blobs: Record<string, readonly unknown[]> = {};
  const extent: Record<string, readonly unknown[]> = {};
  for (const spec of Object.values(PROJECTION_TABLES)) {
    const target = spec.scope === 'blob' ? blobs : extent;
    target[spec.key] = projection[spec.key];
  }
  // The registry is a mapped type over `keyof Projection` with each entry's
  // scope a literal, so the two records are exhaustive and disjoint by
  // construction; the compiler cannot follow that through `Object.values`.
  return {
    blobs: blobs as unknown as BlobScopedRows,
    extent: extent as unknown as ExtentScopedRows,
  };
}
