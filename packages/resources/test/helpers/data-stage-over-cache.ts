/**
 * The data stage run over real realizations and a run's content cache: one root, one extent, the
 * default routing, store off, no seams. What a test that seeds a fault in the population and reads
 * the stage's answer for it shares.
 */

import type { RunContentCache } from '../../src/projection/content-cache.js';
import {
  dataStageContentOf,
  NO_DATA_STAGE_SEAMS,
  runDataStage,
  type DataDemand,
  type DataStageInput,
  type DataStageProjection,
  type DataStageResult,
} from '../../src/projection/data-stage.js';
import { dataRoutingFor } from '../../src/projection/router.js';
import type { ResourceRealizationRow } from '../../src/schemas/projection-resources.js';

/**
 * Run the data stage over `realizations`, each in the extent `extent-1` under `root`.
 *
 * @param input - The root, its realizations, the run's cache, the demand and the extractor
 * @returns The stage's answer
 */
export function dataStageOverCache(input: {
  readonly root: string;
  readonly realizations: readonly ResourceRealizationRow[];
  readonly cache: RunContentCache;
  readonly demand: DataDemand;
  readonly extractor: DataStageInput['extractor'];
}): Promise<DataStageResult> {
  return runDataStage({
    demand: input.demand,
    projection: {
      roots: [{ id: 'root-1', path: input.root }],
      resolutionContexts: [{ contextId: 'extent-1', species: 'extent', kind: 'tree', rootId: 'root-1', extentContextId: null, role: 'primary' }],
      resourceRealizations: input.realizations,
    } as unknown as DataStageProjection,
    routing: dataRoutingFor(undefined),
    content: dataStageContentOf(input.cache),
    extractor: input.extractor,
    store: undefined,
    seams: NO_DATA_STAGE_SEAMS,
  });
}
