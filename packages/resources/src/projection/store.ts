/**
 * The storage port, {@link FactStore}: the one seam a projection **store**
 * implements — the named interface that lets a storage backend be swapped
 * without changing anything above it. A backend is chosen and injected by the
 * CLI; nothing in this package names one.
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
 * | {@link FactStore.writeBlobFacts} | one `BEGIN IMMEDIATE` transaction: look up each key covered at read in the ledger, replace the keys uncovered at read or evicted since, re-stamp every held key, evict the oldest keys past `blobTierBudgetBytes`, never the write's own (excluded by key) | a staged file per table, renamed into a content-addressed directory |
 * | {@link FactStore.writeExtent} | delete-then-insert under the key, one transaction | a file per table under `root=…/tree=…/`, published through a manifest |
 * | {@link FactStore.readExtent} | `SELECT … WHERE rootId = ? AND treeHash = ?` | read the manifest, then scan exactly the files it lists |
 *
 * Neither column is awkward, which is what the seam had to demonstrate. Only the
 * first column ships: a columnar backend was built and then **removed**, because
 * the access pattern a cache actually needs is a keyed point lookup — read one
 * extent, read the facts for a set of content keys — which is the one shape a
 * scan-oriented format is worst at.
 *
 * ## Why the two scopes are separate operations
 *
 * {@link ProjectionTableScope} splits the tables in two, and the split is
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
 *   `projection-sqlite` keeps the most recently used few trees per root and drops the rest as
 *   it writes — and no caller is offered a lever it would have to know when to
 *   pull. Beyond that, the cache lives under `vatCacheNamespaceRoot()` and
 *   inherits that tenant's policy: the namespace moves on every release, and OS
 *   tmpdir purge is what reclaims a directory this build no longer opens.
 *   (Provisional: this section is rewritten when eviction moves behind the port.)
 * - **No version or format discriminator in the data.** What separates one
 *   build's rows from another's is {@link projectionShapeDigest}, in the path —
 *   derived from the schemas, never declared.
 */

import { createHash } from 'node:crypto';

import { deepFreeze } from '@vibe-agent-toolkit/utils';

import type { ContentKey } from '../content-key.js';
import { schemaShapeSource } from '../schemas/parse-facts.js';
import type { ReferenceSyntacticForm } from '../schemas/projection-blobs.js';

import { projectionColumnTypes } from './column-kinds.js';
import { isProjectionTable, storedRelationSpecs, type StoredRelationSpec } from './derived-table-registry.js';
import type { HarnessId } from './harness/profile.js';
import type { Projection } from './projection.js';
import type { RowSetId, RowSetIdText } from './row-set-id.js';
import type { RowSetRows, RowSetTableName } from './row-set-table-registry.js';
import {
  BLOB_BYTE_MEASURE,
  STORE_BOOKKEEPING_TABLES,
  type BlobByteMeasure,
  type StoreBookkeepingTables,
} from './store-bookkeeping.js';
import { type PROJECTION_TABLES, type ProjectionRow, type ProjectionTableName } from './table-registry.js';

/** Hex digits kept from the shape digest. Short on purpose — it is a path component. */
const SHAPE_DIGEST_LENGTH = 12;

/** Pure and mildly expensive: every table's schema through the JSON Schema converter. */
let memoizedShapeDigest: string | undefined;

/**
 * The table names of one scope, split in the type system rather than by hand.
 *
 * Reads each entry's declared `scope` back out of {@link PROJECTION_TABLES},
 * so a new table joins the right bundle by declaring its scope in the
 * registry and nowhere else. A hand-written union here would be a second list
 * to keep in sync, which is the drift the registry exists to prevent.
 */
export type ProjectionTableNamesOfScope<Scope extends string> = {
  [Name in ProjectionTableName]: (typeof PROJECTION_TABLES)[Name]['scope'] extends Scope ? Name : never;
}[ProjectionTableName];

/** The tables whose rows are a pure function of a blob's bytes. */
export type BlobScopedTableName = ProjectionTableNamesOfScope<'blob'>;

/** The eight tables whose rows describe what is present in one tree. */
export type ExtentScopedTableName = ProjectionTableNamesOfScope<'extent'>;

/** Some of the projection's tables, each as a flat row array. */
type ProjectionTablesOf<Names extends ProjectionTableName> = {
  readonly [Name in Names]: readonly ProjectionRow<Name>[];
};

/**
 * The blob-keyed half of a projection: `blobs` and the tables that hang off
 * it.
 */
export type BlobScopedRows = ProjectionTablesOf<BlobScopedTableName>;

/** One (blob, harness) pair of the partitioned harness tables: the unit a harness row is written in. */
export interface HarnessPair {
  readonly contentKey: ContentKey;
  readonly harness: HarnessId;
}

/**
 * One {@link FactStore.writeBlobFacts}: the rows the run holds and what its read
 * already covered. Every field is required: an omitted coverage would read as
 * "nothing was covered", which replaces every held key, and a caller that
 * forgot it would still compile.
 */
export interface BlobFactsWrite {
  /** Every blob-scoped row the run holds for the extent's keys, derived and reused alike. */
  readonly rows: BlobScopedRows;
  /** The keys the one coverage predicate called covered in the run's read; a key `rows` does not hold is not written. */
  readonly coveredAtRead: readonly ContentKey[];
  /** The reached (blob, harness) pairs the run served from that read. */
  readonly settledAtRead: readonly HarnessPair[];
}

/**
 * What one {@link FactStore.readBlobFacts} reads: which blob-scoped tables,
 * and which `blobReferences` rows by syntactic form.
 *
 * Required on every read, never defaulted: each caller states what it
 * consumes, so a caller that reads the lexical forms or the harness tables
 * (the projection a hit assembles) asks for them, and one that does not (the
 * stored admission) never decodes them. The answer's type is the requested
 * tables only, so a caller holding a restricted answer cannot hand it to code
 * that reads every table (`assembleProjection` does not compile against it).
 */
export interface BlobRequest<Table extends BlobScopedTableName> {
  /** The tables to read; a table not named is not read and is absent from the answer. */
  readonly tables: readonly Table[];
  /**
   * The `blobReferences` rows to read, by `syntacticForm`: `'all'`, or only
   * those whose form is in the set. Ignored when `tables` omits `blobReferences`.
   */
  readonly referenceForms: ReadonlySet<ReferenceSyntacticForm> | 'all';
}

/**
 * What one {@link FactStore.readBlobFacts} answers: the requested rows, and which
 * of the requested keys the store holds. Both are read in one transaction, so a
 * key evicted between them cannot be called present beside rows it no longer has.
 * Required, both: an answer without `present` would leave the caller to infer
 * presence from rows, which no table can answer (a key may hold no row in the
 * tables a request names).
 */
export interface BlobFactsRead<Table extends BlobScopedTableName> {
  /** The rows held for the requested keys, in exactly the requested tables. */
  readonly rows: Pick<BlobScopedRows, Table>;
  /**
   * The requested keys the store's ledger tracks: read from the ledger, never
   * from `rows`. A key with a ledger entry but no row in the requested tables is
   * present; a key never written, or evicted, is absent.
   */
  readonly present: ReadonlySet<ContentKey>;
}

/**
 * What one {@link FactStore.readRowSets} reads: exactly these row-set tables. Required, never
 * defaulted: the port reads what it is asked and adds nothing, so the run's reader adds the head
 * table to every read itself.
 */
export interface RowSetRequest<Table extends RowSetTableName> {
  /** The tables to read; a table not named is not read and is absent from the answer. */
  readonly tables: readonly Table[];
}

/**
 * What one {@link FactStore.readRowSets} answers: the requested rows, and which of the requested
 * row sets the row-set ledger (`row_set_keys`) holds, both read in one transaction, so a row set
 * evicted between them is never called present beside rows it no longer has.
 */
export interface RowSetRead<Table extends RowSetTableName> {
  /** The rows held for the requested ids, in exactly the requested tables. */
  readonly rows: Pick<RowSetRows, Table>;
  /** The requested ids the ledger tracks, read from the ledger, never from `rows`. */
  readonly present: ReadonlySet<RowSetIdText>;
}

/**
 * One {@link FactStore.writeRowSets}: the rows the run holds and what its read covered. Both
 * fields required: an omitted coverage would read as "nothing was covered" and replace every held
 * row set.
 */
export interface RowSetWrite {
  /**
   * The row sets the run holds, every table of each instance present (an instance's tables may be
   * empty arrays): complete row sets for the ids the run extracted, and the head row of every id it
   * served from its read. The held ids are the head table's.
   */
  readonly rows: Partial<RowSetRows>;
  /** The ids the run's coverage read called covered; a covered id still in the ledger is not rewritten. */
  readonly coveredAtRead: readonly RowSetId[];
}

/** Every blob-scoped table, every reference form: what a projection hit assembles from. Frozen: every caller shares it. */
export const ALL_BLOB_REQUEST: BlobRequest<BlobScopedTableName> = deepFreeze({
  tables: storedRelationSpecs()
    .filter(isProjectionTable)
    .filter((spec) => spec.scope === 'blob')
    .map((spec) => spec.key as BlobScopedTableName),
  referenceForms: 'all',
});

/** The tree-scoped half of a projection: everything that is not blob-keyed. */
export type ExtentScopedRows = ProjectionTablesOf<ExtentScopedTableName>;

/**
 * The two reconstruction steps `selectRequestedRows` can run over a stored
 * extent, and the tables each one reads: the context-less tables are not
 * partitioned by context, so a run's share of them is recovered from the
 * context-scoped rows it kept.
 *
 * - `identity` keeps the identity-keyed tables (`resources`, `resourceTags`,
 *   `claudeRulePatterns`) whose `resourceId` a kept realization or membership
 *   names: it reads `resourceRealizations` and `resourceExtents`, and the three
 *   tables it narrows.
 * - `roots` keeps the `roots` rows of the run's own root and of every kept
 *   resolution context: it reads `resolutionContexts`, and `roots`.
 *
 * Every context-less extent table is exactly one step's output, so a request
 * can name one only with its step (a unit test holds this to the registry, both
 * ways).
 */
export const EXTENT_STEP_TABLES = {
  identity: ['resourceRealizations', 'resourceExtents', 'resources', 'resourceTags', 'claudeRulePatterns'],
  roots: ['resolutionContexts', 'roots'],
} as const satisfies Record<string, readonly ExtentScopedTableName[]>;

/** A reconstruction step of {@link EXTENT_STEP_TABLES}. */
export type ExtentStep = keyof typeof EXTENT_STEP_TABLES;

/**
 * The steps a request naming `Table` can run: a step is available only when
 * every table it reads is requested, so a request asking for a step without its
 * inputs does not compile.
 */
export type ExtentStepsFor<Table extends ExtentScopedTableName> = {
  [Step in ExtentStep]: [(typeof EXTENT_STEP_TABLES)[Step][number]] extends [Table] ? Step : never;
}[ExtentStep];

/**
 * What one {@link FactStore.readExtent} reads, and what `selectRequestedRows`
 * reconstructs from it: which extent-scoped tables, and which reconstruction
 * steps.
 *
 * Required on every read, never defaulted, like {@link BlobRequest}: membership
 * reads three tables and runs no step, a projection hit reads every table and
 * runs both. The answer's type is the requested tables only, so a restricted
 * answer cannot be assembled into a projection.
 */
export interface ExtentRequest<Table extends ExtentScopedTableName> {
  /** The tables to read; a table not named is not read and is absent from the answer. */
  readonly tables: readonly Table[];
  /**
   * The reconstruction steps to run; each needs every table it reads in `tables`. Stores ignore
   * steps: the caller runs them (`selectRequestedRows`), and the run's reader (`holdsExtent` in
   * stored-reads.ts) relies on that when it compares tables only.
   */
  readonly steps: readonly ExtentStepsFor<Table>[];
}

/** Every extent-scoped table and both steps: what a projection hit assembles from. Frozen: every caller shares it. */
export const ALL_EXTENT_REQUEST: ExtentRequest<ExtentScopedTableName> = deepFreeze({
  tables: storedRelationSpecs()
    .filter(isProjectionTable)
    .filter((spec) => spec.scope === 'extent')
    .map((spec) => spec.key as ExtentScopedTableName),
  steps: ['identity', 'roots'],
});

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
 * The connection {@link FactStore.attachedTo} attaches a store to: what an attach uses of
 * `node:sqlite`'s `DatabaseSync`, so the port names no SQLite module.
 */
export interface StoreAttachTarget {
  exec(sql: string): void;
  prepare(sql: string): { run(...parameters: string[]): unknown };
}

/**
 * The storage port: what a backend for the resource projection implements,
 * and all that a caller holding one may do — read and write blob facts, read an
 * extent, write one additively, and close. It carries no SQL: see "No query"
 * in this module's header.
 *
 * Every method is asynchronous because a backend may be — one running its engine
 * out of process, or over a network, has no synchronous option. A synchronous
 * backend — `projection-sqlite` is entirely synchronous — simply returns
 * already-resolved promises, which costs it nothing and keeps one interface.
 */
export interface FactStore {
  /**
   * Record facts about blobs, keyed by content.
   *
   * **Replaces what the run's read did not cover; re-stamps the rest.** The
   * write carries every blob-scoped row the run holds for the extent's keys,
   * derived and reused, with the keys the one coverage predicate called
   * covered in the run's read and the pairs the harness predicate called
   * settled in it. In one transaction it (1) looks up each covered key in the
   * ledger, which answers whether the key was evicted since the read, not
   * whether it is present; (2) replaces the keys uncovered at read or evicted
   * since, and the pairs not settled at read; (3) re-stamps every held key,
   * after the inserts and before eviction; (4) keeps the newest keys whose
   * recorded bytes fit the backend's byte budget and evicts the rest, never a
   * key the write holds: those are excluded by key, not by timestamp, so neither
   * a tree larger than the budget nor a store stamped by a faster clock can
   * evict the write's own keys.
   * Blob and harness rows are immutable per key (per pair for harness rows):
   * identical bytes yield identical rows, so a key still in the ledger is
   * unchanged since the read, and two writers that both replace a key leave
   * one copy. Concurrent writers are safe without coordination; the worst
   * case is duplicated work, never disagreeing data.
   *
   * ⛔ **A partitioned table is written per `(blob, partition)` pair**
   * (`ProjectionTableSpec.partitionColumn` — the harness tables). Their rows
   * are derived lazily, only for what one tree reaches, so one write can carry
   * a key's `blobs` row and none of its harness facts. A write must never
   * remove a pair it carries no rows for; a pair it carries and did not settle
   * at read, or whose key it replaces, replaces what the store held for that
   * pair.
   *
   * @param write - The held rows, the keys covered at read and the pairs settled at read
   */
  writeBlobFacts(write: BlobFactsWrite): Promise<void>;

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
   * 🔑 **Presence is the ledger's answer, not the rows'.** `present` names the
   * requested keys the store's ledger tracks, read in the same transaction as
   * `rows`: a key with a ledger entry and no row in the requested tables is
   * present (a narrow request over a reference-free blob), and a key never
   * written or evicted is absent. A caller joining two reads checks each key's
   * presence in the later one, so a key evicted between them is never served
   * from the earlier read's rows.
   *
   * @param contentKeys - The keys to look up; may be empty
   * @param request - Which tables, and which reference forms, to read
   * @returns The rows held for those keys, in exactly the requested tables, and which of them are present
   */
  readBlobFacts<Table extends BlobScopedTableName>(
    contentKeys: readonly ContentKey[],
    request: BlobRequest<Table>,
  ): Promise<BlobFactsRead<Table>>;

  /**
   * Record row sets: the row-set tier's twin of {@link FactStore.writeBlobFacts}, against its own
   * ledger (`row_set_keys`) and its own byte budget.
   *
   * In one transaction it (1) looks up each `coveredAtRead` id in the ledger, which answers whether
   * the id was evicted since the read, not whether it is present; (2) replaces every held row set
   * not covered at read (delete, then insert, across every table of its instance); a covered id
   * whose ledger row is gone now is left absent, never written partially (the write carries only
   * its head row); (3) re-stamps every held id still in the ledger with the `storedRowBytes` of its
   * rows, after the inserts; (4) evicts past the row-set budget, newest kept, never an id the write
   * holds. Only successes are stored.
   *
   * @param write - The held rows and the ids covered at read
   */
  writeRowSets(write: RowSetWrite): Promise<void>;

  /**
   * Read the requested tables of some row sets, and which of them the ledger holds.
   *
   * Reads exactly the requested tables: the port adds none (the run's reader adds the head table).
   * An id the ledger does not hold contributes no rows and is absent from `present`; presence is
   * the ledger's answer, read in the rows' transaction.
   *
   * @param ids - The row sets to read; may be empty
   * @param request - Which tables to read
   * @returns The rows, in exactly the requested tables, and the ids present
   */
  readRowSets<Table extends RowSetTableName>(
    ids: readonly RowSetId[],
    request: RowSetRequest<Table>,
  ): Promise<RowSetRead<Table>>;

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
   * Read back the requested tables stored under one tree.
   *
   * Returns **every** context written under the key, not only the ones the
   * caller is about to ask about — the store does not know which contexts a
   * caller wants, and narrowing by context here would need a parameter that
   * duplicates the `zone_provenance` rows the answer already carries. Selecting
   * the subset a run is owed is `store-hydration.ts`'s job, which is also where
   * the rule for the context-less tables lives. Tables, though, are the
   * caller's to name: a table not requested is never decoded.
   *
   * @param key - Which root, which tree
   * @param request - Which tables to read (its `steps` are the reconstruction's, not the store's)
   * @returns The requested tables, or `undefined` when this tree was never
   *   written. The two are distinguishable on purpose: a tree can legitimately
   *   hold no resources at all, and an empty projection is a different answer
   *   from a cache miss.
   */
  readExtent<Table extends ExtentScopedTableName>(
    key: ExtentKey,
    request: ExtentRequest<Table>,
  ): Promise<Pick<ExtentScopedRows, Table> | undefined>;

  /**
   * Release whatever the backend holds open.
   *
   * Idempotent: closing twice is not an error. A store that has been closed
   * rejects further calls rather than silently reopening — a reopen would hide
   * a lifetime bug in the caller.
   */
  close(): Promise<void>;

  /**
   * Attach this store read-only to `target` under `schema`, run `work`, and detach it, so a query
   * copies stored rows inside SQLite. Required, so every wrapper of the port forwards it: a wrapper
   * that drops it does not compile. A store with no database file to attach throws.
   *
   * @param target - The connection, outside any transaction
   * @param schema - The name the store is attached under while `work` runs
   * @param work - What reads the attached store
   * @returns What `work` returns
   */
  attachedTo<T>(target: StoreAttachTarget, schema: string, work: () => T): T;
}

/**
 * A digest of what a *stored* projection looks like — the thing a backend puts
 * in its path so two incompatible shapes cannot share a directory.
 *
 * `schemas/projection-shared.ts` records that `PROJECTION_SCHEMA_VERSION` was
 * removed, and that a stored projection takes a **derived** digest of the row
 * schemas' own shape in its place, never that constant reinstated. This is
 * that digest.
 *
 * It is not a version. Nobody bumps it, no reader branches on it, and there is
 * no migration path — a schema edit simply lands in a different directory, the
 * old one is cold, and the OS tmpdir purge that already owns this cache's
 * eviction reclaims it. That is the whole mechanism.
 *
 * Every input below changes what is stored, for every stored relation
 * (`storedRelationSpecs()`: the projection tables and the row-set tables):
 *
 * - each table's **row schema shape**, prose stripped, so rewording a
 *   `.describe()` cannot cool the cache while adding an optional field does;
 * - its **column kinds** (`projectionColumnTypes`), a `scalar` column's
 *   companions included: they decide how a value is encoded, and the JSON
 *   Schema of a scalar's union does not show them;
 * - for a row-set table, its **instance**, whether it is the **head**, and its
 *   **variants**: they decide which ledger row a row set's rows belong to;
 * - its **primary key**, which is the stored table's key and cannot be read
 *   back out of a Zod object;
 * - its **scope**, which decides which partition a row is filed under, so
 *   moving a table between them must invalidate both;
 * - its **context column**, which decides what a write replaces. Rows already
 *   filed under one partitioning would survive a write that partitions
 *   differently, so a store written before the change and read after it holds
 *   rows this build would never have kept;
 * - its **partition column** (the harness tables' `harness`), which decides
 *   what a lazy blob-tier write replaces, for the same reason;
 * - the store's **bookkeeping tables** (`STORE_BOOKKEEPING_TABLES`: `extents`,
 *   `blob_keys` and `row_set_keys`, each column's name and type and the primary key), which a
 *   backend builds its DDL from. A store written before a bookkeeping column
 *   existed cannot be written by a build that records it, so it must be cold
 *   rather than adopted;
 * - the **byte measure** (`BLOB_BYTE_MEASURE`), the unit `blob_keys.bytes` and
 *   `row_set_keys.bytes` are recorded in: a store recorded under one measure and budgeted under another
 *   would sum two units.
 *
 * What changes facts without changing their shape is not an input: the
 * extraction code, and the skill-text declaration whose matches
 * `skill_text_facts` and `skill_text_matches` hold. The cache namespace above
 * this directory (`cache-namespace.ts`) separates those by the VAT version
 * only; within one version a developer who changes them clears the cache.
 *
 * @returns Twelve lowercase hex digits, stable across processes and rebuilds
 *
 * @example
 * safePath.join(vatCacheNamespaceRoot(), projectionStoreDirectoryName())
 */
export function projectionShapeDigest(): string {
  memoizedShapeDigest ??= shapeDigestOf(storedRelationSpecs(), STORE_BOOKKEEPING_TABLES, BLOB_BYTE_MEASURE);
  return memoizedShapeDigest;
}

/**
 * The shape digest of the stored relations, a bookkeeping declaration and a
 * byte measure — the pure function {@link projectionShapeDigest} memoizes over
 * the real ones. Exported so a test can ask what a perturbed declaration hashes to.
 *
 * @param specs - The stored relations (`storedRelationSpecs()`), in order
 * @param bookkeeping - The store's bookkeeping tables
 * @param measure - The byte measure every ledger's `bytes` is recorded in
 * @returns Twelve lowercase hex digits
 */
export function shapeDigestOf(
  specs: readonly StoredRelationSpec[],
  bookkeeping: StoreBookkeepingTables,
  measure: BlobByteMeasure,
): string {
  const hash = createHash('sha256').update('vat-projection-shape');
  // Registry declaration order, which is `Projection`'s own field order — a
  // reordering is a different document (see `exportProjection`), so letting it
  // move the digest is correct rather than merely tolerable.
  for (const spec of specs) hash.update(storedSpecShape(spec));
  for (const table of Object.values(bookkeeping)) {
    const columns = table.columns.map((column) => `${column.name} ${column.type}`).join(',');
    hash.update(`\0bookkeeping\0${table.name}\0${columns}\0${table.primaryKey.join(',')}`);
  }
  // Every field, so a constant added to the measure is digested with no edit here.
  hash.update(`\0measure\0${JSON.stringify(measure)}`);
  return hash.digest('hex').slice(0, SHAPE_DIGEST_LENGTH);
}

/**
 * What {@link shapeDigestOf} hashes of one stored relation: its name and kind, where its rows are
 * filed (a projection table's scope, context and partition columns; a row-set table's instance,
 * head and variants), its key, its column kinds (a scalar's companions included, which the JSON
 * Schema of its union cannot show) and its row schema's shape.
 *
 * @param spec - A stored relation
 * @returns The text hashed for it
 */
function storedSpecShape(spec: StoredRelationSpec): string {
  const placement = spec.kind === 'projection'
    ? `${spec.scope}\0${spec.contextColumn ?? ''}\0${spec.partitionColumn ?? ''}`
    : `${spec.instance}\0${String(spec.head)}\0${spec.variants.join(',')}`;
  return `\0${spec.name}\0${spec.kind}\0${placement}\0${spec.primaryKey.join(',')}`
    + `\0${JSON.stringify(projectionColumnTypes(spec))}\0${schemaShapeSource(spec.schema)}`;
}

/** The prefix every projection store directory's name carries, whatever its shape. */
const PROJECTION_STORE_DIRECTORY_PREFIX = 'projection-';

/**
 * The directory name, inside a cache namespace, of THIS build's projection
 * store: `projection-<shape digest>`. The one owner of the name: the store
 * opens it, `vat cache prune` keeps it, and every other shape's goes.
 *
 * @returns A single path segment
 */
export function projectionStoreDirectoryName(): string {
  return `${PROJECTION_STORE_DIRECTORY_PREFIX}${projectionShapeDigest()}`;
}

/**
 * Whether `name`, an entry inside a cache namespace, is a projection store of
 * any shape (this build's or another's).
 *
 * @param name - A single path segment
 * @returns True for a projection store directory name
 */
export function isProjectionStoreDirectoryName(name: string): boolean {
  return name.startsWith(PROJECTION_STORE_DIRECTORY_PREFIX);
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
 * await store.writeBlobFacts({ rows: blobs, coveredAtRead: [], settledAtRead: [] });
 * await store.writeExtent(key, extent);
 */
export function splitProjectionByScope(
  projection: Projection,
): { readonly blobs: BlobScopedRows; readonly extent: ExtentScopedRows } {
  const blobs: Record<string, readonly unknown[]> = {};
  const extent: Record<string, readonly unknown[]> = {};
  for (const spec of storedRelationSpecs().filter(isProjectionTable)) {
    const target = spec.scope === 'blob' ? blobs : extent;
    target[spec.key] = projection[spec.key];
  }
  // The registry is a mapped type over `keyof Projection` with each entry's
  // scope a literal, so the two records are exhaustive and disjoint by
  // construction; the compiler cannot follow that through the accessor.
  return {
    blobs: blobs as unknown as BlobScopedRows,
    extent: extent as unknown as ExtentScopedRows,
  };
}
