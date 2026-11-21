/**
 * The run seams a test supplies: a {@link PopulationRun} for a population lane,
 * and a {@link RunPopulation} whose `source` a registry crawl enumerates through.
 *
 * Every population reads and parses through a run, and every registry crawl is
 * enumerated by a population source. A test whose population or crawl is its
 * run's only lane opens a run of its own around that one call, and the run is
 * shut down (its dispatcher with it) as soon as the call returns.
 *
 * ⚠️ One run per call, never one per file: a run's content cache keeps the first
 * read of each file for the run's whole life, so a test that edits a file
 * between two populations would be served the stale bytes from a shared run.
 */

import { GitTracker } from '@vibe-agent-toolkit/utils/git';

import { IGNORE_HOME_SETTLEMENT, type PopulationRun, type RunPopulation, withPopulationRun, withRunPopulation } from '../../src/projection/run-population.js';
import { type CrawlOptions, type RegistryCrawl, ResourceRegistry, type ResourceRegistryOptions } from '../../src/resource-registry.js';
import type { CollectionConfig } from '../../src/schemas/project-config.js';

/**
 * Run one population lane (`populate`, `buildResourcePopulation`,
 * `buildResourceProjection`, `buildClaudeContextPopulation`) under a run of its own.
 *
 * @param lane - The population entry point
 * @param options - Its options, all but `run`
 * @returns What the lane returned
 */
export function inOwnRun<P extends { run: PopulationRun }, R>(
  lane: (options: P) => Promise<R>,
  options: Omit<P, 'run'>,
): Promise<R> {
  return withPopulationRun((run) => lane({ ...options, run } as P));
}

/** What a test run population is built over, past its root. */
export interface TestPopulationOptions {
  /** The root's `resources.collections`, so a declared `mimeType` routes its files. */
  readonly collections?: Readonly<Record<string, CollectionConfig>>;
}

/**
 * Run `work` with a run population homed at `root`: the root's own ignore
 * oracle, no projection store.
 *
 * @param root - The run's home root
 * @param work - The run
 * @param options - The root's collections, if any
 * @returns Whatever `work` returned
 */
export function withTestPopulation<R>(
  root: string,
  work: (population: RunPopulation) => Promise<R>,
  options: TestPopulationOptions = {},
): Promise<R> {
  return withRunPopulation(
    {
      root,
      gitTracker: new GitTracker(root),
      cacheOf: () => Promise.resolve(undefined),
      collectionsFor: () => Promise.resolve(options.collections),
      onHomeSettled: IGNORE_HOME_SETTLEMENT,
    },
    work,
  );
}

/**
 * Crawl `registry` through a run population of its own, homed at the crawl's base.
 *
 * @param registry - The registry to crawl into
 * @param options - The crawl, all but its population source
 * @returns The crawl's resources and population
 */
export function crawlInRun(registry: ResourceRegistry, options: Omit<CrawlOptions, 'populationSource'>): Promise<RegistryCrawl> {
  return withTestPopulation(options.baseDir, (population) =>
    registry.crawl({ ...options, populationSource: population.source }),
  );
}

/**
 * `ResourceRegistry.fromCrawl` through a run population of its own, homed at the crawl's base.
 *
 * @param options - The crawl, all but its population source
 * @param registryOptions - The new registry's options, past its base
 * @returns The new registry and its crawl
 */
export function fromCrawlInRun(
  options: Omit<CrawlOptions, 'populationSource'>,
  registryOptions?: Omit<ResourceRegistryOptions, 'baseDir'>,
): Promise<RegistryCrawl & { readonly registry: ResourceRegistry }> {
  return withTestPopulation(options.baseDir, (population) =>
    ResourceRegistry.fromCrawl({ ...options, populationSource: population.source }, registryOptions),
  );
}
