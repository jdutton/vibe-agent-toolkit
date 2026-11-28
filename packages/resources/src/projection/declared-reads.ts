/**
 * The declared-reads handle: the one way a resolve step reads data rows.
 *
 * A step's declared set is the `(root, path, variant)` pairs its own inputs name, never what the
 * routing happens to route. The handle answers a request in one fixed order:
 *
 * 1. a pair outside the declared set throws, naming it: a programming error, whether or not the pair
 *    is routed;
 * 2. a declared pair the run does not statically route under that variant is `absent`
 *    `DATA_REQUEST_UNROUTED`, saying why (unrouted, excluded, refused by the credentials rule, routed as another variant, or no
 *    routed file at the path in this run), so the step can refuse its family naming the requester,
 *    the path, the reason and the remedy; there is no extraction on request. One crossing is not a
 *    refusal: a `json` pair whose path the routing reads as `jsonc` (an adopter's
 *    `jsonc: ['**\/*.json']`) reads that path's `jsonc` row set, because valid JSON gives identical
 *    nodes under either variant; the answer's `pair` stays the requested `json` pair;
 * 3. a routed pair is `present` with the requested tables' rows of its row set, or `absent` with its
 *    `data__routes` code when it is `defective` or `refused`, carrying the remedy and retryability its
 *    own `DATA_FILE_NO_ROWS` finding is given, so a step refusing on it says the same.
 *
 * The rows come from the data stage's one backing, chosen once per run with the store: the run's
 * reader store on, the stage's rows in hand store off. A consumer cannot tell which it has. Many
 * pairs in one request are one backing read, so the reader reads each table once per row set.
 */

import type { DataRouteRow, DataVariant } from '../schemas/projection-data.js';
import type { TsRouteRow, TsVariant } from '../schemas/projection-ts.js';

import { dataRouteDecision, tsRouteDecision } from './router.js';
import { rowSetIdOf, rowSetIdText, type RowSetId, type RowSetIdText, type RowSetInstanceId } from './row-set-id.js';
import type { RowSetRoutings } from './row-set-instances.js';
import { ROW_SET_TABLES, type RowSetRows, type RowSetTableName } from './row-set-table-registry.js';
import type { RowSetRequest } from './store.js';

/** One pair of one instance a step declares it reads: its own variants only, as {@link RowSetId} pairs them. */
export type DeclaredPair = {
  readonly [Instance in RowSetInstanceId]: {
    /** The root id the path is relative to. */
    readonly root: string;
    /** The path, relative to its root. */
    readonly path: string;
    /** The instance that reads the path. */
    readonly instance: Instance;
    /** How the instance reads it: one of the instance's own variants. */
    readonly variant: { readonly data: DataVariant; readonly ts: TsVariant }[Instance];
  };
}[RowSetInstanceId];

/** Why a declared pair is not statically routed under its variant. */
export type DataRequestUnroutedReason =
  /** No routing rule reads the path. */
  | { readonly kind: 'unrouted' }
  /** An `exclude` glob routes the path away. */
  | { readonly kind: 'excluded' }
  /** A routing glob reads the path, and the credentials rule refuses it: the file is never read. Only renaming it helps. */
  | { readonly kind: 'credentials' }
  /** The path is under `node_modules`: the `ts` instance never routes it. */
  | { readonly kind: 'node-modules' }
  /** The path is routed, as another variant. */
  | { readonly kind: 'routed-as'; readonly variant: DataVariant | TsVariant }
  /** The routing reads the path as this variant, and the run holds no file with content there. */
  | { readonly kind: 'not-in-run' };

/** One declared pair's answer, its rows typed to the requested tables. */
export type DeclaredAnswer<Table extends RowSetTableName> =
  | {
    readonly state: 'present';
    readonly pair: DeclaredPair;
    readonly rows: Pick<RowSetRows, Table>;
    /** Set when a `json` request is answered from the path's `jsonc` row set (the routing reads it as `jsonc`). */
    readonly readAs?: 'jsonc';
  }
  | {
    readonly state: 'absent';
    readonly cause: 'unrouted';
    readonly pair: DeclaredPair;
    readonly code: 'DATA_REQUEST_UNROUTED';
    readonly reason: DataRequestUnroutedReason;
    /** The pair and the reason, in words. */
    readonly detail: string;
    readonly remedy: string;
  }
  | {
    readonly state: 'absent';
    readonly cause: 'no-rows';
    readonly pair: DeclaredPair;
    /** The pair's `data__routes` code. */
    readonly code: string;
    readonly routeState: 'defective' | 'refused';
    /** What makes the file give rows: the fix of its `DATA_FILE_NO_ROWS` finding, word for word. */
    readonly remedy: string;
    /** Whether a rerun may give it rows: the run, not the bytes, decided. */
    readonly retryable: boolean;
  };

/** A step's handle over its declared set. */
export interface DeclaredReads {
  /**
   * Some declared pairs' rows, read in one backing read.
   *
   * @param pairs - The pairs, each in the declared set
   * @param request - The tables to read
   * @returns One answer per pair, in `pairs` order
   * @throws Error naming the first pair outside the declared set, before anything is read
   * @throws A `StoredRowsEvictedError` of the row-set tier, store on, when a routed pair's row set left the store
   */
  read<Table extends RowSetTableName>(pairs: readonly DeclaredPair[], request: RowSetRequest<Table>): Promise<Array<DeclaredAnswer<Table>>>;
}

/**
 * The data stage's one read of its `facts` row sets: the requested tables, in primary-key order,
 * through the run's reader or over the rows in hand.
 */
type HeldRowSetRead = <Table extends RowSetTableName>(ids: readonly RowSetId[], request: RowSetRequest<Table>) => Promise<Pick<RowSetRows, Table>>;

/** Any instance's routes row. */
type RouteRow = DataRouteRow | TsRouteRow;

/** What the handle is built over: the run's routing, its routes' states and its one read. */
interface DeclaredReadsBasis {
  /** Each instance's static routing. */
  readonly routing: RowSetRoutings;
  /** Every statically routed pair's `data__routes` row. */
  readonly routes: readonly DataRouteRow[];
  /** Every statically routed pair's `ts__routes` row; undefined when the run did not stage the `ts` instance. */
  readonly tsRoutes: readonly TsRouteRow[] | undefined;
  readonly read: HeldRowSetRead;
  /** A `defective` or `refused` route's remedy and retryability, as the stage reports them for its instance. */
  readonly noRows: (instance: RowSetInstanceId, route: RouteRow) => { readonly remedy: string; readonly retryable: boolean };
}

/** The one remedy of a file the credentials rule refuses: routing cannot lift it. */
const RENAME_IT = 'rename the file so its name matches no credentials pattern (routing it cannot lift the refusal)';

/** @returns A text key for a path under a root */
function placeText(root: string, path: string): string {
  return `${root}\0${path}`;
}

/** @returns A text key for a declared pair */
function pairText(pair: DeclaredPair): string {
  return `${placeText(pair.root, pair.path)}\0${pair.instance}\0${pair.variant}`;
}

/**
 * The handle over one declared set.
 *
 * @param declared - The pairs the step's own inputs name
 * @param basis - The run's routing, routes and read
 * @returns The handle
 * @throws Error naming the first `ts` pair declared when the run did not stage the `ts` instance
 */
export function declaredReadsOver(declared: readonly DeclaredPair[], basis: DeclaredReadsBasis): DeclaredReads {
  const unstaged = basis.tsRoutes === undefined ? declared.find((pair) => pair.instance === 'ts') : undefined;
  if (unstaged !== undefined) {
    throw new Error(`The pair '${unstaged.path}' as ${unstaged.variant} under root ${unstaged.root} is declared for the ts instance, and the ts instance is not staged in this run: the step's demand must stage it.`);
  }
  const declaredSet = new Set(declared.map((pair) => pairText(pair)));
  const routeAt: ReadonlyMap<RowSetInstanceId, ReadonlyMap<string, RouteRow>> = new Map([
    ['data', routesByPlace(basis.routes)],
    ['ts', routesByPlace(basis.tsRoutes ?? [])],
  ]);
  return {
    read: async <Table extends RowSetTableName>(pairs: readonly DeclaredPair[], request: RowSetRequest<Table>) => {
      const undeclared = pairs.find((pair) => !declaredSet.has(pairText(pair)));
      if (undeclared !== undefined) {
        throw new Error(`The pair '${undeclared.path}' as ${undeclared.variant} (${undeclared.instance} instance) under root ${undeclared.root} is not declared by this step: a step reads only the pairs its own inputs name.`);
      }
      const resolved = pairs.map((pair) => resolvePair(pair, routeAt, basis));
      const ids = distinct(resolved.flatMap((entry) => ('id' in entry ? [entry.id] : [])));
      const byId = ids.length === 0 ? new Map<RowSetIdText, Pick<RowSetRows, Table>>() : rowsById(await basis.read(ids, request), request.tables);
      return resolved.map((entry): DeclaredAnswer<Table> => {
        if (!('id' in entry)) return entry.absent;
        const rows = byId.get(rowSetIdText(entry.id)) ?? emptyTables(request.tables);
        return entry.pair.variant === entry.id.variant ? { state: 'present', pair: entry.pair, rows } : { state: 'present', pair: entry.pair, rows, readAs: 'jsonc' };
      });
    },
  };
}

/** @returns One instance's routes by place */
function routesByPlace(routes: readonly RouteRow[]): ReadonlyMap<string, RouteRow> {
  return new Map(routes.map((row) => [placeText(row.root, row.path), row] as const));
}

/** A declared pair with its row set, or its absence. */
type ResolvedPair = { readonly pair: DeclaredPair; readonly id: RowSetId } | { readonly absent: Extract<DeclaredAnswer<never>, { state: 'absent' }> };

/**
 * One declared pair's row set, or why it has none: the routing first, then the pair's state.
 *
 * @param pair - The pair
 * @param routeAt - The run's routes, by instance and place
 * @param basis - The run's routing, and a route's remedy when it has no rows
 * @returns The resolved pair
 */
function resolvePair(pair: DeclaredPair, routeAt: ReadonlyMap<RowSetInstanceId, ReadonlyMap<string, RouteRow>>, basis: Pick<DeclaredReadsBasis, 'routing' | 'noRows'>): ResolvedPair {
  const routed = routedAs(pair, basis.routing);
  if ('reason' in routed) return unrouted(pair, routed.reason);
  const route = routeAt.get(pair.instance)?.get(placeText(pair.root, pair.path));
  if (route?.variant !== routed.readAs) return unrouted(pair, { kind: 'not-in-run' });
  if (route.state === 'facts' && route.blob !== null) return { pair, id: rowSetIdOf(route.blob, pair.instance, route.variant) };
  if (route.state === 'facts') throw new Error(`The routed pair '${pair.path}' is facts with no blob.`);
  return { absent: { state: 'absent', cause: 'no-rows', pair, code: route.code ?? '', routeState: route.state, ...basis.noRows(pair.instance, route) } };
}

/**
 * The variant whose row set answers a pair, or why the routing reads none for it. A `json` data
 * request the routing reads as `jsonc` is answered from the `jsonc` row set, since valid JSON
 * parses to the same nodes under either; no other crossing exists, and the `ts` instance has none.
 *
 * @param pair - The pair
 * @param routing - Each instance's routing
 * @returns The variant to read, or the reason it is not routed
 */
function routedAs(pair: DeclaredPair, routing: RowSetRoutings): { readonly readAs: DataVariant | TsVariant } | { readonly reason: DataRequestUnroutedReason } {
  if (pair.instance === 'ts') {
    const decision = tsRouteDecision(pair.path, routing.ts);
    if (!('variant' in decision)) return { reason: decision.unrouted === 'extension' ? { kind: 'unrouted' } : { kind: decision.unrouted } };
    return decision.variant === pair.variant ? { readAs: decision.variant } : { reason: { kind: 'routed-as', variant: decision.variant } };
  }
  const decision = dataRouteDecision(pair.path, routing.data);
  if (!('variant' in decision)) return { reason: { kind: decision.unrouted } };
  const readable = pair.variant === decision.variant || (pair.variant === 'json' && decision.variant === 'jsonc');
  return readable ? { readAs: decision.variant } : { reason: { kind: 'routed-as', variant: decision.variant } };
}

/** @returns The reason in words, for the instance's own routing config */
function reasonWords(reason: DataRequestUnroutedReason, instance: RowSetInstanceId): string {
  switch (reason.kind) {
    case 'unrouted': return `no rule of resources.extractors.${instance} routes it`;
    case 'node-modules': return 'a file under node_modules is never routed';
    case 'credentials': return 'it is refused by the credentials rule, so the file is never read';
    case 'excluded': return `resources.extractors.${instance}.exclude routes it away`;
    case 'routed-as': return `it is routed as ${reason.variant}`;
    case 'not-in-run': return 'the run holds no file with content at the path';
  }
}

/** @returns What a user does to have the instance read the pair */
function unroutedRemedy(pair: DeclaredPair, reason: DataRequestUnroutedReason): string {
  if (reason.kind === 'credentials') return RENAME_IT;
  if (pair.instance === 'ts') return reason.kind === 'excluded' ? 'remove the glob that matches it from resources.extractors.ts.exclude' : 'route it in resources.extractors.ts';
  return `route it in resources.extractors.data as ${pair.variant}`;
}

/** @returns A declared pair's `DATA_REQUEST_UNROUTED` absence */
function unrouted(pair: DeclaredPair, reason: DataRequestUnroutedReason): ResolvedPair {
  const detail = `'${pair.path}' is not routed to the ${pair.instance} instance as ${pair.variant}: ${reasonWords(reason, pair.instance)}`;
  // A literal, so the emitted-codes doc test sees it.
  return { absent: { state: 'absent', cause: 'unrouted', pair, code: 'DATA_REQUEST_UNROUTED', reason, detail, remedy: unroutedRemedy(pair, reason) } };
}

/** @returns Each id once, in first-seen order */
function distinct(ids: readonly RowSetId[]): RowSetId[] {
  return [...new Map(ids.map((id) => [rowSetIdText(id), id] as const)).values()];
}

/** @returns Every requested table, empty */
function emptyTables<Table extends RowSetTableName>(tables: readonly Table[]): Pick<RowSetRows, Table> {
  return Object.fromEntries(tables.map((table) => [table, []])) as unknown as Pick<RowSetRows, Table>;
}

/**
 * One read's rows split by row set, each table keeping the read's primary-key order.
 *
 * @param answer - The read's rows
 * @param tables - The requested tables
 * @returns Each row set's rows
 */
function rowsById<Table extends RowSetTableName>(answer: Pick<RowSetRows, Table>, tables: readonly Table[]): Map<RowSetIdText, Pick<RowSetRows, Table>> {
  const byId = new Map<RowSetIdText, Record<string, unknown[]>>();
  for (const table of tables) {
    const { instance } = ROW_SET_TABLES[table];
    for (const row of answer[table] as ReadonlyArray<{ readonly blob: RowSetId['contentKey']; readonly variant: string }>) {
      const text = rowSetIdText(rowSetIdOf(row.blob, instance, row.variant));
      let held = byId.get(text);
      if (held === undefined) {
        held = emptyTables(tables) as unknown as Record<string, unknown[]>;
        byId.set(text, held);
      }
      held[table]?.push(row);
    }
  }
  return byId as unknown as Map<RowSetIdText, Pick<RowSetRows, Table>>;
}
