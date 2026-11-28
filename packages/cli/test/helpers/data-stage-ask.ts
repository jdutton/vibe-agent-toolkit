/**
 * The query lane over an in-memory projection whose realizations the row-set instances route:
 * `askPopulatedProjection` in process, store off. Shared by the unit and integration tiers.
 */

import {
  isProjectionTable,
  NO_GIT_MEMBERS,
  storedRelationSpecs,
  withPopulationRun,
  type ContentState,
  type Projection,
  type QueryProjection,
} from '@vibe-agent-toolkit/resources';
import { queryProjectionOf } from '@vibe-agent-toolkit/resources/testing';

import { createLogger } from '../../src/utils/logger.js';
import { askPopulatedProjection } from '../../src/utils/projection-query.js';

/** The paths a fixture realizes, with the state the population left each in. Every one unkeyed; an unreadable one was found gone. */
export type Realized = ReadonlyArray<readonly [path: string, state: ContentState]>;

/** A projection with one root at `root` and the given unkeyed realizations. */
function projectionOf(root: string, realized: Realized): QueryProjection {
  const tables = Object.fromEntries(storedRelationSpecs().filter(isProjectionTable).map((spec) => [spec.key, []]));
  return queryProjectionOf({
    ...tables,
    roots: [{ id: 'root-1', path: root }],
    resolutionContexts: [{ contextId: 'extent-1', species: 'extent', kind: 'tree', rootId: 'root-1', extentContextId: null, role: 'primary' }],
    resourceRealizations: realized.map(([path, contentState]) => ({
      extentId: 'extent-1', path, contentState, contentKey: null, contentFaultClass: contentState === 'unreadable' ? 'absent' : null, mime: 'application/json',
    })),
  } as unknown as Projection);
}

/**
 * Run `work` over `realized` with `statements` declared, store off, as the lane's first attempt.
 *
 * @param options - The run
 * @param options.root - The corpus root, whose config routes the instance
 * @param options.realized - The realizations
 * @param options.statements - Every statement the run may ask
 * @param work - The caller's work
 * @returns What `work` returns
 */
export function askOverRealized<T>(
  options: { readonly root: string; readonly realized: Realized; readonly statements: readonly string[] },
  work: Parameters<typeof askPopulatedProjection<T>>[1],
): Promise<T> {
  return withPopulationRun(NO_GIT_MEMBERS, (populationRun) => askPopulatedProjection(
    {
      projection: projectionOf(options.root, options.realized),
      blobReferences: { rows: [] },
      outcome: { population: 'derived' },
      root: options.root,
      logger: createLogger(),
      statements: options.statements,
      base: undefined,
      cache: undefined,
      populationRun,
      populationStart: performance.now(),
      attempt: 1,
    },
    work,
  ));
}
