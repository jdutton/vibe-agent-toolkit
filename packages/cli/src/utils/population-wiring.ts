/**
 * The one entry by which a CLI lane populates a tree from its rows: it hands the
 * builder the ignore oracle, the run's store and the declared collections the
 * same way every time, and reports what the population refused. The report is
 * inside the only exported entry, so a lane cannot build a population it forgets
 * to report.
 *
 * ## Why this is CLI code and not `resources` code
 *
 * Nothing here decides anything about a projection. The report's whole body is
 * `describeBlobRefusals` — owned by `@vibe-agent-toolkit/resources` — routed to
 * a {@link Logger}, which is a CLI type no other package has; the
 * spreads exist only because `exactOptionalPropertyTypes` makes "absent" and
 * "present and undefined" different arguments. That is command plumbing, in the
 * same family as `projection-store.ts` next door.
 *
 * ## Why the report reads the projection, not the run
 *
 * A store hit derives nothing. A report built from what this process derived
 * vanished on the warm run, so `vat resources check` was silent about a binary
 * `vat resources validate` had just stored a refusal for.
 */

import {
  describeBlobRefusals,
  describeStoreMiss,
  type BlobRefusalRows,
  type CollectionConfig,
  type PopulationCache,
  type StoreMiss,
} from '@vibe-agent-toolkit/resources';
import type { GitTracker } from '@vibe-agent-toolkit/utils/git';

import { gitTrackerForProjectRoot } from '../commands/audit/distributed-tree.js';

import { loadConfigCached } from './config-loader.js';
import type { Logger } from './logger.js';

/**
 * The population arguments {@link populateAndReport} supplies.
 *
 * Spread into a builder's options object, so the three optional inputs are
 * optional in the `exactOptionalPropertyTypes` sense — omitted entirely when
 * they are absent, never present-and-undefined.
 */
export interface PopulationWiring {
  gitTracker?: GitTracker | undefined;
  cache?: PopulationCache | undefined;
  collections?: Readonly<Record<string, CollectionConfig>> | undefined;
}

/**
 * Populate one tree through `build`, then report its refused content to
 * **stderr** (callers write a parseable document to stdout), named by
 * `population` because one command can build two — the resources lane and the
 * claude-context lens.
 *
 * @param options - The run: `root`, `cache`, `logger`, and the `population` name
 * @param build - Builds the population from the wiring this entry supplies
 * @param refusalRowsOf - The rows the report reads, from a derive or a hit alike
 * @param storeMissOf - The store miss a refusal caused the run, if one did —
 *   reported beside the refusals, because a persisting refusal makes every run
 *   re-derive the whole population and that cost is allowed only named (ADR I10)
 * @returns Whatever `build` returned
 */
export async function populateAndReport<R>(
  options: { root: string; cache: PopulationCache | undefined; logger: Logger; population: string },
  build: (wiring: PopulationWiring) => Promise<R>,
  refusalRowsOf: (result: R) => BlobRefusalRows,
  storeMissOf: (result: R) => StoreMiss | undefined,
): Promise<R> {
  const { root, cache, logger, population } = options;
  const gitTracker = await gitTrackerForProjectRoot(root);
  const result = await build(populationWiring(gitTracker, cache, root));
  const refusals = describeBlobRefusals(refusalRowsOf(result));
  if (refusals !== undefined) logger.warn(`${population} population: ${refusals}`);
  const storeMiss = describeStoreMiss(storeMissOf(result));
  if (storeMiss !== undefined) logger.warn(`${population} population: ${storeMiss}`);
  return result;
}

/**
 * Wire one population's ignore oracle, store and declared collections.
 *
 * @param gitTracker - The ignore oracle, or undefined when there is none. Not
 *   cosmetic: `resource_realizations.gitignored` is filled only when a tracker
 *   was supplied, so its absence decides whether a consumer can TELL which
 *   members were ignored
 * @param cache - The run's projection store, or undefined to re-derive
 * @param root - The project root, from which the run's declared `mimeType`
 *   routing is READ rather than passed. See {@link collectionsOption}
 * @returns The options to spread into the population builder's argument
 */
function populationWiring(
  gitTracker: GitTracker | undefined,
  cache: PopulationCache | undefined,
  root: string,
): PopulationWiring {
  return {
    ...(gitTracker !== undefined && { gitTracker }),
    ...(cache !== undefined && { cache }),
    ...collectionsOption(root),
  };
}

/**
 * The project's collection declarations at `root`, or undefined for a project
 * that declares none.
 *
 * ## Why this is READ here and not passed in
 *
 * A declared `mimeType` changes which parser runs, which changes the content
 * key, which is folded into the projection store's key through the routing's
 * fingerprint. So two lanes of ONE command that disagree about whether to supply
 * the declarations do not merely disagree about parsing — they **evict each
 * other's stored extents over an unchanged tree, run after run.**
 *
 * Taking a `root` and reading the config here rather than accepting a
 * `collections` argument is what makes that disagreement unrepresentable: there
 * is one answer per root and every lane that goes through this helper gets it.
 * An optional argument would have been a thing three call sites could each
 * forget, and forgetting is silent — a cache that never hits looks exactly like
 * a cache that is merely cold.
 *
 * `loadConfigCached` is keyed on the root, so the repeat calls across a
 * command's lanes cost one parse between them. A broken config throws here, as
 * it does everywhere else — a population silently typed by the built-in tables
 * because the config would not parse is the conflation
 * {@link loadConfigCached} exists to refuse.
 *
 * Returned as a SPREADABLE rather than a value: `exactOptionalPropertyTypes`
 * makes an absent key and one holding `undefined` different arguments, and the
 * population builders declare `collections` optional. Every caller spreads this,
 * so no call site writes its own `!== undefined &&` and none can get the two
 * states the wrong way round.
 *
 * @param root - The project root whose config declares the collections
 * @returns `{ collections }`, or `{}` when there is no config or no
 *   `resources.collections` in it
 */
export function collectionsOption(
  root: string,
): { collections?: Readonly<Record<string, CollectionConfig>> } {
  const collections = loadConfigCached(root, 'source')?.resources?.collections;
  return collections === undefined ? {} : { collections };
}
