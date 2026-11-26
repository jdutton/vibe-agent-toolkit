/**
 * One population of a tree through the filesystem extent alone, and the key a projection files a
 * path under: the two steps the store-reuse integration suites share.
 */

import type { ContentKey } from '../../src/content-key.js';
import { ContributorRegistry } from '../../src/projection/contributor.js';
import { DEFAULT_CONTENT_DEMAND, FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../../src/projection/crawl-source.js';
import { populate, type PopulationCache, type PopulationOutcome } from '../../src/projection/merge.js';
import type { Projection } from '../../src/projection/projection.js';
import type { CollectionConfig } from '../../src/schemas/project-config.js';

import { inOwnRun } from './population-run.js';

/**
 * Populate `root` with the filesystem extent, through `cache` or store-off.
 *
 * @param root - The committed tree to populate
 * @param cache - The store and tree key to run through, or undefined for a store-off run
 * @param collections - Collections to declare, if any
 * @returns The run's projection and outcome
 */
export function populateFilesystemExtent(
  root: string,
  cache: PopulationCache | undefined,
  collections?: Readonly<Record<string, CollectionConfig>>,
): Promise<{ readonly projection: Projection; readonly outcome: PopulationOutcome }> {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor((at) => crawlSourceFor(at, []), DEFAULT_CONTENT_DEMAND));
  return inOwnRun(populate, {
    root,
    registry,
    ...(cache !== undefined && { cache }),
    ...(collections !== undefined && { collections }),
  });
}

/**
 * The content key a projection files `path` under, from its keyed realization.
 *
 * @param projection - The projection to look in
 * @param path - A root-relative path
 * @returns The path's content key
 * @throws When the projection has no keyed realization at `path`
 */
export function keyedContentKeyOf(projection: Projection, path: string): ContentKey {
  const row = projection.resourceRealizations.find((realization) => realization.path === path && realization.contentState === 'keyed');
  if (row?.contentKey === undefined || row.contentKey === null) throw new Error(`${path} is not keyed in the projection`);
  return row.contentKey;
}
