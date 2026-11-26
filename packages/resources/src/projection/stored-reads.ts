/**
 * The one way a run reads and writes its fact store: every population and lens of a run reads the
 * store through its `PopulationRun.stored`, so a stored row is decoded once per run, whichever
 * population asked first. Nothing else calls the port's reads or writes
 * (`local/fact-store-access-boundary`).
 *
 * ## A key's blob rows are held per unit, one read per unit, each read with the key's presence
 *
 * The run holds a content key's blob rows in UNITS: one per non-partitioned table, one per
 * reference form of `blobReferences`, and one for the two harness tables together. Each unit of a
 * key holds ONE promise of its rows, registered, in flight or settled, before the request that
 * reads it awaits anything. A request reads, for each key, only the units with no promise yet, and
 * awaits the promise of every unit it asks for: overlapping callers share one read per unit, a
 * repeated request reads nothing, and no row is decoded twice in a run. A read that rejects
 * withdraws the promises it registered, so a later request reads those units again. Every read
 * returns, in the rows' own transaction, which of its keys the ledger holds (`present`).
 *
 * Joining units from several reads is sound because blob rows are a function of the key under one
 * VAT version and leave the store only with the key's ledger row: an evict-and-rewrite files the
 * same rows again. So every read that finds the key present returns rows of the same set, and the
 * one hazard is a read that finds it gone. A key any read finds absent is absent for the rest of
 * the run, whichever read settles last: every request is answered with no rows for it and reads
 * nothing, and no read that finds it present, whenever it began, revives it. Only a write that
 * moves the key forgets that. Without the check, an eviction between two reads would leave the
 * key judged covered on its first read's rows (the coverage predicate reads no lexical reference)
 * with its second read's rows missing. A key's `blobReferences` rows are answered in primary-key
 * order, so rows joined from several reads equal one whole read's.
 *
 * Row sets are held by the same engine, over a tier descriptor (`HeldTier`): a row set
 * (`RowSetId`) is held per table, each table one unit (row-set tables are never partitioned), and
 * every read of a row set also reads its instance's head table when it is not yet held, so its
 * ledger presence is read beside every table. A row set a read finds absent is forgotten whole,
 * sticky for the run, exactly as a key is. An answer is joined across ids and reads, so each table
 * is answered in primary-key order. `forgetRowSets` forgets ids a copy found evicted.
 *
 * The harness tables are one unit per key, not per `(key, harness)` pair: a pair's facts and
 * imports must come from one read, and the pairs are derived lazily. A pair the store gains after
 * the key's harness read is not held: the harness pass finds it unsettled and derives it, and its
 * write forgets the key.
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
 * write forgets it, absence included, and the next ask reads it. A row-set write forgets every row
 * set it holds a head row of that its read did not cover. A read still in flight for a
 * forgotten key settles into what the run no longer holds. An extent write rewrites its tree, so it
 * forgets the tree.
 */

import { appendAll, compareCodeUnits, VatError } from '@vibe-agent-toolkit/utils';

import { parseContentKey, type ContentKey } from '../content-key.js';
import { ReferenceSyntacticFormSchema, type ReferenceSyntacticForm } from '../schemas/projection-blobs.js';
import type { DataVariant } from '../schemas/projection-data.js';

import { isProjectionTable, isRowSetTable, storedRelationSpecs } from './derived-table-registry.js';
import { compareRows, type RowComparator } from './export.js';
import { rowSetIdText, type RowSetId } from './row-set-id.js';
import { ROW_SET_TABLES, type RowSetRows, type RowSetTableName } from './row-set-table-registry.js';
import {
  EMPTY_STORED_TIER,
  emptyBlobRows,
  heldRowSetIds,
  rowSetHeadTableOf,
  StoreRequestUnmetError,
  storedBlobTier,
  type StoredBlobTier,
} from './store-hydration.js';
import {
  type BlobFactsWrite,
  type BlobRequest,
  type BlobScopedRows,
  type BlobScopedTableName,
  type ExtentKey,
  type ExtentRequest,
  type ExtentScopedRows,
  type ExtentScopedTableName,
  type FactStore,
  type RowSetRequest,
  type RowSetWrite,
} from './store.js';
import { PROJECTION_TABLES } from './table-registry.js';

/** The code of a stored tier that could not be read ({@link StoreTierReadError}): the store's refusal. */
export const PROJECTION_STORE_READ_FAILED_CODE = 'PROJECTION_STORE_READ_FAILED';

/** A stored tier the reader holds per unit: content-keyed blob facts, or row sets. */
type HeldTierName = 'blob' | 'rowSet';

/** What each held tier holds, and what it identifies its rows by, in a message. */
const TIER_NOUNS: Readonly<Record<HeldTierName, { readonly facts: string; readonly ids: string }>> = {
  blob: { facts: 'blob facts', ids: 'keys' },
  rowSet: { facts: 'row sets', ids: 'row sets' },
};

/**
 * A stored tier could not be read. The store's failure, never a file's: coded,
 * so the per-file read classifier cannot file it as a file's errno whatever the
 * store's own error carries, and the run refuses.
 */
class StoreTierReadError extends VatError {
  /**
   * @param tier - The tier whose read failed
   * @param cause - What the store's read rejected with
   */
  constructor(tier: HeldTierName, cause: unknown) {
    super(
      PROJECTION_STORE_READ_FAILED_CODE,
      `The projection store's ${TIER_NOUNS[tier].facts} could not be read: ${cause instanceof Error ? cause.message : String(cause)}. `
        + 'The store is a cache: clear it (`vat cache clear`) or point VAT_CACHE_DIR elsewhere.',
      { cause },
    );
  }
}

/** The `blobReferences` table, the one whose rows a request narrows by form. */
const REFERENCES: BlobScopedTableName = 'blobReferences';

/** Every reference form. */
const EVERY_FORM: ReadonlySet<ReferenceSyntacticForm> = new Set(ReferenceSyntacticFormSchema.options);

/** The blob-scoped tables' registry entries. */
const BLOB_SPECS = storedRelationSpecs().filter(isProjectionTable).filter((spec) => spec.scope === 'blob');

/** The partitioned blob tables (registry `partitionColumn`): one unit, always read together. */
const HARNESS_TABLES: readonly BlobScopedTableName[] = BLOB_SPECS
  .filter((spec) => (spec as { readonly partitionColumn?: string }).partitionColumn !== undefined)
  .map((spec) => spec.key as BlobScopedTableName);

/** `blobReferences` rows in primary-key order: how a key holds them, however many reads they came from. */
const compareReferences = compareRows(PROJECTION_TABLES.blobReferences);

/** Each row-set table's primary-key order: how an answer holds its rows, however many reads they came from. */
const ROW_SET_ORDER: ReadonlyMap<string, RowComparator> = new Map(
  storedRelationSpecs().filter(isRowSetTable).map((spec) => [spec.key, compareRows(spec)] as const),
);

/** One stored row, of any table. */
type Row = Readonly<Record<string, unknown>>;

/** Rows by table, of any tables. */
type TableRows = Partial<Record<string, readonly Row[]>>;

/**
 * One unit an identity's rows are held in: whole tables, or, of a blob key, one reference form of
 * `blobReferences`.
 */
interface HeldUnit {
  readonly id: string;
  readonly tables: readonly string[];
  /** The one form of `blobReferences` it holds, or `undefined` for a unit of whole tables. */
  readonly form: ReferenceSyntacticForm | undefined;
}

/** The harness tables, one unit per key. */
const HARNESS_UNIT: HeldUnit = { id: 'harness', tables: HARNESS_TABLES, form: undefined };

/**
 * What a run holds of one identity (a content key, or a row set): a promise of each unit's rows,
 * in flight or settled, and whether any read found it absent from the ledger (sticky until a write
 * or the lane forgets it).
 */
interface HeldIdentity {
  absent: boolean;
  readonly units: Map<string, Promise<TableRows>>;
}

/**
 * One stored tier the reader holds per unit: how its ids, requests and units are named, and how
 * the port reads it. Blob keys and row sets are held by the one engine below, over this.
 */
interface HeldTier<Id, Request> {
  readonly name: HeldTierName;
  /** @returns An id as the text the run holds it under */
  textOf(id: Id): string;
  /** @returns The tables a request reads */
  tablesOf(request: Request): readonly string[];
  /** @returns The units a request asks for, each once */
  unitsOf(request: Request): readonly HeldUnit[];
  /** @returns The one request reading the units of `request` an identity holds no promise of, or `undefined` when it holds them all */
  missingFrom(held: HeldIdentity, request: Request): Request | undefined;
  /** @returns A request's identity, so the ids read under the same request are read together */
  requestId(request: Request): string;
  /** @returns The port's answer for `ids` under `request` */
  read(store: FactStore, ids: readonly Id[], request: Request): Promise<{ readonly rows: unknown; readonly present: unknown }>;
  /** @returns The text of the identity a stored row is filed under @throws {StoreTierReadError} for a damaged row */
  identityOfRow(table: string, row: Row): string;
  /** @returns The order an identity holds a table's rows in when they may come from several reads, or `undefined` when they never do */
  heldOrder(table: string): RowComparator | undefined;
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
   * @throws A {@link StoreTierReadError} when the store's read rejects
   * @throws A {@link StoreRequestUnmetError} when its answer lacks a requested table or its presence
   */
  blobs<Table extends BlobScopedTableName>(contentKeys: readonly ContentKey[], request: BlobRequest<Table>): Promise<Pick<BlobScopedRows, Table>>;
  /**
   * The rows of `request` for some row sets: each table of a row set is held from one read, and a
   * request reads only the tables the run does not already hold, always with the instance's head
   * table, so a row set's presence is read beside every table read of it. A row set a read finds
   * absent from the ledger is forgotten whole: it answers no rows in any table, for the rest of the
   * run, until a write moves it or {@link StoreReads.forgetRowSets} forgets it.
   *
   * @param ids - The row sets
   * @param request - The tables the caller reads
   * @returns Exactly the requested tables, each in primary-key order
   * @throws A {@link StoreTierReadError} when the store's read rejects
   * @throws A {@link StoreRequestUnmetError} when its answer lacks a requested table or its presence
   */
  rowSets<Table extends RowSetTableName>(ids: readonly RowSetId[], request: RowSetRequest<Table>): Promise<Pick<RowSetRows, Table>>;
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
  /**
   * {@link FactStore.writeRowSets} through the reader, forgetting what the write moves: every row
   * set it holds (a head row of) that was not covered at read. Not named `writeRowSets`: the access
   * boundary matches port members by spelling, and this is the reader's member, not the port's.
   *
   * @param write - The write
   */
  writeSets(write: RowSetWrite): Promise<void>;
  /**
   * Forget what the run holds of some row sets, absence included, so the next request reads them
   * again: the lane's answer to a copy that found them evicted.
   *
   * @param ids - The row sets
   */
  forgetRowSets(ids: readonly RowSetId[]): void;
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
 * The unit of one whole table.
 *
 * @param table - The table
 * @returns Its unit
 */
function tableUnit(table: string): HeldUnit {
  return { id: table, tables: [table], form: undefined };
}

/**
 * The unit a blob table other than `blobReferences` is held in.
 *
 * @param table - The table
 * @returns The harness unit for a harness table, else the table's own
 */
function unitOfTable(table: BlobScopedTableName): HeldUnit {
  return HARNESS_TABLES.includes(table) ? HARNESS_UNIT : tableUnit(table);
}

/**
 * The unit one reference form is held in.
 *
 * @param form - The form
 * @returns Its unit of `blobReferences`
 */
function unitOfForm(form: ReferenceSyntacticForm): HeldUnit {
  return { id: `${REFERENCES}\0${form}`, tables: [REFERENCES], form };
}

/**
 * The units a blob request asks for.
 *
 * @param request - The request
 * @returns Each unit once
 */
function blobUnitsOf(request: BlobRequest<BlobScopedTableName>): HeldUnit[] {
  const units = new Map<string, HeldUnit>();
  for (const table of request.tables) {
    for (const unit of table === REFERENCES ? [...formsOf(request)].map((form) => unitOfForm(form)) : [unitOfTable(table)]) units.set(unit.id, unit);
  }
  return [...units.values()];
}

/**
 * The units of a blob request a key holds no promise of, as the one request that reads them: a
 * requested harness table brings the other, so a `(key, harness)` pair's facts and imports come
 * from one read.
 *
 * @param held - What the run holds of the key
 * @param request - What the caller reads
 * @returns The request for what is missing, its tables in the caller's order and its forms the
 *   caller's when it holds none of them, or `undefined` when the key holds every unit asked
 */
function blobsMissingFrom(held: HeldIdentity, request: BlobRequest<BlobScopedTableName>): BlobRequest<BlobScopedTableName> | undefined {
  const asked = formsOf(request);
  const forms = new Set([...asked].filter((form) => !held.units.has(unitOfForm(form).id)));
  const tables = request.tables.flatMap((table) => {
    if (table === REFERENCES) return forms.size > 0 ? [REFERENCES] : [];
    const unit = unitOfTable(table);
    return held.units.has(unit.id) ? [] : (unit.tables as readonly BlobScopedTableName[]);
  });
  if (tables.length === 0) return undefined;
  return { tables: [...new Set(tables)], referenceForms: forms.size === asked.size ? request.referenceForms : forms };
}

/**
 * One unit's rows out of one identity's rows.
 *
 * @param unit - The unit
 * @param rows - The identity's rows, by table, from a read that asked for the unit
 * @returns The unit's tables, of `blobReferences` only its form
 */
function rowsOfUnit(unit: HeldUnit, rows: Readonly<Record<string, readonly Row[]>> | undefined): TableRows {
  return Object.fromEntries(unit.tables.map((table) => {
    const tableRows = rows?.[table] ?? [];
    return [table, unit.form === undefined ? tableRows : tableRows.filter((row) => row['syntacticForm'] === unit.form)];
  }));
}

/**
 * A blob request's identity, so the keys read under the same request are read together.
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
 * The content key a stored row is filed under, read through the one parser: a boundary check on
 * the grouping column a read is split by, so a damaged store is refused rather than its rows
 * silently dropped. The row's other key columns are typed by the store, not parsed per row.
 *
 * @param tier - The tier the row was read from
 * @param table - The row's table
 * @param column - The table's content key column
 * @param row - A row the store answered
 * @returns The key
 * @throws {StoreTierReadError} When the column holds no content key: a damaged store
 */
function storedKeyOf(tier: HeldTierName, table: string, column: string, row: Row): ContentKey {
  const text = String(row[column]);
  const key = parseContentKey(text);
  if (key === undefined) throw new StoreTierReadError(tier, new Error(`a stored ${table} row's ${column} is "${text}", not a content key`));
  return key;
}

/** The blob tier: content keys, held per table, per reference form, and the harness tables together. */
const BLOB_TIER: HeldTier<ContentKey, BlobRequest<BlobScopedTableName>> = {
  name: 'blob',
  textOf: (key) => key,
  tablesOf: (request) => request.tables,
  unitsOf: blobUnitsOf,
  missingFrom: blobsMissingFrom,
  requestId,
  read: (store, keys, request) => store.readBlobFacts(keys, request),
  identityOfRow: (table, row) => storedKeyOf('blob', table, keyColumnOf(table as BlobScopedTableName), row),
  heldOrder: (table) => (table === REFERENCES ? compareReferences : undefined),
};

/** The column every row-set table names its content key in. */
const ROW_SET_KEY_COLUMN = 'blob';

/** The row-set tier: row sets, each table one unit (row-set tables are never partitioned). */
const ROW_SET_TIER: HeldTier<RowSetId, RowSetRequest<RowSetTableName>> = {
  name: 'rowSet',
  textOf: (id) => rowSetIdText(id),
  tablesOf: (request) => request.tables,
  unitsOf: (request) => request.tables.map((table) => tableUnit(table)),
  missingFrom: (held, request) => {
    const tables = request.tables.filter((table) => !held.units.has(table));
    return tables.length === 0 ? undefined : { tables };
  },
  requestId: (request) => [...request.tables].sort(compareCodeUnits).join(','),
  read: (store, ids, request) => store.readRowSets(ids, request),
  identityOfRow: (table, row) => rowSetIdText({
    contentKey: storedKeyOf('rowSet', table, ROW_SET_KEY_COLUMN, row),
    instance: ROW_SET_TABLES[table as RowSetTableName].instance,
    variant: String(row['variant']) as DataVariant,
  }),
  // Each table of a row set is one unit, so it comes from one read.
  heldOrder: () => undefined,
};

/**
 * Read a tier for `ids`, a failed read rejecting as the store's ({@link StoreTierReadError}), and
 * an answer lacking a requested table or its presence refused.
 *
 * @param tier - The tier
 * @param store - The run's store
 * @param ids - The ids to read
 * @param request - What to read
 * @returns The tier's rows for them, in the requested tables, and the texts of those the ledger holds
 */
async function readTier<Id, Request>(
  tier: HeldTier<Id, Request>,
  store: FactStore,
  ids: readonly Id[],
  request: Request,
): Promise<{ readonly rows: TableRows; readonly present: ReadonlySet<string> }> {
  const read = await tier.read(store, ids, request).catch((error: unknown) => {
    throw new StoreTierReadError(tier.name, error);
  });
  // Typed as present, but a backend is code outside this module: hold it to the port.
  const present = read.present;
  if (!(present instanceof Set)) {
    throw new StoreRequestUnmetError(tier.name, 'present', `is absent from the answer, which must name the requested ${TIER_NOUNS[tier.name].ids} the ledger holds`);
  }
  const answered = read.rows as TableRows;
  const missing = tier.tablesOf(request).find((table) => answered[table] === undefined);
  if (missing !== undefined) throw new StoreRequestUnmetError(tier.name, missing, 'was requested and is absent from the stored rows');
  return { rows: answered, present: present as ReadonlySet<string> };
}

/**
 * One read's rows, split by identity.
 *
 * @param tier - The tier read
 * @param request - What the read asked for
 * @param texts - The identities it read, as text
 * @param rows - Its answer
 * @returns Each identity's rows, every requested table present
 * @throws {StoreTierReadError} When a stored row names no identity: a damaged store
 */
function rowsByIdentity<Id, Request>(tier: HeldTier<Id, Request>, request: Request, texts: readonly string[], rows: TableRows): Map<string, Record<string, Row[]>> {
  const tables = tier.tablesOf(request);
  const byIdentity = new Map<string, Record<string, Row[]>>();
  for (const text of texts) byIdentity.set(text, Object.fromEntries(tables.map((table) => [table, []])));
  for (const table of tables) {
    for (const row of rows[table] ?? []) byIdentity.get(tier.identityOfRow(table, row))?.[table]?.push(row);
  }
  return byIdentity;
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
  for (const spec of BLOB_SPECS) {
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
 * One identity's rows out of its units' settled rows.
 *
 * @param tier - The tier
 * @param held - What the run holds of the identity
 * @param units - The settled rows of each unit the caller asked for
 * @returns Their rows by table, each table the tier joins from several reads in its order; none
 *   for an identity a read found absent
 */
function identityRowsOf<Id, Request>(tier: HeldTier<Id, Request>, held: HeldIdentity, units: readonly TableRows[]): TableRows {
  if (held.absent) return {};
  const merged: Record<string, Row[]> = {};
  for (const unitRows of units) {
    for (const [table, rows] of Object.entries(unitRows)) merged[table] = [...(merged[table] ?? []), ...(rows ?? [])];
  }
  for (const [table, rows] of Object.entries(merged)) {
    const order = tier.heldOrder(table);
    if (order !== undefined) rows.sort(order);
  }
  return merged;
}

/**
 * The rows a caller asked for, out of each identity's rows.
 *
 * @param identityRows - Each of the caller's identities' rows, in the caller's order
 * @param tables - The tables the caller reads
 * @returns Exactly those tables, in the caller's order
 */
function answerOf(identityRows: readonly TableRows[], tables: readonly string[]): Record<string, Row[]> {
  const answer: Record<string, Row[]> = {};
  for (const table of tables) {
    const rows: Row[] = [];
    for (const held of identityRows) appendAll(rows, held[table] ?? []);
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

/** What a run holds of one tree: the request its one read answered, and that read's rows, or `undefined` for a tree never written. */
interface HeldExtent {
  readonly request: ExtentRequest<ExtentScopedTableName>;
  readonly rows: TableRows | undefined;
}

/** One group read's answer, split by identity: which the ledger holds, and each one's rows. */
interface GroupRead {
  readonly present: ReadonlySet<string>;
  readonly byIdentity: ReadonlyMap<string, Readonly<Record<string, readonly Row[]>>>;
}

/**
 * Register an identity's promise of one unit's rows from a group read: settling, it marks the
 * identity absent when the read finds it so; rejecting, it withdraws itself, so a later request
 * reads the unit again.
 *
 * @param text - The identity, as text
 * @param held - What the run holds of it: updated in place
 * @param unit - A unit the read asks for that the identity holds no promise of
 * @param read - The group read
 */
function registerUnit(text: string, held: HeldIdentity, unit: HeldUnit, read: Promise<GroupRead>): void {
  const rows = read.then(({ present, byIdentity }) => {
    if (!present.has(text)) held.absent = true;
    return rowsOfUnit(unit, byIdentity.get(text));
  });
  held.units.set(unit.id, rows);
  rows.catch(() => {
    if (held.units.get(unit.id) === rows) held.units.delete(unit.id);
  });
}

/** One identity a caller asks for: the id, and what the run holds of it. */
interface AskedIdentity<Id> {
  readonly id: Id;
  readonly held: HeldIdentity;
}

/**
 * Start, for each identity, the read of the units of `request` it holds no promise of: one read
 * per group of identities missing the same units, each unit's promise registered before anything
 * is awaited. An identity a read found absent reads nothing.
 *
 * @param tier - The tier
 * @param store - The store
 * @param asked - Each of the caller's identities, by text: their held state updated in place
 * @param request - What the caller reads
 */
function readMissingUnits<Id, Request>(tier: HeldTier<Id, Request>, store: FactStore, asked: ReadonlyMap<string, AskedIdentity<Id>>, request: Request): void {
  const groups = new Map<string, { readonly request: Request; readonly members: [string, AskedIdentity<Id>][] }>();
  for (const [text, member] of asked) {
    const missing = member.held.absent ? undefined : tier.missingFrom(member.held, request);
    if (missing === undefined) continue;
    const id = tier.requestId(missing);
    const group = groups.get(id) ?? { request: missing, members: [] };
    group.members.push([text, member]);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    const texts = group.members.map(([text]) => text);
    const read = readTier(tier, store, group.members.map(([, member]) => member.id), group.request)
      .then(({ rows, present }) => ({ present, byIdentity: rowsByIdentity(tier, group.request, texts, rows) }));
    const units = tier.unitsOf(group.request);
    for (const [text, member] of group.members) for (const unit of units) registerUnit(text, member.held, unit, read);
  }
}

/**
 * One identity's rows of the units a caller asks for, once every unit's read has settled.
 *
 * @param tier - The tier
 * @param held - What the run holds of the identity, every unit asked registered unless it is absent
 * @param units - The units the caller asks for
 * @returns Its rows, none when a read found it absent
 */
async function settledRowsOf<Id, Request>(tier: HeldTier<Id, Request>, held: HeldIdentity, units: readonly HeldUnit[]): Promise<TableRows> {
  const pending = held.absent ? [] : units.map((unit) => {
    const rows = held.units.get(unit.id);
    if (rows === undefined) throw new TypeError(`the stored ${tier.name} unit ${unit.id} was asked and never registered`);
    return rows;
  });
  return identityRowsOf(tier, held, await Promise.all(pending));
}

/** What a run holds of one tier of one store, per identity, per unit. */
interface HeldReads<Id, Request> {
  /**
   * @param ids - The caller's ids
   * @param request - What the caller reads
   * @returns Each distinct identity's rows of the request's units, in first-asked order
   */
  rowsOf(ids: readonly Id[], request: Request): Promise<TableRows[]>;
  /** @param texts - Identities, as text, whose held state (absence included) to forget */
  forget(texts: Iterable<string>): void;
}

/**
 * The one held-unit engine, over one tier of one store.
 *
 * @param tier - The tier
 * @param store - The store
 * @returns What the run holds of the tier
 */
function heldReads<Id, Request>(tier: HeldTier<Id, Request>, store: FactStore): HeldReads<Id, Request> {
  const held = new Map<string, HeldIdentity>();
  const heldOf = (text: string): HeldIdentity => {
    let identity = held.get(text);
    if (identity === undefined) {
      identity = { absent: false, units: new Map() };
      held.set(text, identity);
    }
    return identity;
  };
  return {
    rowsOf: (ids, request) => {
      const asked = new Map<string, AskedIdentity<Id>>();
      for (const id of ids) {
        const text = tier.textOf(id);
        if (!asked.has(text)) asked.set(text, { id, held: heldOf(text) });
      }
      readMissingUnits(tier, store, asked, request);
      const units = tier.unitsOf(request);
      return Promise.all([...asked.values()].map((member) => settledRowsOf(tier, member.held, units)));
    },
    forget: (texts) => {
      for (const text of texts) held.delete(text);
    },
  };
}

/**
 * A row-set request as the reader reads it: the caller's tables, and the head table of every
 * instance it reads.
 *
 * @param ids - The row sets
 * @param request - What the caller reads
 * @returns The request the reader reads under
 */
function withHeadTables(ids: readonly RowSetId[], request: RowSetRequest<RowSetTableName>): RowSetRequest<RowSetTableName> {
  const heads = ids.map((id) => rowSetHeadTableOf(id.instance));
  return { tables: [...new Set<RowSetTableName>([...heads, ...request.tables])] };
}

/**
 * A row-set answer in primary-key order, table by table.
 *
 * @param answer - Rows by table, joined in the caller's id order: sorted in place
 * @returns The answer
 */
function inPrimaryKeyOrder(answer: Record<string, Row[]>): Record<string, Row[]> {
  for (const [table, rows] of Object.entries(answer)) {
    const order = ROW_SET_ORDER.get(table);
    if (order === undefined) throw new TypeError(`${table} is not a row-set table`);
    rows.sort(order);
  }
  return answer;
}

/**
 * One store's reads and writes for one run.
 *
 * @param store - The store
 * @returns Its reads
 */
function storeReads(store: FactStore): StoreReads {
  const blobUnits = heldReads(BLOB_TIER, store);
  const rowSetUnits = heldReads(ROW_SET_TIER, store);
  const extents = new Map<string, HeldExtent>();
  const extentId = (key: ExtentKey): string => `${key.rootId}\0${key.treeHash}`;
  return {
    blobs: async <Table extends BlobScopedTableName>(contentKeys: readonly ContentKey[], request: BlobRequest<Table>) => {
      const keyRows = await blobUnits.rowsOf(contentKeys, request);
      return answerOf(keyRows, request.tables) as unknown as Pick<BlobScopedRows, Table>;
    },
    rowSets: async <Table extends RowSetTableName>(ids: readonly RowSetId[], request: RowSetRequest<Table>) => {
      const idRows = await rowSetUnits.rowsOf(ids, withHeadTables(ids, request));
      return inPrimaryKeyOrder(answerOf(idRows, request.tables)) as unknown as Pick<RowSetRows, Table>;
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
      blobUnits.forget(keysMovedBy(write));
    },
    writeSets: async (write) => {
      await store.writeRowSets(write);
      const covered = new Set<string>(write.coveredAtRead.map((id) => rowSetIdText(id)));
      rowSetUnits.forget([...heldRowSetIds(write.rows)].filter((text) => !covered.has(text)));
    },
    forgetRowSets: (ids) => {
      rowSetUnits.forget(ids.map((id) => rowSetIdText(id)));
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
