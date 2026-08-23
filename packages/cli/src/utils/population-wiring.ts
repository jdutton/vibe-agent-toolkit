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

import { describeBlobRefusals, type BlobPopulationReport, type PopulationCache }
  from '@vibe-agent-toolkit/resources';
import type { GitTracker } from '@vibe-agent-toolkit/utils';

import type { Logger } from './logger.js';

/**
 * The population arguments {@link populationWiring} supplies.
 *
 * Spread into a builder's options object, so the two oracles are optional in the
 * `exactOptionalPropertyTypes` sense — omitted entirely when they are absent,
 * never present-and-undefined.
 */
export interface PopulationWiring {
  onBlobPopulation: (report: BlobPopulationReport) => void;
  gitTracker?: GitTracker | undefined;
  cache?: PopulationCache | undefined;
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
 * @returns The options to spread into the population builder's argument
 */
export function populationWiring(
  logger: Logger,
  gitTracker: GitTracker | undefined,
  cache: PopulationCache | undefined,
): PopulationWiring {
  return {
    onBlobPopulation: (report) => {
      const refusals = describeBlobRefusals(report);
      if (refusals !== undefined) logger.warn(refusals);
    },
    ...(gitTracker !== undefined && { gitTracker }),
    ...(cache !== undefined && { cache }),
  };
}
