/**
 * The row-set instances the one row-set stage (`data-stage.ts`) drives: each instance's routing
 * decision, its extractor dispatch, its tables and head table, its routes relation, and the finding
 * and remedy a routed pair with no rows gets. The stage holds no instance's literal: it routes,
 * resolves, reads coverage, extracts, writes, reads back and states every pair through these.
 *
 * Adding an instance is a descriptor here (and its tables and derived relations in the registries),
 * never a copy of the stage's path.
 */

import type { NonOverridableCode } from '@vibe-agent-toolkit/schema';

import type { KeyedContent } from '../content-key.js';
import type { ParseDispatcher } from '../parse-dispatcher.js';
import { DATA_INSTANCE } from '../schemas/projection-data.js';
import { TS_INSTANCE } from '../schemas/projection-ts.js';

import { DERIVED_TABLES, isRowSetTable, storedRelationSpecs } from './derived-table-registry.js';
import { dataRouteFor, tsRouteDecision, type DataRouting, type TsRouting } from './router.js';
import { rowSetIdOf, type RowSetId, type RowSetIdOf, type RowSetInstanceId } from './row-set-id.js';
import type { RowSetHeadTableName, RowSetRows, RowSetRowTypes, RowSetTableName } from './row-set-table-registry.js';
import { rowSetHeadTableOf } from './store-hydration.js';

/** Each instance's static routing, from the project config. */
export interface RowSetRoutings {
  readonly data: DataRouting;
  readonly ts: TsRouting;
}

/** The extractions the stage dispatches: the run's parse dispatcher's row-set jobs. */
export type RowSetExtractor = Pick<ParseDispatcher, 'dataRows' | 'tsRows'>;

/** One extraction's rows by table, minus the `blob` and `variant` the stage adds: only the instance's own tables. */
export type ExtractedTables = { readonly [Table in RowSetTableName]?: readonly Omit<RowSetRowTypes[Table], 'blob' | 'variant'>[] };

/** What one extraction answers, whatever the instance: the rows and the bytes of their JSON, or the document's defect. */
export type RowSetAnswer =
  | { readonly outcome: 'rows'; readonly tables: ExtractedTables; readonly bytes: number }
  | { readonly outcome: 'defect'; readonly code: string; readonly message: string };

/** One row-set instance, as the stage drives it. */
export interface RowSetInstanceDescriptor {
  readonly instance: RowSetInstanceId;
  /** The head table: one row per stored row set, what coverage and presence are read from. */
  readonly head: RowSetHeadTableName;
  /** Every table of the instance, in registry order. */
  readonly tables: readonly RowSetTableName[];
  /** The derived relation naming every routed pair and its state (`<instance>__routes`). */
  readonly routesRelation: string;
  /**
   * What a routed pair with no rows is: the lane-owned finding `code` (never overridable), the
   * relations it says answer without the file, and `routeAway`, the one config mechanism every
   * remedy ends on.
   */
  readonly noRows: { readonly code: Extract<NonOverridableCode, `${string}_FILE_NO_ROWS`>; readonly answering: string; readonly routeAway: string };
  /**
   * Whether a route must be git content: a realization the forced filesystem crawl found that git
   * does not hold (an ignored file) is never routed.
   */
  readonly gitContentOnly: boolean;
  /**
   * The variant a path is read as, by the instance's routing, or undefined when it is not routed.
   *
   * @param path - The path relative to its root, forward slashes
   * @param routings - Every instance's routing
   */
  variantOf(path: string, routings: RowSetRoutings): string | undefined;
  /**
   * Extract one row set on the run's dispatcher.
   *
   * @param extractor - The run's dispatcher
   * @param id - The row set, of this instance
   * @param content - Its bytes, read and keyed
   */
  extract(extractor: RowSetExtractor, id: RowSetId, content: KeyedContent): Promise<RowSetAnswer>;
}

/**
 * The id narrowed to one instance, or a defect of the caller.
 *
 * @param id - A row set
 * @param instance - The instance it must be of
 * @returns The same id
 * @throws TypeError When the id is another instance's
 */
function idOfInstance<Instance extends RowSetInstanceId>(id: RowSetId, instance: Instance): RowSetIdOf<Instance> {
  if (id.instance !== instance) throw new TypeError(`The ${instance} instance was handed a ${id.instance} row set.`);
  return id as RowSetIdOf<Instance>;
}

/** @returns Every table of one instance, in registry order */
function tablesOf(instance: RowSetInstanceId): RowSetTableName[] {
  return storedRelationSpecs().filter(isRowSetTable).filter((spec) => spec.instance === instance).map((spec) => spec.key);
}

/** The `data` instance: JSON, JSONC, YAML, `.npmrc` and `.yarnrc.yml` files. */
const DATA_DESCRIPTOR: RowSetInstanceDescriptor = {
  instance: DATA_INSTANCE,
  head: rowSetHeadTableOf(DATA_INSTANCE),
  tables: tablesOf(DATA_INSTANCE),
  routesRelation: DERIVED_TABLES.dataRoutes.name,
  noRows: { code: 'DATA_FILE_NO_ROWS', answering: 'Every data__* relation', routeAway: 'route it away with resources.extractors.data.exclude' },
  gitContentOnly: false,
  variantOf: (path, routings) => dataRouteFor(path, routings.data),
  extract: async (extractor, id, content) => {
    const answer = await extractor.dataRows(idOfInstance(id, DATA_INSTANCE).variant, content);
    if (answer.outcome === 'defect') return answer;
    const { files, documents, nodes, conditions } = answer.rows;
    return { outcome: 'rows', bytes: answer.bytes, tables: { dataFiles: files, dataDocuments: documents, dataNodes: nodes, dataConditions: conditions } };
  },
};

/** The `ts` instance: TypeScript and JavaScript files, git content only. */
const TS_DESCRIPTOR: RowSetInstanceDescriptor = {
  instance: TS_INSTANCE,
  head: rowSetHeadTableOf(TS_INSTANCE),
  tables: tablesOf(TS_INSTANCE),
  routesRelation: DERIVED_TABLES.tsRoutes.name,
  noRows: { code: 'TS_FILE_NO_ROWS', answering: 'Every ts__* relation and ts_imports', routeAway: 'route it away with resources.extractors.ts.exclude' },
  gitContentOnly: true,
  variantOf: (path, routings) => {
    const decision = tsRouteDecision(path, routings.ts);
    return 'variant' in decision ? decision.variant : undefined;
  },
  extract: async (extractor, id, content) => {
    const answer = await extractor.tsRows(idOfInstance(id, TS_INSTANCE).variant, content);
    if (answer.outcome === 'defect') return answer;
    const { files, imports, importNames, exports } = answer.rows;
    return { outcome: 'rows', bytes: answer.bytes, tables: { tsFiles: files, tsImports: imports, tsImportNames: importNames, tsExports: exports } };
  },
};

/** Every row-set instance, in registry order. */
export const ROW_SET_INSTANCES: readonly RowSetInstanceDescriptor[] = [DATA_DESCRIPTOR, TS_DESCRIPTOR];

/**
 * One instance's descriptor.
 *
 * @param instance - The instance
 * @returns Its descriptor
 */
export function rowSetInstance(instance: RowSetInstanceId): RowSetInstanceDescriptor {
  const descriptor = ROW_SET_INSTANCES.find((candidate) => candidate.instance === instance);
  if (descriptor === undefined) throw new TypeError(`No row-set instance ${instance} is described.`);
  return descriptor;
}

/**
 * The row sets some head rows name, every instance's, in instance order then row order.
 *
 * @param heads - Head rows; a head table that is absent holds none
 * @returns Their ids
 */
export function headIdsOf(heads: Partial<Pick<RowSetRows, RowSetHeadTableName>>): RowSetId[] {
  return ROW_SET_INSTANCES.flatMap((descriptor) => (heads[descriptor.head] ?? []).map((row) => rowSetIdOf(row.blob, descriptor.instance, row.variant)));
}
