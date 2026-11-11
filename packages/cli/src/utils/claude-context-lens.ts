/**
 * Evaluating the always-loaded context chain over a tree, so SQL can ask what
 * the harness loads where.
 *
 * 🚨 **This lens POPULATES. It is the only one that does, and that is the whole
 * reason lens evaluation had to become lazy.** Its relations cannot be derived
 * from the projection the query lane already holds, so it runs the real lane —
 * a second population, which is why `projection-lenses.ts` evaluates a lens only
 * when a statement names its relations. Why that is not a choice, and why the
 * second population is a store hit rather than a competitor for the resources
 * lane's entry: `docs/architecture/zones.md` §2, "The claude-context lens
 * POPULATES".
 */

import {
  buildClaudeContextPopulation,
  claudeContextRelations,
  type ClaudeContextRelations,
  type PopulationCache,
  type PopulationOutcome,
} from '@vibe-agent-toolkit/resources';

import type { Logger } from './logger.js';
import { populateAndReport } from './population-wiring.js';

/**
 * Populate the Claude-context lane and flatten its chains into the two
 * relations.
 *
 * Reports its own population's refused content: an `@`-import chain can reach
 * files the query lane's resources population never holds.
 *
 * @param options - The run
 * @param options.root - Absolute corpus root. Rooted HERE and nowhere else: a
 *   chain is a property of a position in the tree, and a population rooted at a
 *   subdirectory computes one against a corpus whose ancestors are missing
 * @param options.cache - The run's projection store, or undefined to re-derive
 * @param options.logger - Where the lens population's refused content is reported
 * @returns The rows, ready for `writeDerived`, and the lens population's
 *   provenance as the population publishes it (`'store'` only when the root
 *   list AND the real pass were both served from the store)
 */
export async function evaluateClaudeContextLens(options: {
  root: string;
  cache: PopulationCache | undefined;
  logger: Logger;
}): Promise<{ rows: ClaudeContextRelations; population: PopulationOutcome['population'] }> {
  const { root, cache, logger } = options;
  const { projection, population } = await populateAndReport(
    { root, cache, logger, population: 'claude-context' },
    (wiring) => buildClaudeContextPopulation({ root, ...wiring }),
    (result) => result.projection,
    (result) => result.storeMiss,
  );
  return { rows: claudeContextRelations(projection), population };
}
