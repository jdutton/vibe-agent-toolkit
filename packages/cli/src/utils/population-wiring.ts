/**
 * The three arguments every CLI lane hands a projection population builder the
 * same way: the blob-stage observer, the ignore oracle, and the run's store.
 *
 * ## Why this is CLI code and not `resources` code
 *
 * Nothing here decides anything about a projection. The observer's whole body is
 * `describeBlobRefusals` — owned by `@vibe-agent-toolkit/resources` — routed to a
 * {@link Logger}, which is a CLI type no other package has; the two spreads exist
 * only because `exactOptionalPropertyTypes` makes "absent" and "present and
 * undefined" different arguments. That is command plumbing, in the same family as
 * `projection-store.ts` next door, so it stays inside the package the CLI-stays-
 * dumb rule allows it in.
 *
 * ## The observer is the reason this is shared rather than retyped
 *
 * `buildInventoryPopulation` and `buildClaudeContextPopulation` both REQUIRE
 * `onBlobPopulation` — a caller with nothing to do with the counts must name
 * `DISCARD_BLOB_POPULATION` rather than leave it off — because a tree whose every
 * document was declined as binary otherwise populates as empty and reports
 * success. Two hand-written copies of the reporting half is two places for that
 * report to quietly become a no-op.
 */

import {
  describeBlobRefusals,
  type BlobPopulationReport,
  type CollectionConfig,
  type PopulationCache,
} from '@vibe-agent-toolkit/resources';
import type { GitTracker } from '@vibe-agent-toolkit/utils/git';

import { loadConfigCached } from './config-loader.js';
import type { Logger } from './logger.js';

/**
 * The population arguments {@link populationWiring} supplies.
 *
 * Spread into a builder's options object, so the three optional inputs are
 * optional in the `exactOptionalPropertyTypes` sense — omitted entirely when
 * they are absent, never present-and-undefined.
 */
export interface PopulationWiring {
  onBlobPopulation: (report: BlobPopulationReport) => void;
  gitTracker?: GitTracker | undefined;
  cache?: PopulationCache | undefined;
  collections?: Readonly<Record<string, CollectionConfig>> | undefined;
}

/**
 * Wire one population's blob-stage observer, ignore oracle and store.
 *
 * `describeBlobRefusals` returns undefined on a run that refused nothing, so a
 * clean population stays exactly as quiet as it was — which is the only thing
 * that keeps the line worth reading when it does appear.
 *
 * ⚠️ The refusals go to `logger.warn`, i.e. **stderr**. Both callers write a
 * parseable document to stdout, and a diagnostic in the middle of it breaks every
 * consumer.
 *
 * @param logger - Where blob-stage refusals are reported
 * @param gitTracker - The ignore oracle, or undefined when there is none. Not
 *   cosmetic: `resource_realizations.gitignored` is filled only when a tracker
 *   was supplied, so its absence decides whether a consumer can TELL which
 *   members were ignored
 * @param cache - The run's projection store, or undefined to re-derive
 * @param root - The project root, from which the run's declared `mimeType`
 *   routing is READ rather than passed. See {@link collectionsOption}
 * @returns The options to spread into the population builder's argument
 */
export function populationWiring(
  logger: Logger,
  gitTracker: GitTracker | undefined,
  cache: PopulationCache | undefined,
  root: string,
): PopulationWiring {
  return {
    onBlobPopulation: (report) => {
      const refusals = describeBlobRefusals(report);
      if (refusals !== undefined) logger.warn(refusals);
    },
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
  const collections = loadConfigCached(root)?.resources?.collections;
  return collections === undefined ? {} : { collections };
}
