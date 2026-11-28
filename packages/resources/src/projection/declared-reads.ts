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

import { dataRouteDecision, type DataRouting } from './router.js';
import { rowSetIdText, type RowSetId, type RowSetIdText } from './row-set-id.js';
import type { RowSetRows, RowSetTableName } from './row-set-table-registry.js';
import type { RowSetRequest } from './store.js';

/** One pair a step declares it reads: a path under a root, read as a variant. */
export interface DeclaredPair {
  /** The root id the path is relative to. */
  readonly root: string;
  /** The path, relative to its root. */
  readonly path: string;
  readonly variant: DataVariant;
}

/** Why a declared pair is not statically routed under its variant. */
export type DataRequestUnroutedReason =
  /** No routing rule reads the path. */
  | { readonly kind: 'unrouted' }
  /** An `exclude` glob routes the path away. */
  | { readonly kind: 'excluded' }
  /** A routing glob reads the path, and the credentials rule refuses it: the file is never read. Only renaming it helps. */
  | { readonly kind: 'credentials' }
  /** The path is routed, as another variant. */
  | { readonly kind: 'routed-as'; readonly variant: DataVariant }
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

/** What the handle is built over: the run's routing, its routes' states and its one read. */
interface DeclaredReadsBasis {
  readonly routing: DataRouting;
  /** Every statically routed pair's `data__routes` row. */
  readonly routes: readonly DataRouteRow[];
  readonly read: HeldRowSetRead;
  /** A `defective` or `refused` route's remedy and retryability, as the data stage reports them. */
  readonly noRows: (route: DataRouteRow) => { readonly remedy: string; readonly retryable: boolean };
}

/** The one remedy of a file the credentials rule refuses: routing cannot lift it. */
const RENAME_IT = 'rename the file so its name matches no credentials pattern (routing it cannot lift the refusal)';
/** How a step routes a pair it was refused: the one config mechanism. */
const ROUTE_IT = 'route it in resources.extractors.data';

/** @returns A text key for a path under a root */
function placeText(root: string, path: string): string {
  return `${root}\0${path}`;
}

/** @returns A text key for a declared pair */
function pairText(pair: DeclaredPair): string {
  return `${placeText(pair.root, pair.path)}\0${pair.variant}`;
}

/**
 * The handle over one declared set.
 *
 * @param declared - The pairs the step's own inputs name
 * @param basis - The run's routing, routes and read
 * @returns The handle
 */
export function declaredReadsOver(declared: readonly DeclaredPair[], basis: DeclaredReadsBasis): DeclaredReads {
  const declaredSet = new Set(declared.map((pair) => pairText(pair)));
  const routeAt = new Map(basis.routes.map((row) => [placeText(row.root, row.path), row] as const));
  return {
    read: async <Table extends RowSetTableName>(pairs: readonly DeclaredPair[], request: RowSetRequest<Table>) => {
      const undeclared = pairs.find((pair) => !declaredSet.has(pairText(pair)));
      if (undeclared !== undefined) {
        throw new Error(`The pair '${undeclared.path}' as ${undeclared.variant} under root ${undeclared.root} is not declared by this step: a step reads only the pairs its own inputs name.`);
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

/** A declared pair with its row set, or its absence. */
type ResolvedPair = { readonly pair: DeclaredPair; readonly id: RowSetId } | { readonly absent: Extract<DeclaredAnswer<never>, { state: 'absent' }> };

/**
 * One declared pair's row set, or why it has none: the routing first, then the pair's state.
 *
 * @param pair - The pair
 * @param routeAt - The run's routes, by place
 * @param basis - The run's routing, and a route's remedy when it has no rows
 * @returns The resolved pair
 */
function resolvePair(pair: DeclaredPair, routeAt: ReadonlyMap<string, DataRouteRow>, basis: Pick<DeclaredReadsBasis, 'routing' | 'noRows'>): ResolvedPair {
  const decision = dataRouteDecision(pair.path, basis.routing);
  if (!('variant' in decision)) return unrouted(pair, { kind: decision.unrouted });
  const readAs = readableVariant(pair.variant, decision.variant);
  if (readAs === undefined) return unrouted(pair, { kind: 'routed-as', variant: decision.variant });
  const route = routeAt.get(placeText(pair.root, pair.path));
  if (route?.variant !== readAs) return unrouted(pair, { kind: 'not-in-run' });
  if (route.state === 'facts' && route.blob !== null) return { pair, id: { contentKey: route.blob, instance: 'data', variant: route.variant } };
  if (route.state === 'facts') throw new Error(`The routed pair '${pair.path}' is facts with no blob.`);
  return { absent: { state: 'absent', cause: 'no-rows', pair, code: route.code ?? '', routeState: route.state, ...basis.noRows(route) } };
}

/**
 * The variant whose row set answers a request: the requested one, or `jsonc` for a `json` request
 * the routing reads as `jsonc`, since valid JSON parses to the same nodes under either.
 *
 * @param requested - The pair's variant
 * @param routed - The variant the routing reads the path as
 * @returns The variant to read, or undefined when the request is refused `routed-as`
 */
function readableVariant(requested: DataVariant, routed: DataVariant): DataVariant | undefined {
  if (requested === routed) return requested;
  return requested === 'json' && routed === 'jsonc' ? routed : undefined;
}

/** @returns The reason in words */
function reasonWords(reason: DataRequestUnroutedReason): string {
  switch (reason.kind) {
    case 'unrouted': return 'no rule of resources.extractors.data routes it';
    case 'credentials': return 'it is refused by the credentials rule, so the file is never read';
    case 'excluded': return 'resources.extractors.data.exclude routes it away';
    case 'routed-as': return `it is routed as ${reason.variant}`;
    case 'not-in-run': return 'the run holds no file with content at the path';
  }
}

/** @returns A declared pair's `DATA_REQUEST_UNROUTED` absence */
function unrouted(pair: DeclaredPair, reason: DataRequestUnroutedReason): ResolvedPair {
  const detail = `'${pair.path}' is not routed to the data instance as ${pair.variant}: ${reasonWords(reason)}`;
  // A literal, so the emitted-codes doc test sees it.
  return { absent: { state: 'absent', cause: 'unrouted', pair, code: 'DATA_REQUEST_UNROUTED', reason, detail, remedy: reason.kind === 'credentials' ? RENAME_IT : `${ROUTE_IT} as ${pair.variant}` } };
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
    for (const row of answer[table] as ReadonlyArray<{ readonly blob: RowSetId['contentKey']; readonly variant: DataVariant }>) {
      const text = rowSetIdText({ contentKey: row.blob, instance: 'data', variant: row.variant });
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
