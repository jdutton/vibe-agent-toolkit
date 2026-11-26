/**
 * The one way a run reads and writes its fact store: every population and lens of a run reads the
 * store through its `PopulationRun.stored`, so a stored row is decoded once per run, whichever
 * population asked first. Nothing else calls the port's reads or writes
 * (`local/fact-store-access-boundary`).
 *
 * ## A key's blob rows are held per unit, each read with the key's presence
 *
 * The run holds a content key's blob rows in UNITS: one per non-partitioned table, one per
 * reference form of `blobReferences`, and one for the harness tables together. A request reads,
 * for each key, only the units it does not hold, and a repeated request reads nothing, so no row
 * is decoded twice in a run. Every read returns, in the rows' own transaction, which of its keys
 * the ledger holds (`present`).
 *
 * Joining units from several reads is sound because blob rows are a function of the key under one
 * VAT version and leave the store only with the key's ledger row: an evict-and-rewrite files the
 * same rows again. So every read that finds the key present returns rows of the same set, and the
 * one hazard is a read that finds it gone. A key a read finds absent drops everything held for it
 * and is held as ABSENT: every later request is answered with no rows and reads nothing, until a
 * write forgets it. Without that check, an eviction between two reads would leave the key judged
 * covered on its first read's rows (the coverage predicate reads no lexical reference) with its
 * second read's rows missing. A key's `blobReferences` rows are kept in primary-key order, so rows
 * joined from several reads equal one whole read's.
 *
 * The harness tables are one unit because they are derived lazily, per `(key, harness)` pair, and
 * a pair's facts and imports must come from one read. A pair the store gains after the key's
 * harness read is not held: the harness pass finds it unsettled and derives it, and its write
 * forgets the key.
 *
 * Extent rows are not immutable: a tree is rewritten in place. So a tree is still held from ONE
 * read, and a request wider than it holds reads the tree again, whole, under both requests: a tree
 * read in two parts could pair one write's realizations with another's identity rows.
 *
 * ## A write is what moves a held key
 *
 * Blob rows are immutable per key and leave only with their ledger row, so a key held with its
 * rows stays right for the run. What a run holds for a key that a write then fills (a key its read
 * did not cover, or one a harness pass added a pair to) is no longer what the store holds, so the
 * write forgets it, and the next ask reads it. An extent write rewrites its tree, so it forgets the
 * tree.
 */

import { appendAll, compareCodeUnits, VatError } from '@vibe-agent-toolkit/utils';

import { parseContentKey, type ContentKey } from '../content-key.js';
import { ReferenceSyntacticFormSchema, type ReferenceSyntacticForm } from '../schemas/projection-blobs.js';

import { compareRows } from './export.js';
import { EMPTY_STORED_TIER, emptyBlobRows, StoreRequestUnmetError, storedBlobTier, type StoredBlobTier } from './store-hydration.js';
import {
  ALL_BLOB_REQUEST,
  type BlobFactsWrite,
  type BlobRequest,
  type BlobScopedRows,
  type BlobScopedTableName,
  type ExtentKey,
  type ExtentRequest,
  type ExtentScopedRows,
  type ExtentScopedTableName,
  type FactStore,
} from './store.js';
import { PROJECTION_TABLES } from './table-registry.js';

/** The code of a blob tier that could not be read ({@link BlobTierReadError}): the store's refusal. */
export const PROJECTION_STORE_READ_FAILED_CODE = 'PROJECTION_STORE_READ_FAILED';

/**
 * The blob tier could not be read. The store's failure, never a file's: coded,
 * so the per-file read classifier cannot file it as a file's errno whatever the
 * store's own error carries, and the run refuses.
 */
class BlobTierReadError extends VatError {
  /** @param cause - What the store's blob read rejected with */
  constructor(cause: unknown) {
    super(
      PROJECTION_STORE_READ_FAILED_CODE,
      `The projection store's blob facts could not be read: ${cause instanceof Error ? cause.message : String(cause)}. `
        + 'The store is a cache: clear it (`vat cache clear`) or point VAT_CACHE_DIR elsewhere.',
      { cause },
    );
  }
}

/** The `blobReferences` table, the one whose rows a request narrows by form. */
const REFERENCES: BlobScopedTableName = 'blobReferences';

/** Every reference form. */
const EVERY_FORM: ReadonlySet<ReferenceSyntacticForm> = new Set(ReferenceSyntacticFormSchema.options);

/** The partitioned blob tables (registry `partitionColumn`): one unit, always read together. */
const HARNESS_TABLES: readonly BlobScopedTableName[] = Object.values(PROJECTION_TABLES)
  .filter((spec) => spec.scope === 'blob' && (spec as { readonly partitionColumn?: string }).partitionColumn !== undefined)
  .map((spec) => spec.key as BlobScopedTableName);

/** `blobReferences` rows in primary-key order: how a key holds them, however many reads they came from. */
const compareReferences = compareRows(PROJECTION_TABLES.blobReferences);

/** Rows by table, of any tables. */
type TableRows = Partial<Record<string, readonly Readonly<Record<string, unknown>>[]>>;

/**
 * What a run holds of one content key: the tables it holds (every table but `blobReferences`,
 * the harness tables always both or neither), the reference forms it holds, and their rows.
 */
interface HeldBlob {
  readonly tables: ReadonlySet<BlobScopedTableName>;
  readonly forms: ReadonlySet<ReferenceSyntacticForm>;
  readonly rows: TableRows;
}

/** A key held before any read: nothing. */
const NOTHING_HELD: HeldBlob = { tables: new Set(), forms: new Set(), rows: {} };

/**
 * A key a read found absent from the store's ledger: it holds every unit with no rows, so every
 * later request is answered with none and reads nothing, until a write forgets it.
 */
const ABSENT: HeldBlob = {
  tables: new Set(ALL_BLOB_REQUEST.tables.filter((table) => table !== REFERENCES)),
  forms: EVERY_FORM,
  rows: {},
};

/** What a run holds of one tree: the request its one read answered, and that read's rows, or `undefined` for a tree never written. */
interface HeldExtent {
  readonly request: ExtentRequest<ExtentScopedTableName>;
  readonly rows: TableRows | undefined;
}

/** One store's reads and writes for one run. */
export interface StoreReads {
  /**
   * The rows of `request` for `contentKeys`: of each key, only the units the run does not already
   * hold are read, and a key a read finds absent from the store answers with no rows.
   *
   * @param contentKeys - The keys
   * @param request - The tables and reference forms the caller reads
   * @returns Exactly the requested tables, and of `blobReferences` exactly the requested forms
   * @throws A {@link BlobTierReadError} when the store's read rejects
   * @throws A {@link StoreRequestUnmetError} when its answer lacks a requested table or its presence
   */
  blobs<Table extends BlobScopedTableName>(contentKeys: readonly ContentKey[], request: BlobRequest<Table>): Promise<Pick<BlobScopedRows, Table>>;
  /**
   * The rows of `request` for one tree, from one read, read only when the run does not already hold them.
   *
   * @param key - The tree
   * @param request - The tables and steps the caller reads
   * @returns Exactly the requested tables, or `undefined` for a tree never written
   */
  extent<Table extends ExtentScopedTableName>(key: ExtentKey, request: ExtentRequest<Table>): Promise<Pick<ExtentScopedRows, Table> | undefined>;
  /** {@link FactStore.writeBlobFacts} through the reader, forgetting what the write moves. @param write - The write */
  writeBlobs(write: BlobFactsWrite): Promise<void>;
  /** {@link FactStore.writeExtent} through the reader, forgetting the tree. @param key - The tree @param rows - Its rows */
  writeTree(key: ExtentKey, rows: ExtentScopedRows): Promise<void>;
}

/** A run's store reads, one {@link StoreReads} per store it reads. */
export interface RunStoredReads {
  /**
   * @param store - A store the run reads
   * @returns The run's reads of it: the same object for the same store
   */
  of(store: FactStore): StoreReads;
}

/**
 * The forms a request names.
 *
 * @param request - The request
 * @returns Its `blobReferences` forms, `'all'` expanded; none when it does not name the table
 */
function formsOf(request: BlobRequest<BlobScopedTableName>): ReadonlySet<ReferenceSyntacticForm> {
  if (!request.tables.includes(REFERENCES)) return new Set();
  return request.referenceForms === 'all' ? EVERY_FORM : request.referenceForms;
}

/**
 * Two requests as one: every table and every form either names.
 *
 * @param left - A request
 * @param right - Another
 * @returns Their union, its forms `'all'` when they are every form
 */
function unionOf(left: BlobRequest<BlobScopedTableName>, right: BlobRequest<BlobScopedTableName>): BlobRequest<BlobScopedTableName> {
  const forms = new Set([...formsOf(left), ...formsOf(right)]);
  return { tables: [...new Set([...left.tables, ...right.tables])], referenceForms: forms.size === EVERY_FORM.size ? 'all' : forms };
}

/**
 * The units of `request` a key does not hold, as the one request that reads them: a requested
 * harness table brings the other, so a `(key, harness)` pair's facts and imports come from one read.
 *
 * @param held - What the run holds of the key
 * @param request - What the caller reads
 * @returns The request for what is missing, its tables in the caller's order and its forms the
 *   caller's when it holds none of them, or `undefined` when the key holds every unit asked
 */
function missingFrom(held: HeldBlob, request: BlobRequest<BlobScopedTableName>): BlobRequest<BlobScopedTableName> | undefined {
  const asked = formsOf(request);
  const forms = new Set([...asked].filter((form) => !held.forms.has(form)));
  const tables = request.tables.flatMap((table) => {
    if (table === REFERENCES) return forms.size > 0 ? [REFERENCES] : [];
    return (HARNESS_TABLES.includes(table) ? HARNESS_TABLES : [table]).filter((unit) => !held.tables.has(unit));
  });
  if (tables.length === 0) return undefined;
  return { tables: [...new Set(tables)], referenceForms: forms.size === asked.size ? request.referenceForms : forms };
}

/**
 * What a present key holds after a read adds its units.
 *
 * @param held - What it held before
 * @param read - What the read asked for: units the key did not hold
 * @param rows - The read's rows of the key
 * @returns Both, `blobReferences` in primary-key order
 */
function heldAfter(held: HeldBlob, read: BlobRequest<BlobScopedTableName>, rows: TableRows): HeldBlob {
  const merged: TableRows = { ...held.rows };
  for (const table of read.tables) {
    const added = rows[table] ?? [];
    merged[table] = table === REFERENCES ? [...(held.rows[table] ?? []), ...added].sort(compareReferences) : added;
  }
  return {
    tables: new Set([...held.tables, ...read.tables.filter((table) => table !== REFERENCES)]),
    forms: new Set([...held.forms, ...formsOf(read)]),
    rows: merged,
  };
}

/**
 * A request's identity, so the keys read under the same request are read together.
 *
 * @param request - A request
 * @returns Its tables and forms, sorted
 */
function requestId(request: BlobRequest<BlobScopedTableName>): string {
  return `${[...request.tables].sort(compareCodeUnits).join(',')}|${[...formsOf(request)].sort(compareCodeUnits).join(',')}`;
}

/**
 * The column a blob-scoped table names its content key in: its first key column.
 *
 * @param table - A blob-scoped table
 * @returns The column
 */
function keyColumnOf(table: BlobScopedTableName): string {
  const [first] = PROJECTION_TABLES[table].primaryKey as readonly string[];
  if (first === undefined) throw new TypeError(`${table} declares no key column`);
  return first;
}

/**
 * Read the blob tier for `contentKeys`, a failed read rejecting as the store's
 * ({@link BlobTierReadError}), and an answer lacking a requested table or its
 * presence refused.
 *
 * @param store - The run's store
 * @param contentKeys - The keys to read
 * @param request - The tables and reference forms to read
 * @returns The tier's rows for them, in the requested tables, and those the ledger holds
 */
async function readBlobTier(
  store: FactStore,
  contentKeys: readonly ContentKey[],
  request: BlobRequest<BlobScopedTableName>,
): Promise<{ readonly rows: TableRows; readonly present: ReadonlySet<ContentKey> }> {
  const read = await store.readBlobFacts(contentKeys, request).catch((error: unknown) => {
    throw new BlobTierReadError(error);
  });
  // Typed as present, but a backend is code outside this module: hold it to the port.
  const present: unknown = read.present;
  if (!(present instanceof Set)) throw new StoreRequestUnmetError('blob', 'present', 'is absent from the answer, which must name the requested keys the ledger holds');
  const answered: TableRows = read.rows;
  const missing = request.tables.find((table) => answered[table] === undefined);
  if (missing !== undefined) throw new StoreRequestUnmetError('blob', missing, 'was requested and is absent from the stored rows');
  return { rows: answered, present: read.present };
}

/**
 * One read's rows, split by content key.
 *
 * @param request - What the read asked for
 * @param keys - The keys it read
 * @param rows - Its answer
 * @returns Each key's rows, every requested table present
 * @throws {BlobTierReadError} When a stored row's key column holds no content key: a damaged store
 */
function rowsByKey(request: BlobRequest<BlobScopedTableName>, keys: readonly ContentKey[], rows: TableRows): Map<ContentKey, Record<string, Readonly<Record<string, unknown>>[]>> {
  const byKey = new Map<ContentKey, Record<string, Readonly<Record<string, unknown>>[]>>();
  for (const key of keys) byKey.set(key, Object.fromEntries(request.tables.map((table) => [table, []])));
  for (const table of request.tables) {
    const column = keyColumnOf(table);
    for (const row of rows[table] ?? []) byKey.get(storedKeyOf(table, column, row))?.[table]?.push(row);
  }
  return byKey;
}

/**
 * The content key a stored row is filed under, read through the one parser: a boundary check on
 * the grouping column a blob read is split by, so a damaged store is refused rather than its rows
 * silently dropped. The row's other key columns are typed by the store, not parsed per row.
 *
 * @param table - The row's table
 * @param column - The table's key column
 * @param row - A row the store answered
 * @returns The key
 * @throws {BlobTierReadError} When the column holds no content key: a damaged store
 */
function storedKeyOf(table: BlobScopedTableName, column: string, row: Readonly<Record<string, unknown>>): ContentKey {
  const text = String(row[column]);
  const key = parseContentKey(text);
  if (key === undefined) throw new BlobTierReadError(new Error(`a stored ${table} row's ${column} is "${text}", not a content key`));
  return key;
}

/**
 * The keys a blob write may move, as their text: those its read did not cover, and those it
 * carries a harness pair for that its read did not settle. Every other key's stored rows are the
 * ones the run read. Text, because the write's rows are the run's own and are only matched
 * against the keys the run holds, never read back as keys.
 *
 * @param write - The write
 * @returns The texts of the keys whose held rows the write may make stale
 */
function keysMovedBy(write: BlobFactsWrite): ReadonlySet<string> {
  const covered = new Set<string>(write.coveredAtRead);
  const settled = new Set(write.settledAtRead.map((pair) => `${pair.contentKey}\0${pair.harness}`));
  const moved = new Set<string>();
  const rows = write.rows as unknown as TableRows;
  for (const spec of Object.values(PROJECTION_TABLES).filter((candidate) => candidate.scope === 'blob')) {
    const table = spec.key as BlobScopedTableName;
    const column = keyColumnOf(table);
    const partition = (spec as { readonly partitionColumn?: string }).partitionColumn;
    for (const row of rows[table] ?? []) {
      const key = String(row[column]);
      if (!covered.has(key) || (partition !== undefined && !settled.has(`${key}\0${String(row[partition])}`))) moved.add(key);
    }
  }
  return moved;
}

/**
 * The rows a caller asked for, out of what the keys hold.
 *
 * @param held - What the run holds, by key
 * @param keys - The caller's keys, each held
 * @param request - What the caller reads
 * @returns The requested tables, and of `blobReferences` the requested forms, in key order
 */
function answerOf(held: ReadonlyMap<string, HeldBlob>, keys: readonly ContentKey[], request: BlobRequest<BlobScopedTableName>): TableRows {
  const forms = formsOf(request);
  const answer: Record<string, Readonly<Record<string, unknown>>[]> = {};
  for (const table of request.tables) {
    const rows: Readonly<Record<string, unknown>>[] = [];
    for (const key of keys) {
      const keyRows = held.get(key)?.rows[table] ?? [];
      appendAll(rows, table === REFERENCES ? keyRows.filter((row) => forms.has(row['syntacticForm'] as ReferenceSyntacticForm)) : keyRows);
    }
    answer[table] = rows;
  }
  return answer;
}

/**
 * A tree's held rows narrowed to a request.
 *
 * @param rows - What the tree holds
 * @param request - What the caller reads
 * @returns The requested tables
 */
function pickTables(rows: TableRows, request: ExtentRequest<ExtentScopedTableName>): TableRows {
  return Object.fromEntries(request.tables.map((table) => [table, rows[table] ?? []]));
}

/**
 * Whether what the run holds of a tree answers a request: every table it asks for. A request's
 * steps are not compared: the store reads tables and runs no step (`selectRequestedRows` runs them
 * over what the read returns, caller-side), so the same tables read under other steps are the same
 * rows.
 *
 * @param held - What the run holds of the tree
 * @param request - What the caller reads
 * @returns True when no read is needed
 */
function holdsExtent(held: HeldExtent, request: ExtentRequest<ExtentScopedTableName>): boolean {
  return request.tables.every((table) => held.request.tables.includes(table));
}

/**
 * The one request a tree is read under: what it held, and what is now asked.
 *
 * @param held - What the run holds of the tree, if anything
 * @param request - What the caller reads
 * @returns Both, as one request
 */
function widenedExtentRequest(held: HeldExtent | undefined, request: ExtentRequest<ExtentScopedTableName>): ExtentRequest<ExtentScopedTableName> {
  if (held === undefined) return request;
  return {
    tables: [...new Set([...held.request.tables, ...request.tables])],
    steps: [...new Set([...held.request.steps, ...request.steps])],
  };
}

/**
 * Read, for each key, the units of `request` it does not hold: one read per group of keys missing
 * the same units. A key the read finds present adds them to what it holds; a key it finds absent
 * drops what it held and is held {@link ABSENT}.
 *
 * @param store - The store
 * @param blobs - What the run holds, by key: updated in place
 * @param keys - The caller's keys
 * @param request - What the caller reads
 */
async function readMissingUnits(store: FactStore, blobs: Map<ContentKey, HeldBlob>, keys: readonly ContentKey[], request: BlobRequest<BlobScopedTableName>): Promise<void> {
  const pending = new Map<string, { readonly request: BlobRequest<BlobScopedTableName>; readonly keys: ContentKey[] }>();
  for (const key of keys) {
    const missing = missingFrom(blobs.get(key) ?? NOTHING_HELD, request);
    if (missing === undefined) continue;
    const id = requestId(missing);
    const group = pending.get(id) ?? { request: missing, keys: [] };
    group.keys.push(key);
    pending.set(id, group);
  }
  const reads = await Promise.all([...pending.values()].map(async (group) => ({ group, read: await readBlobTier(store, group.keys, group.request) })));
  for (const { group, read } of reads) {
    for (const [key, rows] of rowsByKey(group.request, group.keys, read.rows)) {
      blobs.set(key, read.present.has(key) ? heldAfter(blobs.get(key) ?? NOTHING_HELD, group.request, rows) : ABSENT);
    }
  }
}

/**
 * One store's reads and writes for one run.
 *
 * @param store - The store
 * @returns Its reads
 */
function storeReads(store: FactStore): StoreReads {
  const blobs = new Map<ContentKey, HeldBlob>();
  const extents = new Map<string, HeldExtent>();
  const extentId = (key: ExtentKey): string => `${key.rootId}\0${key.treeHash}`;
  return {
    blobs: async <Table extends BlobScopedTableName>(contentKeys: readonly ContentKey[], request: BlobRequest<Table>) => {
      const keys = [...new Set(contentKeys)];
      await readMissingUnits(store, blobs, keys, request);
      return answerOf(blobs, keys, request) as unknown as Pick<BlobScopedRows, Table>;
    },
    extent: async <Table extends ExtentScopedTableName>(key: ExtentKey, request: ExtentRequest<Table>) => {
      const id = extentId(key);
      let held = extents.get(id);
      const wanted = request as unknown as ExtentRequest<ExtentScopedTableName>;
      if (held === undefined || !holdsExtent(held, wanted)) {
        const read = widenedExtentRequest(held, wanted);
        held = { request: read, rows: (await store.readExtent(key, read)) as TableRows | undefined };
        extents.set(id, held);
      }
      return held.rows === undefined ? undefined : (pickTables(held.rows, wanted) as unknown as Pick<ExtentScopedRows, Table>);
    },
    writeBlobs: async (write) => {
      await store.writeBlobFacts(write);
      const moved = keysMovedBy(write);
      for (const key of blobs.keys()) if (moved.has(key)) blobs.delete(key);
    },
    writeTree: async (key, rows) => {
      await store.writeExtent(key, rows);
      extents.delete(extentId(key));
    },
  };
}

/**
 * A run's store reads: one {@link StoreReads} per store, made on its first use.
 *
 * @returns The run's reads
 */
export function runStoredReads(): RunStoredReads {
  const byStore = new Map<FactStore, StoreReads>();
  return {
    of: (store) => {
      let reads = byStore.get(store);
      if (reads === undefined) {
        reads = storeReads(store);
        byStore.set(store, reads);
      }
      return reads;
    },
  };
}

/**
 * The stored blob tier one population reads: a hit's keys under the hit's request, the
 * derivation's base keys, and any key a demand promotion added, judged together.
 */
export interface StoredTierReads {
  /** Every key asked so far, as one tier. */
  current(): StoredBlobTier;
  /**
   * Ask for `request` of `contentKeys`, through the run's reads.
   *
   * @param contentKeys - The keys the caller now holds
   * @param request - The tables and reference forms the caller consumes
   * @returns Every key asked so far, as one tier: each key's rows under every request asked of it
   */
  cover(contentKeys: readonly ContentKey[], request: BlobRequest<BlobScopedTableName>): Promise<StoredBlobTier>;
}

/**
 * The tier one population reads, over the run's reads of its store.
 *
 * @param reads - The run's reads of the population's store, or undefined for a population with
 *   none (or that parses no content): nothing is read
 * @returns The population's tier
 */
export function storedTierReads(reads: StoreReads | undefined): StoredTierReads {
  const asked = new Map<ContentKey, BlobRequest<BlobScopedTableName>>();
  let tier = EMPTY_STORED_TIER;
  return {
    current: () => tier,
    cover: async (contentKeys, request) => {
      if (reads === undefined) return tier;
      for (const key of contentKeys) {
        const before = asked.get(key);
        asked.set(key, before === undefined ? request : unionOf(before, request));
      }
      const groups = new Map<string, { readonly request: BlobRequest<BlobScopedTableName>; readonly keys: ContentKey[] }>();
      for (const [key, keyRequest] of asked) {
        const id = requestId(keyRequest);
        const group = groups.get(id) ?? { request: keyRequest, keys: [] };
        group.keys.push(key);
        groups.set(id, group);
      }
      const answers = await Promise.all([...groups.values()].map((group) => reads.blobs(group.keys, group.request)));
      const rows: Record<string, Readonly<Record<string, unknown>>[]> = { ...(emptyBlobRows() as unknown as Record<string, Readonly<Record<string, unknown>>[]>) };
      for (const answer of answers) {
        for (const [table, tableRows] of Object.entries(answer as TableRows)) rows[table] = [...(rows[table] ?? []), ...(tableRows ?? [])];
      }
      // The one predicate, over every key asked: a key's coverage is judged on all its rows.
      tier = storedBlobTier(rows as unknown as BlobScopedRows, [...asked.keys()]);
      return tier;
    },
  };
}
