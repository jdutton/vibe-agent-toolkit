/**
 * The `data` instance's stage: route a run's realizations to JSON and JSONC row sets, serve each
 * from the row-set tier or extract it, and say where every named `data__*` relation's rows come
 * from.
 *
 * It runs after the population and before hydration, and only when a statement names one of the
 * instance's relations ({@link dataDemandOf}): a run that names none reads, decodes, extracts and
 * writes nothing of the tier.
 *
 * ## One state per routed pair
 *
 * Every statically routed path has one state this run, carried in `data__routes`: `facts` (its head
 * row was read from the store or extracted now), `defective` (the bytes or the file decide it) or
 * `refused` (this run decided it), as `DataRouteStateSchema` defines them. A filesystem fault takes its state from
 * the one fault table (`fsFaultRefusal`, a source found as content): the fault is `defective` exactly
 * where that table says `INPUT_UNREADABLE`. Only `facts` are stored. A statement
 * naming any other `data__*` relation refuses while any routed pair is not `facts`
 * ({@link DataRefusal}); `data__routes` itself never refuses.
 *
 * ## Store on, every consumer reads through the run's reader
 *
 * The coverage read decodes head rows only. What the stage extracts it writes (with the head rows
 * of what it was served, listed as covered at read), then reads the head rows of what it wrote back
 * through the reader, so `data__routes` and the states come from reader rows on every arm, and the
 * named row-set tables are copied inside SQLite from the store for exactly the run's `facts` row
 * sets. `data__values` reads the routed pairs' nodes through the reader, an extending read. A row
 * set the reader finds gone is a {@link StoredRowsEvictedError} of the row-set tier: the lane forgets
 * it and runs the stage once more, which misses on exactly it. Store off, every relation comes from
 * the rows in hand, never mixed with stored rows in one attempt.
 */

import { fsFaultRefusal } from '@vibe-agent-toolkit/schema';
import { appendAll, countWork, fsFaultOf, safePath, type FsFaultClass } from '@vibe-agent-toolkit/utils';

import type { ContentKey, KeyedContent, ParserKind } from '../content-key.js';
import type { ParseDispatcher } from '../parse-dispatcher.js';
import { isParseLimitError, isParseWorkerDiedError, type ParseLimitName } from '../parse-limits.js';
import type {
  DataConditionRow,
  DataDocumentRow,
  DataFileRow,
  DataNodeRow,
  DataRouteRow,
  DataValueRow,
  DataVariant,
} from '../schemas/projection-data.js';

import { BLOB_CONTENT_CHANGED, BLOB_NOT_TEXT, BLOB_UNREADABLE } from './blob-condition-codes.js';
import { isSizeRefusal, readKeyedContent, type RunContentCache } from './content-cache.js';
import type { DataRowsAnswer } from './data-extractor.js';
import { dataValueRows } from './data-values.js';
import { allDerivedSpecs, isRowSetTable, storedRelationSpecs } from './derived-table-registry.js';
import { contentRoute } from './document-facts.js';
import { compareRows } from './export.js';
import { StoredRowsEvictedError, type QueryProjection } from './query-projection.js';
import { dataRouteFor, dataRoutingEmptiness, parserKindForMime, type DataRouting } from './router.js';
import { rowSetIdText, type RowSetId, type RowSetIdText } from './row-set-id.js';
import { ROW_SET_TABLES, type RowSetRows, type RowSetTableName } from './row-set-table-registry.js';
import { runContentSource } from './run-population.js';
import { rowSetCoverage } from './store-hydration.js';
import type { FactStore } from './store.js';
import type { StoreReads } from './stored-reads.js';

/** The derived relation that names every routed pair and its state: never refused. */
const ROUTES_RELATION = 'data__routes';

/** The derived relation joining routes to the unshadowed nodes: built only when named. */
const VALUES_RELATION = 'data__values';

/** The `data` instance's row-set tables, by SQL name. */
const DATA_TABLE_BY_NAME: ReadonlyMap<string, RowSetTableName> = new Map(
  storedRelationSpecs().filter(isRowSetTable).filter((spec) => spec.instance === 'data').map((spec) => [spec.name, spec.key] as const),
);

/** The limits a document's bytes decide: a breach of one is `defective`; any other limit is `refused`. */
const BYTES_DETERMINED_LIMITS: ReadonlySet<ParseLimitName> = new Set(['inputBytes', 'outputRows', 'outputBytes', 'outputDepth']);

/** How a user stops the data instance reading a file: the one config mechanism every remedy here ends on. */
const ROUTE_AWAY = 'route it away with resources.extractors.data.exclude';

/** The remedy for a `defective` pair: the bytes will fail the same way on every run. */
const DEFECTIVE_REMEDY = `fix the file, or ${ROUTE_AWAY}`;

/**
 * The remedy for a `refused` pair with no remedy of its own: the run, not the bytes, decided. What is
 * left after the fault table took the filesystem's faults is a file that changed or vanished while the
 * run read it, and a limit the run sets on itself (time, heap, stack) or a parse worker that died.
 */
const REFUSED_REMEDY = 'run again, after stopping whatever is writing the file if it changed or vanished while the run read it;'
  + ` if the same file is refused on every run, the parse is running out of time, heap or stack on it, so ${ROUTE_AWAY}`;

/** What one filesystem fault class means for a routed file: the words a pair's detail renders, and what helps. */
interface RoutedFault {
  /** The fault in words, never the class name (`refused` would read as the pair state). */
  readonly words: string;
  /** What helps, for a file the user never named: a `defective` pair's ends on {@link ROUTE_AWAY} where it is rendered. */
  readonly fix: string;
}

/**
 * Every fault class but absence, as a routed file meets it. The fault table decides the state; its
 * remedies are written for an input a command or a config named ("point the command at ...", "the
 * message names ..."), which a routed file is not, so the words here are the data instance's own.
 * Keyed by the class list, so a class utils adds fails the typecheck here.
 */
const ROUTED_FAULTS: Readonly<Record<Exclude<FsFaultClass, 'absent'>, RoutedFault>> = {
  refused: { words: 'permission was refused', fix: 'grant read permission on the file' },
  'wrong-type': { words: 'it is not a regular file (a directory, a pipe, socket or device, a link loop, or a name too long)', fix: 'make the path a regular file' },
  occupied: { words: 'something was in the way at the path', fix: 'remove what is in the way at the path' },
  unsupported: { words: 'its filesystem does not support reading it', fix: 'move the file to a filesystem that can read it' },
  device: { words: 'its disk or network share failed', fix: 'check the disk or network share holding the file, then run again' },
  exhausted: { words: 'the machine ran out of open files, disk space or quota', fix: 'free open files, disk space or quota on this machine, then run again' },
  busy: { words: 'the file was busy', fix: 'wait for whatever holds the file to release it, then run again' },
};

/** Which of the instance's relations a run's statements name. */
export interface DataDemand {
  /** The named row-set tables, in registry order. */
  readonly tables: readonly RowSetTableName[];
  /** Whether `data__routes` is named. */
  readonly routes: boolean;
  /** Whether `data__values` is named. */
  readonly values: boolean;
}

/**
 * The `data` instance's demand from the relations a run's statements name.
 *
 * @param named - Every relation the statements name, by SQL name
 * @returns What is demanded, or `undefined` when no relation of the instance is named
 */
export function dataDemandOf(named: ReadonlySet<string>): DataDemand | undefined {
  const tables = [...DATA_TABLE_BY_NAME].filter(([name]) => named.has(name)).map(([, key]) => key);
  const routes = named.has(ROUTES_RELATION);
  const values = named.has(VALUES_RELATION);
  return tables.length === 0 && !routes && !values ? undefined : { tables, routes, values };
}

/**
 * The instance's relations a statement can be refused over: every row-set table and `data__values`,
 * never `data__routes`. By SQL name.
 *
 * @returns Their names
 */
export function refusableDataRelations(): readonly string[] {
  const derived = allDerivedSpecs().filter((spec) => spec.producer === 'data' && spec.name !== ROUTES_RELATION);
  return [...DATA_TABLE_BY_NAME.keys(), ...derived.map((spec) => spec.name)];
}

/** Why one routed pair has no rows this run. */
export interface DataRefusalPair {
  /** The routed path, relative to its root. */
  readonly path: string;
  readonly state: 'defective' | 'refused';
  /** The per-pair code (`DATA_PARSE_ERROR`, `BLOB_NOT_TEXT`, `PARSE_LIMIT_EXCEEDED`, ...). */
  readonly code: string;
  /** What happened, in words: the parse error's position, the limit and how far past it. */
  readonly detail: string;
  readonly remedy: string;
}

/**
 * Why a statement naming the instance's relations (all but `data__routes`) refuses: some routed pair
 * is not `facts`. `INPUT_UNREADABLE` when any is `defective` (each such file needs a fix, or an
 * `exclude`), else `RUN_INCOMPLETE` (every pair is `refused`: a rerun may answer, the files as they
 * are). Carries every such pair, in route order.
 */
export interface DataRefusal {
  readonly refusal: 'INPUT_UNREADABLE' | 'RUN_INCOMPLETE';
  readonly pairs: readonly DataRefusalPair[];
}

/** Where one row-set table's rows reach the run database from: the rows in hand, or a copy from the store. */
export type RowSetSource =
  | { readonly rows: readonly Readonly<Record<string, unknown>>[] }
  | { readonly stored: { readonly tier: 'rowSet'; readonly store: FactStore; readonly ids: readonly RowSetId[] } };

/** The derived `data__*` relations a run named, each with its rows. */
export interface DataDerivedRows {
  readonly dataRoutes?: readonly DataRouteRow[];
  readonly dataValues?: readonly DataValueRow[];
}

/** What one data stage answers. */
export type DataStageResult =
  | {
    /** The config declares the instance and does not allow emptiness, and it, or one `include` glob, routed nothing in the run's extent. */
    readonly outcome: 'examined-nothing';
    readonly message: string;
  }
  | {
    readonly outcome: 'staged';
    /** Each named row-set table's source. */
    readonly sources: ReadonlyMap<RowSetTableName, RowSetSource>;
    /** Each named derived relation's rows; `data__values` absent when the statement refuses. */
    readonly derived: DataDerivedRows;
    /** Why a statement naming a refusable relation refuses, or `undefined` when every pair is `facts`. */
    readonly refusal: DataRefusal | undefined;
  };

/** How the stage reads bytes: only through the run's one content reader. */
export interface DataStageContent {
  /** A keyed realization's bytes, re-keyed under its parser kind, or null when the file is gone (`RunContentSource.read`). */
  read(entry: { readonly absolutePath: string; readonly contentKey: ContentKey }): Promise<KeyedContent | null>;
  /** A deferred realization's bytes, read and keyed now under its parser kind. */
  readUnkeyed(absolutePath: string, parserKind: ParserKind): Promise<KeyedContent>;
}

/**
 * The stage's content reader over a run's one read-and-key memo.
 *
 * @param cache - The run's content cache
 * @returns The reader
 */
export function dataStageContentOf(cache: RunContentCache): DataStageContent {
  const source = runContentSource(cache);
  return {
    read: (entry) => source.read(entry),
    readUnkeyed: (absolutePath, parserKind) => readKeyedContent(absolutePath, parserKind, cache),
  };
}

/**
 * Where a test seam acts. Production passes {@link NO_DATA_STAGE_SEAMS}; the query lane passes its
 * env-driven seams, honoured only in a test process.
 */
export interface DataStageSeams {
  /** After the write and its read-back, before any copy, with the run's `facts` row sets in route order. */
  afterWrite(facts: readonly RowSetId[]): void;
  /** Before `data__values` reads the nodes, with the same row sets. */
  beforeValues(facts: readonly RowSetId[]): void;
}

/** No seam acts. */
export const NO_DATA_STAGE_SEAMS: DataStageSeams = Object.freeze({ afterWrite: () => undefined, beforeValues: () => undefined });

/** The projection tables the stage routes from. */
export type DataStageProjection = Pick<QueryProjection, 'roots' | 'resolutionContexts' | 'resourceRealizations'>;

/** One data stage's inputs. */
export interface DataStageInput {
  readonly demand: DataDemand;
  readonly projection: DataStageProjection;
  readonly routing: DataRouting;
  readonly content: DataStageContent;
  /** The run's parse dispatcher: extraction runs on its pool, under its limits. */
  readonly extractor: Pick<ParseDispatcher, 'dataRows'>;
  /** The run's store and its one reader of it, or `undefined` with the store off. */
  readonly store: { readonly store: FactStore; readonly reads: StoreReads } | undefined;
  readonly seams: DataStageSeams;
}

/** One realization the instance reads. */
interface Route {
  readonly root: string;
  readonly path: string;
  readonly absolutePath: string;
  readonly variant: DataVariant;
  readonly contentKey: ContentKey | null;
  readonly contentState: QueryProjection['resourceRealizations'][number]['contentState'];
  readonly contentFaultClass: FsFaultClass | null;
  readonly mime: string | null;
}

/** Why one pair has no rows. */
interface PairFailure {
  readonly state: 'defective' | 'refused';
  readonly code: string;
  readonly detail: string;
  /** The pair's own remedy, when its cause names one (a filesystem fault's, from {@link ROUTED_FAULTS}). */
  readonly remedy?: string;
}

/** A route with its row set, or why it has none before any extraction. */
type ResolvedRoute = { readonly route: Route; readonly id: RowSetId } | { readonly route: Route; readonly failure: PairFailure };

/** A table's rows while the stage builds them. */
type MutableRowSetRows = { [Name in RowSetTableName]: RowSetRows[Name][number][] };

/**
 * Run the data stage for one attempt of a query.
 *
 * @param input - The run's demand, projection, routing, reader, extractor, store and seams
 * @returns Each named relation's source or rows, and the refusal, or the examined-nothing refusal
 * @throws A {@link StoredRowsEvictedError} of the row-set tier when a row set the run wrote or was
 *   served left the store before it was read back
 */
export async function runDataStage(input: DataStageInput): Promise<DataStageResult> {
  const routes = staticRoutes(input.projection, input.routing);
  const emptiness = dataRoutingEmptiness(routes.length, input.routing);
  if (emptiness !== undefined) return { outcome: 'examined-nothing', message: emptiness };
  const resolved = await Promise.all(routes.map((route) => resolveRoute(route, input.content)));
  const ids = distinctIds(resolved);
  const held = await heldRowSets(ids, resolved, input);
  input.seams.afterWrite(held.facts);
  const states = resolved.map((entry) => routeState(entry, held));
  const routeRows = states.map((state) => state.row);
  const refusal = refusalOf(states);
  countRefusedPairs(states);
  return {
    outcome: 'staged',
    sources: sourcesOf(input, held),
    derived: {
      ...(input.demand.routes ? { dataRoutes: routeRows } : {}),
      ...(input.demand.values && refusal === undefined ? { dataValues: dataValueRows(routeRows, await nodesOf(input, held)) } : {}),
    },
    refusal,
  };
}

/**
 * Every realization the routing reads, in projection order, with its root.
 *
 * @param projection - The run's projection
 * @param routing - The project's data routing
 * @returns The routes; a realization with no content (`none`: a dangling link, a directory) is not routed
 */
function staticRoutes(projection: DataStageProjection, routing: DataRouting): Route[] {
  const rootOf = rootsByExtent(projection);
  const routes: Route[] = [];
  for (const realization of projection.resourceRealizations) {
    if (realization.contentState === 'none') continue;
    const variant = dataRouteFor(realization.path, routing);
    if (variant === undefined) continue;
    const root = rootOf(realization.extentId);
    routes.push({
      root: root.id,
      path: realization.path,
      absolutePath: safePath.join(root.path, realization.path),
      variant,
      contentKey: realization.contentKey,
      contentState: realization.contentState,
      contentFaultClass: realization.contentFaultClass,
      mime: realization.mime,
    });
  }
  return routes;
}

/**
 * The root each extent's realizations are under: its resolution context's root, or the run's one
 * root when a realization's extent has none.
 *
 * @param projection - The run's projection
 * @returns The lookup
 * @throws Error When an extent's root cannot be named
 */
function rootsByExtent(projection: DataStageProjection): (extentId: string) => { readonly id: string; readonly path: string } {
  const roots = new Map(projection.roots.map((root) => [root.id, root]));
  const rootIdOf = new Map(projection.resolutionContexts.map((context) => [context.contextId, context.rootId]));
  return (extentId) => {
    const rootId = rootIdOf.get(extentId) ?? (projection.roots.length === 1 ? projection.roots[0]?.id : undefined);
    const root = rootId === undefined ? undefined : roots.get(rootId);
    if (root === undefined) throw new Error(`The extent ${extentId} names no root in this projection, so its data routes have no root.`);
    return root;
  };
}

/**
 * A route's row set, or why it has none, from its realization's content state. A deferred
 * realization is read and keyed now, through the run's reader. An unreadable one is never read
 * again: the fault class the population recorded from its one failed read decides the pair's state
 * by the fault table.
 *
 * @param route - The route
 * @param content - The run's content reader
 * @returns The resolved route
 */
async function resolveRoute(route: Route, content: DataStageContent): Promise<ResolvedRoute> {
  const idOf = (contentKey: ContentKey): ResolvedRoute => ({ route, id: { contentKey, instance: 'data', variant: route.variant } });
  if (route.contentKey !== null) return idOf(route.contentKey);
  if (route.contentFaultClass !== null) return { route, failure: fsFailureOf(route.contentFaultClass, (words) => `the population could not read it: ${words}`) };
  if (route.contentState === 'oversize') {
    return { route, failure: { state: 'defective', code: 'PARSE_LIMIT_EXCEEDED', detail: 'it is past the input cap (inputBytes)' } };
  }
  try {
    return idOf((await content.readUnkeyed(route.absolutePath, parserKindForMime(route.mime))).key);
  } catch (error) {
    return { route, failure: failureOf(error) };
  }
}

/**
 * The row sets of the resolved routes, each once, in route order.
 *
 * @param resolved - The resolved routes
 * @returns The ids
 */
function distinctIds(resolved: readonly ResolvedRoute[]): RowSetId[] {
  const seen = new Map<RowSetIdText, RowSetId>();
  for (const entry of resolved) {
    if ('id' in entry && !seen.has(rowSetIdText(entry.id))) seen.set(rowSetIdText(entry.id), entry.id);
  }
  return [...seen.values()];
}

/** What the stage holds after coverage, extraction, the write and its read-back. */
interface HeldRowSets {
  /** The `facts` row sets, in route order. */
  readonly facts: readonly RowSetId[];
  /** Why each other row set has no rows. */
  readonly failures: ReadonlyMap<RowSetIdText, PairFailure>;
  /** Store off: every table's rows in hand. Store on: undefined, every consumer reads the reader. */
  readonly inHand: Readonly<MutableRowSetRows> | undefined;
}

/**
 * Serve what the store covers, extract the rest, and (store on) write what was extracted and read
 * its head rows back through the reader.
 *
 * @param ids - The routed row sets
 * @param resolved - The resolved routes, for each row set's path
 * @param input - The stage's inputs
 * @returns What the run holds
 */
async function heldRowSets(ids: readonly RowSetId[], resolved: readonly ResolvedRoute[], input: DataStageInput): Promise<HeldRowSets> {
  const { store } = input;
  const servedHeads = store === undefined || ids.length === 0 ? [] : (await store.reads.rowSets(ids, { tables: ['dataFiles'] })).dataFiles;
  const { covered, uncovered } = rowSetCoverage({ dataFiles: servedHeads }, ids);
  if (covered.length > 0) countWork('rowSet.storeServed', covered.length);
  const extraction = await extractAll(uncovered, resolved, input);
  if (store === undefined) {
    return { facts: extraction.extracted, failures: extraction.failures, inHand: extraction.rows };
  }
  if (extraction.extracted.length > 0) {
    const rows = { ...extraction.rows, dataFiles: [...extraction.rows.dataFiles, ...servedHeads] };
    await store.reads.writeSets({ rows, coveredAtRead: covered });
  }
  const writtenHeads = extraction.extracted.length === 0
    ? []
    : (await store.reads.rowSets(extraction.extracted, { tables: ['dataFiles'] })).dataFiles;
  assertPresent(extraction.extracted, writtenHeads, ROW_SET_TABLES.dataFiles.name);
  // Every head row the reader answered is a `facts` row set: the served ones and the written ones read back.
  const facts = new Set([...covered, ...extraction.extracted].map((id) => rowSetIdText(id)));
  return { facts: ids.filter((id) => facts.has(rowSetIdText(id))), failures: extraction.failures, inHand: undefined };
}

/**
 * Refuse the attempt when a row set the run holds is missing from what the reader answered: it left
 * the store since the run read or wrote it.
 *
 * @param ids - The row sets the run holds
 * @param heads - The head rows the reader answered for them
 * @param relation - What was being read
 * @throws A {@link StoredRowsEvictedError} of the row-set tier naming the missing row sets
 */
function assertPresent(ids: readonly RowSetId[], heads: readonly DataFileRow[], relation: string): void {
  const present = new Set(heads.map((row) => rowSetIdText({ contentKey: row.blob, instance: 'data', variant: row.variant })));
  const missing = ids.filter((id) => !present.has(rowSetIdText(id)));
  if (missing.length > 0) throw new StoredRowsEvictedError({ tier: 'rowSet', relation, ids: missing });
}

/** What extracting the uncovered row sets produced. */
interface Extraction {
  readonly extracted: readonly RowSetId[];
  readonly failures: ReadonlyMap<RowSetIdText, PairFailure>;
  readonly rows: MutableRowSetRows;
}

/**
 * Extract every uncovered row set from its bytes, each read once through the run's reader.
 *
 * @param uncovered - The row sets to extract
 * @param resolved - The resolved routes, for each row set's first path
 * @param input - The stage's inputs
 * @returns The extracted row sets, their rows, and why each other one has none
 */
async function extractAll(uncovered: readonly RowSetId[], resolved: readonly ResolvedRoute[], input: DataStageInput): Promise<Extraction> {
  const pathOf = new Map<RowSetIdText, string>();
  for (const entry of resolved) {
    if ('id' in entry && !pathOf.has(rowSetIdText(entry.id))) pathOf.set(rowSetIdText(entry.id), entry.route.absolutePath);
  }
  const outcomes = await Promise.all(uncovered.map((id) => extractOne(id, pathOf.get(rowSetIdText(id)) ?? '', input)));
  const rows = emptyRows();
  const extracted: RowSetId[] = [];
  const failures = new Map<RowSetIdText, PairFailure>();
  for (const [index, id] of uncovered.entries()) {
    const outcome = outcomes[index] as ExtractOutcome;
    if ('failure' in outcome) {
      failures.set(rowSetIdText(id), outcome.failure);
      continue;
    }
    extracted.push(id);
    appendRows(rows, id, outcome.rows);
  }
  if (extracted.length > 0) countWork('rowSet.extracted', extracted.length);
  return { extracted, failures, rows: sortedRows(rows) };
}

/** The rows of one extraction, or why it has none. */
type ExtractOutcome = { readonly rows: Extract<DataRowsAnswer, { outcome: 'rows' }>['rows'] } | { readonly failure: PairFailure };

/**
 * Read one row set's bytes through the run's reader and extract its rows on the pool.
 *
 * @param id - The row set
 * @param absolutePath - Where its bytes are
 * @param input - The stage's inputs
 * @returns Its rows, or why it has none
 */
async function extractOne(id: RowSetId, absolutePath: string, input: DataStageInput): Promise<ExtractOutcome> {
  try {
    const keyed = await input.content.read({ absolutePath, contentKey: id.contentKey });
    if (keyed === null) return { failure: { state: 'refused', code: BLOB_UNREADABLE, detail: 'the file is gone' } };
    if (keyed.key !== id.contentKey) {
      return { failure: { state: 'refused', code: BLOB_CONTENT_CHANGED, detail: 'its bytes no longer match the key the population recorded' } };
    }
    if (contentRoute(keyed).kind === 'not-text') return { failure: { state: 'defective', code: BLOB_NOT_TEXT, detail: 'its bytes are not text' } };
    const answer = await input.extractor.dataRows(id.variant, keyed);
    if (answer.outcome === 'defect') return { failure: { state: 'defective', code: answer.code, detail: answer.message } };
    return { rows: answer.rows };
  } catch (error) {
    return { failure: failureOf(error) };
  }
}

/**
 * Why a read or an extraction failed, as a pair state, or the error itself when it is no pair's.
 *
 * @param error - What the read or the extraction threw
 * @returns The failure
 * @throws `error` when it is neither a limit, a worker death, a size refusal nor a file fault
 */
function failureOf(error: unknown): PairFailure {
  const detail = error instanceof Error ? error.message : String(error);
  if (isParseLimitError(error)) return { state: BYTES_DETERMINED_LIMITS.has(error.limit) ? 'defective' : 'refused', code: error.code, detail };
  if (isParseWorkerDiedError(error)) return { state: 'refused', code: error.code, detail };
  if (isSizeRefusal(error)) return { state: 'defective', code: 'PARSE_LIMIT_EXCEEDED', detail };
  const fault = fsFaultOf(error);
  if (fault !== undefined) return fsFailureOf(fault.faultClass, () => `reading it failed with ${fault.errno}`);
  throw error;
}

/**
 * A filesystem fault on a routed file's read, as a pair state, by the one fault table: the file is
 * a source the run found as content, so the pair is `defective` exactly where the table refuses
 * `INPUT_UNREADABLE` (a refused permission, a failed device, ...) and `refused` where it stops the
 * run (`RUN_INCOMPLETE`: out of descriptors, a busy path). The remedy is this instance's own
 * ({@link ROUTED_FAULTS}), never the table's, which addresses an input someone named.
 *
 * Absence is the one class read otherwise: the population listed the path in this run, so nothing
 * there now is the file vanishing under the run, `refused` like the reader's own "gone"
 * ({@link extractOne}), never the table's restore-the-reference remedy for a path an input names.
 *
 * @param faultClass - The fault's class, as {@link fsFaultOf} read it
 * @param detailOf - What failed, given the class in words; asked for every class but absence
 * @returns The failure
 */
function fsFailureOf(faultClass: FsFaultClass, detailOf: (words: string) => string): PairFailure {
  if (faultClass === 'absent') return { code: BLOB_UNREADABLE, state: 'refused', detail: 'the file is gone' };
  const { words, fix } = ROUTED_FAULTS[faultClass];
  const failed = { code: BLOB_UNREADABLE, detail: detailOf(words) };
  return fsFaultRefusal('source', faultClass, 'content').refusal === 'INPUT_UNREADABLE'
    ? { ...failed, state: 'defective', remedy: `${fix}, or ${ROUTE_AWAY}` }
    : { ...failed, state: 'refused', remedy: fix };
}

/** @returns Every table of the instance, empty */
function emptyRows(): MutableRowSetRows {
  return { dataFiles: [], dataDocuments: [], dataNodes: [], dataConditions: [] };
}

/**
 * Add one extraction's rows to the stage's, each carrying its row set's `blob` and `variant`.
 *
 * @param rows - The stage's rows
 * @param id - The row set
 * @param extracted - Its rows, without the pair
 */
function appendRows(rows: MutableRowSetRows, id: RowSetId, extracted: Extract<DataRowsAnswer, { outcome: 'rows' }>['rows']): void {
  const pair = { blob: id.contentKey, variant: id.variant };
  appendAll(rows.dataFiles, extracted.files.map((row): DataFileRow => ({ ...pair, ...row })));
  appendAll(rows.dataDocuments, extracted.documents.map((row): DataDocumentRow => ({ ...pair, ...row })));
  appendAll(rows.dataNodes, extracted.nodes.map((row): DataNodeRow => ({ ...pair, ...row })));
  appendAll(rows.dataConditions, extracted.conditions.map((row): DataConditionRow => ({ ...pair, ...row })));
}

/**
 * Each table's rows in its primary-key order, the order a copy from the store scans in.
 *
 * @param rows - The rows
 * @returns The same rows, each table sorted
 */
function sortedRows(rows: MutableRowSetRows): MutableRowSetRows {
  return {
    dataFiles: rows.dataFiles.toSorted(compareRows(ROW_SET_TABLES.dataFiles)),
    dataDocuments: rows.dataDocuments.toSorted(compareRows(ROW_SET_TABLES.dataDocuments)),
    dataNodes: rows.dataNodes.toSorted(compareRows(ROW_SET_TABLES.dataNodes)),
    dataConditions: rows.dataConditions.toSorted(compareRows(ROW_SET_TABLES.dataConditions)),
  };
}

/** One route's `data__routes` row, and why it has no rows when it is not `facts`. */
interface RouteState {
  readonly row: DataRouteRow;
  readonly failure: PairFailure | undefined;
}

/**
 * One route's state this run.
 *
 * @param entry - The resolved route
 * @param held - What the run holds
 * @returns Its row and failure
 */
function routeState(entry: ResolvedRoute, held: HeldRowSets): RouteState {
  const { route } = entry;
  const base = { root: route.root, path: route.path, variant: route.variant };
  if ('failure' in entry) return { row: { ...base, blob: null, state: entry.failure.state, code: entry.failure.code }, failure: entry.failure };
  const failure = held.failures.get(rowSetIdText(entry.id));
  if (failure !== undefined) return { row: { ...base, blob: entry.id.contentKey, state: failure.state, code: failure.code }, failure };
  return { row: { ...base, blob: entry.id.contentKey, state: 'facts', code: null }, failure: undefined };
}

/**
 * Count `rowSet.refused`: one per routed pair that is `defective` or `refused`, so a row set two
 * paths share counts twice, as each path is its own pair.
 *
 * @param states - Every route's state
 */
function countRefusedPairs(states: readonly RouteState[]): void {
  const refused = states.filter((state) => state.failure !== undefined).length;
  if (refused > 0) countWork('rowSet.refused', refused);
}

/**
 * Why a statement naming a refusable relation refuses this run, from the routes' states.
 *
 * @param states - Every route's state, in route order
 * @returns The refusal, or `undefined` when every routed pair is `facts`
 */
function refusalOf(states: readonly RouteState[]): DataRefusal | undefined {
  const pairs = states.flatMap(({ row, failure }): DataRefusalPair[] => {
    if (failure === undefined) return [];
    const remedy = failure.remedy ?? (failure.state === 'defective' ? DEFECTIVE_REMEDY : REFUSED_REMEDY);
    return [{ path: row.path, state: failure.state, code: failure.code, detail: failure.detail, remedy }];
  });
  if (pairs.length === 0) return undefined;
  return { refusal: pairs.some((pair) => pair.state === 'defective') ? 'INPUT_UNREADABLE' : 'RUN_INCOMPLETE', pairs };
}

/**
 * Each named row-set table's source: a copy of the run's `facts` row sets from the store, or the rows in hand.
 *
 * @param input - The stage's inputs
 * @param held - What the run holds
 * @returns The sources, by table
 */
function sourcesOf(input: DataStageInput, held: HeldRowSets): ReadonlyMap<RowSetTableName, RowSetSource> {
  const { store } = input;
  return new Map(input.demand.tables.map((table): [RowSetTableName, RowSetSource] => {
    if (held.inHand !== undefined) return [table, { rows: held.inHand[table] }];
    if (store === undefined) throw new Error('A store-on data stage holds no rows in hand.');
    return [table, { stored: { tier: 'rowSet', store: store.store, ids: held.facts } }];
  }));
}

/**
 * The nodes of the run's `facts` row sets, for `data__values`: read through the reader (an extending
 * read, the head rows already held), or the rows in hand.
 *
 * @param input - The stage's inputs
 * @param held - What the run holds
 * @returns The nodes, in primary-key order
 * @throws A {@link StoredRowsEvictedError} of the row-set tier when a row set left the store since its head row was read
 */
async function nodesOf(input: DataStageInput, held: HeldRowSets): Promise<readonly DataNodeRow[]> {
  if (held.inHand !== undefined) return held.inHand.dataNodes;
  if (input.store === undefined || held.facts.length === 0) return [];
  input.seams.beforeValues(held.facts);
  const answer = await input.store.reads.rowSets(held.facts, { tables: ['dataFiles', 'dataNodes'] });
  assertPresent(held.facts, answer.dataFiles, VALUES_RELATION);
  return answer.dataNodes;
}
